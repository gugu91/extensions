import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function defaultLockPath(): string {
  return path.join(os.homedir(), ".pi", "pinet-broker.lock");
}

// ─── Lock owner identity ─────────────────────────────────

/**
 * Identity of the process recorded in the broker leader lock.
 *
 * Legacy locks (written by older builds) contain only a PID; structured locks
 * additionally record the owner's process start time, a per-acquisition
 * instance id, hostname, and creation timestamp so a second session can tell
 * a live owner apart from a reused PID.
 */
export interface BrokerLockOwner {
  pid: number;
  processStartTime: string | null;
  instanceId: string | null;
  hostname: string | null;
  createdAt: string | null;
  /** True when the lock file only contained a bare PID (older builds). */
  legacy: boolean;
}

export type BrokerLockInspection =
  /** No lock file exists. */
  | { state: "none"; owner: null }
  /** Lock file exists but cannot be parsed — safe to reclaim. */
  | { state: "unreadable"; owner: null }
  /** Recorded PID is no longer running — safe to reclaim. */
  | { state: "stale-dead"; owner: BrokerLockOwner }
  /**
   * Recorded PID is running but its process start time differs from the one
   * recorded at lock creation — the PID was reused by an unrelated process,
   * so the lock is stale and safe to reclaim.
   */
  | { state: "stale-pid-reused"; owner: BrokerLockOwner; currentStartTime: string }
  /** Recorded PID is running and not provably stale. */
  | { state: "alive"; owner: BrokerLockOwner };

/** Injectable process probes (for tests). */
export interface BrokerLockProbes {
  isProcessRunning?: (pid: number) => boolean;
  getProcessStartTime?: (pid: number) => string | null;
}

/**
 * Deterministically capture a process's start time for PID-reuse detection.
 *
 * Uses `/proc/<pid>/stat` (field 22, clock ticks since boot) on Linux and
 * `LC_ALL=C ps -p <pid> -o lstart=` elsewhere. Values are only ever compared
 * for exact equality against a value captured by this same function, so the
 * format does not need to be parseable — only stable for a given process.
 *
 * Returns null when the start time cannot be determined; callers must treat
 * null as "unknown" and never use it as evidence of staleness.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // comm (field 2) may contain spaces/parens — start after the last ")".
      const closeParen = stat.lastIndexOf(")");
      if (closeParen !== -1) {
        const fields = stat
          .slice(closeParen + 1)
          .trim()
          .split(/\s+/);
        // Fields after comm+state start at index 1 here; starttime is overall
        // field 22, i.e. index 19 of the post-state remainder.
        const startTime = fields[19];
        if (startTime && /^\d+$/.test(startTime)) return startTime;
      }
    } catch {
      /* fall through to ps */
    }
  }

  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      timeout: 2000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

// ─── Lock file parsing ───────────────────────────────────

interface StructuredLockMetadata {
  processStartTime: string | null;
  instanceId: string | null;
  hostname: string | null;
  createdAt: string | null;
}

/** Serialized wire shape of the lock metadata line — field types unverified. */
interface RawLockMetadata {
  processStartTime?: string | null;
  instanceId?: string | null;
  hostname?: string | null;
  createdAt?: string | null;
}

function readMetadataString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseLockContent(content: string): BrokerLockOwner | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const newlineIndex = trimmed.indexOf("\n");
  const pidLine = (newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex)).trim();
  if (!/^\d+$/.test(pidLine)) return null;
  const pid = parseInt(pidLine, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (newlineIndex === -1) {
    return {
      pid,
      processStartTime: null,
      instanceId: null,
      hostname: null,
      createdAt: null,
      legacy: true,
    };
  }

  let metadata: StructuredLockMetadata | null = null;
  try {
    const raw = JSON.parse(trimmed.slice(newlineIndex + 1).trim()) as RawLockMetadata;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      metadata = {
        processStartTime: readMetadataString(raw.processStartTime),
        instanceId: readMetadataString(raw.instanceId),
        hostname: readMetadataString(raw.hostname),
        createdAt: readMetadataString(raw.createdAt),
      };
    }
  } catch {
    metadata = null;
  }
  return {
    pid,
    processStartTime: metadata?.processStartTime ?? null,
    instanceId: metadata?.instanceId ?? null,
    hostname: metadata?.hostname ?? null,
    createdAt: metadata?.createdAt ?? null,
    legacy: metadata === null,
  };
}

