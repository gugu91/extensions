import * as net from "node:net";
import {
  inspectBrokerLock,
  type BrokerLockInspection,
  type BrokerLockOwner,
  type BrokerLockProbes,
} from "./leader.js";
import { getDefaultSocketPath } from "./paths.js";
import type { ListenTarget } from "./socket-server.js";
import { RPC_METHOD_NOT_FOUND } from "./types.js";

// ─── Constants ───────────────────────────────────────────

export const DEFAULT_PROBE_TIMEOUT_MS = 2000;
export const DEFAULT_SHUTDOWN_RPC_TIMEOUT_MS = 5000;
export const DEFAULT_GRACEFUL_WAIT_MS = 8000;
export const DEFAULT_TERMINATE_WAIT_MS = 8000;
export const DEFAULT_REPLACE_POLL_INTERVAL_MS = 250;

// ─── One-shot JSON-RPC client ────────────────────────────

type BrokerSocketFailureKind = "unreachable" | "unresponsive";

class BrokerSocketFailure extends Error {
  readonly kind: BrokerSocketFailureKind;

  constructor(kind: BrokerSocketFailureKind, message: string) {
    super(message);
    this.name = "BrokerSocketFailure";
    this.kind = kind;
  }
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
}

/** The lock-conflict RPCs only need success/error — result payloads are unused. */
interface RpcResponseEnvelope {
  error: JsonRpcErrorShape | null;
}

/** Serialized wire shape of a JSON-RPC response line — field types unverified. */
interface RawJsonRpcResponse {
  id?: number | string | null;
  error?: { code?: number; message?: string } | null;
}

/**
 * Minimal sequential JSON-RPC client used for lock-conflict diagnostics.
 * Deliberately independent from the full follower client: no reconnects, no
 * heartbeats — one bounded connection for probe/shutdown calls.
 */
class OneShotBrokerRpcClient {
  private readonly socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private waiter: {
    id: number;
    resolve: (response: RpcResponseEnvelope) => void;
    reject: (error: Error) => void;
  } | null = null;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line && this.waiter) {
          let raw: RawJsonRpcResponse | null = null;
          try {
            const parsed = JSON.parse(line) as RawJsonRpcResponse | null;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              raw = parsed;
            }
          } catch {
            raw = null;
          }
          if (raw && raw.id === this.waiter.id) {
            const rawError = raw.error;
            const response: RpcResponseEnvelope = {
              error:
                rawError && typeof rawError === "object" && typeof rawError.code === "number"
                  ? {
                      code: rawError.code,
                      message: typeof rawError.message === "string" ? rawError.message : "",
                    }
                  : null,
            };
            const { resolve } = this.waiter;
            this.waiter = null;
            resolve(response);
          }
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });
    const failPending = (kind: BrokerSocketFailureKind, message: string): void => {
      if (!this.waiter) return;
      const { reject } = this.waiter;
      this.waiter = null;
      reject(new BrokerSocketFailure(kind, message));
    };
    socket.on("error", (err: Error) => failPending("unreachable", err.message));
    socket.on("close", () =>
      failPending("unresponsive", "Broker socket closed before responding."),
    );
  }

  static connect(target: ListenTarget, timeoutMs: number): Promise<OneShotBrokerRpcClient> {
    return new Promise<OneShotBrokerRpcClient>((resolve, reject) => {
      const socket =
        target.type === "unix"
          ? net.createConnection({ path: target.path })
          : net.createConnection({ port: target.port, host: target.host });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new BrokerSocketFailure(
            "unresponsive",
            `Broker socket connect timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new OneShotBrokerRpcClient(socket));
      });
      socket.once("error", (err: Error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new BrokerSocketFailure("unreachable", err.message));
      });
    });
  }

  call(
    method: string,
    params: Record<string, string>,
    timeoutMs: number,
  ): Promise<RpcResponseEnvelope> {
    const id = this.nextId++;
    return new Promise<RpcResponseEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.id === id) this.waiter = null;
        reject(
          new BrokerSocketFailure(
            "unresponsive",
            `Broker did not respond to ${method} within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.waiter = {
        id,
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      try {
        this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.waiter = null;
        reject(
          new BrokerSocketFailure("unreachable", err instanceof Error ? err.message : String(err)),
        );
      }
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

// ─── Socket probe ────────────────────────────────────────

export type BrokerSocketProbeResult = "healthy" | "unreachable" | "unresponsive";

export interface ProbeBrokerSocketOptions {
  target?: ListenTarget;
  socketPath?: string;
  timeoutMs?: number;
}

function resolveTarget(options: { target?: ListenTarget; socketPath?: string }): ListenTarget {
  if (options.target) return options.target;
  return { type: "unix", path: options.socketPath ?? getDefaultSocketPath() };
}

function failureToProbeResult(err: BrokerSocketFailure | Error): BrokerSocketProbeResult {
  return err instanceof BrokerSocketFailure && err.kind === "unreachable"
    ? "unreachable"
    : "unresponsive";
}

/**
 * Bounded liveness probe for a broker socket. Any well-formed JSON-RPC
 * response — including an auth error — proves the broker event loop is
 * serving, so it classifies as healthy.
 */
export async function probeBrokerSocket(
  options: ProbeBrokerSocketOptions = {},
): Promise<BrokerSocketProbeResult> {
  const target = resolveTarget(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  let client: OneShotBrokerRpcClient;
  try {
    client = await OneShotBrokerRpcClient.connect(target, timeoutMs);
  } catch (err) {
    return failureToProbeResult(err instanceof Error ? err : new Error(String(err)));
  }
  try {
    await client.call("auth", {}, timeoutMs);
    return "healthy";
  } catch (err) {
    return failureToProbeResult(err instanceof Error ? err : new Error(String(err)));
  } finally {
    client.close();
  }
}

// ─── Graceful shutdown request ───────────────────────────

export type BrokerShutdownRequestResult =
  | "accepted"
  /** The broker responded with method-not-found — it predates the RPC. */
  | "unsupported"
  /** The broker responded with an error (e.g. auth rejection) — it is alive and refusing. */
  | "rejected"
  | "unreachable"
  /** Connected but no usable response — the broker looks hung. */
  | "failed";

export interface RequestBrokerShutdownOptions {
  target?: ListenTarget;
  socketPath?: string;
  meshSecret?: string | null;
  timeoutMs?: number;
}

/**
 * Ask a running broker to shut down gracefully via the authenticated
 * `admin.shutdown` RPC. Brokers that predate the RPC report `unsupported`.
 */
export async function requestBrokerShutdown(
  options: RequestBrokerShutdownOptions = {},
): Promise<BrokerShutdownRequestResult> {
  const target = resolveTarget(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_RPC_TIMEOUT_MS;
  let client: OneShotBrokerRpcClient;
  try {
    client = await OneShotBrokerRpcClient.connect(target, timeoutMs);
  } catch (err) {
    return err instanceof BrokerSocketFailure && err.kind === "unreachable"
      ? "unreachable"
      : "failed";
  }
  try {
    const secret = options.meshSecret?.trim();
    const authResponse = await client.call("auth", secret ? { secret } : {}, timeoutMs);
    if (authResponse.error) return "rejected";

    const shutdownResponse = await client.call("admin.shutdown", {}, timeoutMs);
    if (shutdownResponse.error) {
      return shutdownResponse.error.code === RPC_METHOD_NOT_FOUND ? "unsupported" : "rejected";
    }
    return "accepted";
  } catch {
    return "failed";
  } finally {
    client.close();
  }
}

// ─── Conflict classification ─────────────────────────────

export type BrokerLockConflictClassification = "active-broker" | "unresponsive-broker";

export type BrokerLockConflict =
  | { kind: "reclaimable"; inspection: BrokerLockInspection; probe: null }
  | {
      kind: "conflict";
      classification: BrokerLockConflictClassification;
      owner: BrokerLockOwner;
      probe: BrokerSocketProbeResult;
    };

export interface ClassifyBrokerLockConflictOptions {
  lockPath?: string;
  target?: ListenTarget;
  socketPath?: string;
  probeTimeoutMs?: number;
  probes?: BrokerLockProbes;
  probeSocket?: (target: ListenTarget, timeoutMs: number) => Promise<BrokerSocketProbeResult>;
}

/**
 * Combine lock-owner inspection with a bounded socket probe to classify a
 * leader-lock conflict.
 */
export async function classifyBrokerLockConflict(
  options: ClassifyBrokerLockConflictOptions = {},
): Promise<BrokerLockConflict> {
  const inspection = inspectBrokerLock(options.lockPath, options.probes ?? {});
  if (inspection.state !== "alive") {
    return { kind: "reclaimable", inspection, probe: null };
  }
  const target = resolveTarget(options);
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probe = options.probeSocket
    ? await options.probeSocket(target, timeoutMs)
    : await probeBrokerSocket({ target, timeoutMs });
  return {
    kind: "conflict",
    classification: probe === "healthy" ? "active-broker" : "unresponsive-broker",
    owner: inspection.owner,
    probe,
  };
}

// ─── Typed conflict error ────────────────────────────────

export interface BrokerLockConflictErrorInput {
  classification: BrokerLockConflictClassification;
  owner: BrokerLockOwner | null;
  probe: BrokerSocketProbeResult | null;
}

export function formatBrokerLockConflictMessage(input: BrokerLockConflictErrorInput): string {
  const owner = input.owner;
  const ownerBits = owner
    ? ` (pid ${owner.pid}${owner.createdAt ? `, lock created ${owner.createdAt}` : ""})`
    : "";
  if (input.classification === "active-broker") {
    return (
      `Another pinet broker is already running${ownerBits} and its socket is responding. ` +
      `Use /pinet follow to join it, or /pinet start replace to take over.`
    );
  }
  const socketState = input.probe === "unreachable" ? "not reachable" : "not responding";
  return (
    `Another process holds the pinet broker lock${ownerBits} but the broker socket is ` +
    `${socketState} — the broker looks stranded. Use /pinet start replace to recover.`
  );
}

/**
 * Thrown by `startBroker` when the leader lock is held by another live
 * process, carrying enough context for callers to present a per-state
 * recovery path instead of a generic failure.
 */
export class BrokerLockConflictError extends Error {
  readonly classification: BrokerLockConflictClassification;
  readonly owner: BrokerLockOwner | null;
  readonly probe: BrokerSocketProbeResult | null;

  constructor(input: BrokerLockConflictErrorInput) {
    super(formatBrokerLockConflictMessage(input));
    this.name = "BrokerLockConflictError";
    this.classification = input.classification;
    this.owner = input.owner;
    this.probe = input.probe;
  }
}

// ─── Conservative takeover ───────────────────────────────

export type ReplaceBrokerOwnerOutcome =
  | "no-conflict"
  | "replaced-graceful"
  | "replaced-terminated"
  | "owner-changed"
  | "failed";

export interface ReplaceBrokerOwnerResult {
  outcome: ReplaceBrokerOwnerOutcome;
  owner: BrokerLockOwner | null;
  steps: string[];
  error: string | null;
}

export interface ReplaceBrokerOwnerOptions {
  lockPath?: string;
  target?: ListenTarget;
  socketPath?: string;
  meshSecret?: string | null;
  gracefulWaitMs?: number;
  terminateWaitMs?: number;
  pollIntervalMs?: number;
  shutdownRpcTimeoutMs?: number;
  probes?: BrokerLockProbes;
  requestShutdown?: (options: RequestBrokerShutdownOptions) => Promise<BrokerShutdownRequestResult>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Conservatively replace the current broker lock owner:
 *
 * 1. No live owner → nothing to do (a normal start reclaims stale state).
 * 2. Live owner → request graceful `admin.shutdown` and wait (bounded).
 * 3. Fallback → re-verify the owner fence (pid + process start time +
 *    instance id), SIGTERM the verified owner, and wait (bounded).
 * 4. Never SIGKILL; abort if the owner identity changes mid-flight.
 */
export async function replaceBrokerOwner(
  options: ReplaceBrokerOwnerOptions = {},
): Promise<ReplaceBrokerOwnerResult> {
  const steps: string[] = [];
  const probes = options.probes ?? {};
  const inspect = (): BrokerLockInspection => inspectBrokerLock(options.lockPath, probes);
  // Deliberately not unref'd: the poll loop must keep the event loop alive
  // until replacement resolves (caught by the cross-process E2E run).
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const kill =
    options.kill ??
    ((pid: number, signal: NodeJS.Signals): void => {
      process.kill(pid, signal);
    });
  const requestShutdown = options.requestShutdown ?? requestBrokerShutdown;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_REPLACE_POLL_INTERVAL_MS;
  const gracefulWaitMs = options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS;
  const terminateWaitMs = options.terminateWaitMs ?? DEFAULT_TERMINATE_WAIT_MS;

  const initial = inspect();
  if (initial.state !== "alive") {
    steps.push(`Lock state: ${initial.state} — nothing to replace; a normal start reclaims it.`);
    return { outcome: "no-conflict", owner: initial.owner ?? null, steps, error: null };
  }
  const owner = initial.owner;
  if (owner.pid === process.pid) {
    // Never signal ourselves: a same-process conflict means this session
    // already hosts the broker (or another runtime within it does).
    steps.push(`Lock is held by this session's own process (pid ${owner.pid}).`);
    return {
      outcome: "failed",
      owner,
      steps,
      error:
        "The broker lock is held by this session's own process — nothing to replace. " +
        "Use /pinet start to reload the current broker runtime instead.",
    };
  }
  steps.push(
    `Lock held by live pid ${owner.pid}${owner.legacy ? " (legacy lock format — weaker identity fence)" : ""}.`,
  );

  const sameOwner = (current: BrokerLockInspection): boolean =>
    current.state === "alive" &&
    current.owner.pid === owner.pid &&
    current.owner.instanceId === owner.instanceId &&
    current.owner.processStartTime === owner.processStartTime;

  const ownerChangedResult = (): ReplaceBrokerOwnerResult => {
    steps.push("Lock owner changed during replacement — aborting.");
    return {
      outcome: "owner-changed",
      owner,
      steps,
      error:
        "The broker lock changed owners during replacement — another session may have recovered it. Check /pinet status and retry if needed.",
    };
  };

  const waitForRelease = async (waitMs: number): Promise<"released" | "owner-changed" | "held"> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = inspect();
      if (current.state !== "alive") return "released";
      if (!sameOwner(current)) return "owner-changed";
      if (Date.now() >= deadline) return "held";
      await sleep(pollIntervalMs);
    }
  };

  // ── Step 1: graceful shutdown over the socket ──
  const shutdownResult = await requestShutdown({
    ...(options.target ? { target: options.target } : {}),
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    meshSecret: options.meshSecret ?? null,
    timeoutMs: options.shutdownRpcTimeoutMs ?? DEFAULT_SHUTDOWN_RPC_TIMEOUT_MS,
  });
  steps.push(`Graceful shutdown request: ${shutdownResult}.`);
  if (shutdownResult === "accepted") {
    const wait = await waitForRelease(gracefulWaitMs);
    if (wait === "released") {
      steps.push("Broker released the lock after graceful shutdown.");
      return { outcome: "replaced-graceful", owner, steps, error: null };
    }
    if (wait === "owner-changed") return ownerChangedResult();
    steps.push("Broker accepted shutdown but did not release the lock in time.");
  }

  if (shutdownResult === "rejected") {
    // The broker is responsive and refused the request (typically a mesh
    // secret mismatch). A responsive broker is not stranded — do not
    // escalate to signals.
    return {
      outcome: "failed",
      owner,
      steps,
      error:
        "The running broker rejected the shutdown request (often a mesh secret mismatch). " +
        "It is responsive, so it was not terminated. Fix the mesh secret configuration, " +
        "or stop that broker from its own session, then retry.",
    };
  }

  // ── Step 2: fenced termination fallback ──
  if (!owner.processStartTime) {
    // Legacy locks (and structured locks with an unknown start time) carry no
    // PID-reuse fence, so an automatic SIGTERM could hit an unrelated process
    // that reused the PID. Require a manual, human-verified step instead.
    steps.push(
      "Lock owner has no recorded process start identity — refusing automatic termination.",
    );
    return {
      outcome: "failed",
      owner,
      steps,
      error:
        `The lock owner (pid ${owner.pid}) predates identity fencing, so automatic termination ` +
        `cannot verify it is still the original broker. Inspect it manually (ps -p ${owner.pid}), ` +
        `terminate it yourself if it is truly the stranded broker, then run /pinet start.`,
    };
  }
  const preTerminate = inspect();
  if (preTerminate.state !== "alive") {
    steps.push("Lock was released before termination was needed.");
    return {
      outcome: shutdownResult === "accepted" ? "replaced-graceful" : "no-conflict",
      owner,
      steps,
      error: null,
    };
  }
  if (!sameOwner(preTerminate)) return ownerChangedResult();

  // The fence re-check above and the signal below are not atomic: the
  // verified owner could exit and its PID be reused in between. Closing that
  // window needs a kernel handle bound to process identity (e.g. Linux
  // pidfd_send_signal), which Node does not expose without native code — the
  // immediately-preceding pid + start-time + instanceId fence keeps the
  // residual window negligible.
  steps.push(`Sending SIGTERM to verified lock owner pid ${owner.pid}.`);
  try {
    kill(owner.pid, "SIGTERM");
  } catch {
    // ESRCH etc. — the process may have just exited; the release wait decides.
    steps.push(`Signal delivery to pid ${owner.pid} failed — it may have already exited.`);
  }
  const wait = await waitForRelease(terminateWaitMs);
  if (wait === "released") {
    steps.push("Broker released the lock after SIGTERM.");
    return { outcome: "replaced-terminated", owner, steps, error: null };
  }
  if (wait === "owner-changed") return ownerChangedResult();

  return {
    outcome: "failed",
    owner,
    steps,
    error:
      `Broker pid ${owner.pid} is still holding the lock after SIGTERM. ` +
      `Not escalating to SIGKILL automatically — inspect the process (ps -p ${owner.pid}) ` +
      `and terminate it manually if it is truly stranded, then run /pinet start.`,
  };
}