/**
 * Read the current broker lock owner, or null when no lock file exists or it
 * cannot be parsed.
 */
export function readBrokerLockOwner(lockPath?: string): BrokerLockOwner | null {
  const resolved = lockPath ?? defaultLockPath();
  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch {
    return null;
  }
  return parseLockContent(content);
}

/**
 * Inspect the broker leader lock and classify its owner.
 *
 * `stale-pid-reused` is only reported when both the recorded and current
 * process start times are known and differ; unknown start times classify as
 * `alive` so uncertainty never reclaims a live broker's lock.
 */
export function inspectBrokerLock(
  lockPath?: string,
  probes: BrokerLockProbes = {},
): BrokerLockInspection {
  const resolved = lockPath ?? defaultLockPath();
  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch {
    return { state: "none", owner: null };
  }

  const owner = parseLockContent(content);
  if (!owner) {
    return { state: "unreadable", owner: null };
  }

  const isRunning = probes.isProcessRunning ?? isProcessRunning;
  if (!isRunning(owner.pid)) {
    return { state: "stale-dead", owner };
  }

  if (owner.processStartTime) {
    const startTimeOf = probes.getProcessStartTime ?? getProcessStartTime;
    const currentStartTime = startTimeOf(owner.pid);
    if (currentStartTime && currentStartTime !== owner.processStartTime) {
      return { state: "stale-pid-reused", owner, currentStartTime };
    }
  }

  return { state: "alive", owner };
}

// ─── Leader lock ─────────────────────────────────────────

/**
 * Leader election via lock file.
 *
 * Only one broker process should run at a time. The leader writes its PID on
 * the first line (kept legacy-compatible so older builds still see a live
 * owner) followed by a JSON metadata line recording process start time and a
 * per-acquisition instance id. Stale locks (dead PID, reused PID, unreadable
 * content) are automatically reclaimed.
 */
export class LeaderLock {
  private readonly lockPath: string;
  private readonly probes: BrokerLockProbes;
  private acquired = false;
  private instanceId: string | null = null;

  constructor(lockPath?: string, probes: BrokerLockProbes = {}) {
    this.lockPath = lockPath ?? defaultLockPath();
    this.probes = probes;
  }

  /**
   * Try to acquire the lock. Returns true if this process is now the leader.
   */
  tryAcquire(): boolean {
    if (this.acquired) return true;

    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    const inspection = inspectBrokerLock(this.lockPath, this.probes);
    if (inspection.state === "alive") {
      // Another live process holds the lock
      return false;
    }
    if (inspection.state !== "none") {
      // Stale or unreadable lock — remove it
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        /* already gone */
      }
    }

    // Write our identity atomically (write to temp, rename)
    const pid = process.pid;
    const instanceId = crypto.randomUUID();
    const startTimeOf = this.probes.getProcessStartTime ?? getProcessStartTime;
    const metadata: StructuredLockMetadata & { version: number } = {
      version: 2,
      processStartTime: startTimeOf(pid),
      instanceId,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    const content = `${pid}\n${JSON.stringify(metadata)}\n`;
    const tmpPath = `${this.lockPath}.${pid}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, this.lockPath);

    // Verify we actually won (guard against race)
    const written = readBrokerLockOwner(this.lockPath);
    if (!written || written.pid !== pid || written.instanceId !== instanceId) {
      return false;
    }

    this.acquired = true;
    this.instanceId = instanceId;
    return true;
  }

  /**
   * Release the lock if we hold it.
   */
  release(): void {
    if (!this.acquired) return;

    try {
      // Only remove if it's still our PID
      const owner = readBrokerLockOwner(this.lockPath);
      if (owner && owner.pid === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Best-effort cleanup
    }

    this.acquired = false;
    this.instanceId = null;
  }

  /**
   * Check if this instance currently holds the lock.
   */
  isLeader(): boolean {
    return this.acquired;
  }

  /**
   * Get the lock file path (for testing).
   */
  getLockPath(): string {
    return this.lockPath;
  }

  /**
   * Per-acquisition instance id, set while the lock is held.
   */
  getInstanceId(): string | null {
    return this.instanceId;
  }
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
