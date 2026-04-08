import * as fs from "node:fs";
import { BrokerDB } from "./schema.js";
import { loadOrCreateMeshSecret } from "./auth.js";
import { BrokerSocketServer } from "./socket-server.js";
import type { ListenTarget } from "./socket-server.js";
import { LeaderLock } from "./leader.js";
import { getDefaultSocketPath } from "./paths.js";
import type { MessageAdapter } from "./types.js";

export { BrokerDB } from "./schema.js";
export { BrokerSocketServer } from "./socket-server.js";
export { LeaderLock } from "./leader.js";
export type { ListenTarget } from "./socket-server.js";
export type { AgentMessageCallback, AgentRegistrationResolver } from "./socket-server.js";
export type {
  AgentInfo,
  ThreadInfo,
  ScheduledWakeupInfo,
  ScheduledWakeupDelivery,
  BrokerMessage,
  InboxEntry,
  InboundMessage,
  OutboundMessage,
  MessageAdapter,
  JsonRpcRequest,
  JsonRpcResponse,
  TaskAssignmentInfo,
  TaskAssignmentStatus,
} from "./types.js";

// ─── Broker orchestrator ─────────────────────────────────

export interface BrokerOptions {
  dbPath?: string;
  /** Unix socket path (shorthand for { type: "unix", path }) */
  socketPath?: string;
  /** Full listen target — overrides socketPath when provided */
  listenTarget?: ListenTarget;
  lockPath?: string;
  meshSecret?: string;
  meshSecretPath?: string;
}

export interface Broker {
  db: BrokerDB;
  server: BrokerSocketServer;
  lock: LeaderLock;
  adapters: MessageAdapter[];
  addAdapter(adapter: MessageAdapter): void;
  stop(): Promise<void>;
}

/**
 * Start the broker: acquire leader lock, initialize SQLite, start the Unix socket server.
 * Only one broker may run at a time — enforced by a PID lock file.
 *
 * Throws if another broker process already holds the lock.
 */
export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  // ── Leader lock: prevent split-brain (issue #119) ────
  const lock = new LeaderLock(options.lockPath);
  if (!lock.tryAcquire()) {
    throw new Error(
      "Another pinet broker is already running. Only one broker may be active at a time.",
    );
  }

  const db = new BrokerDB(options.dbPath);
  try {
    db.initialize();
  } catch (err) {
    lock.release();
    throw err;
  }

  // Resolve listen target: explicit target > socketPath > default
  const target: ListenTarget = options.listenTarget ?? {
    type: "unix" as const,
    path: options.socketPath ?? getDefaultSocketPath(),
  };

  // Clean up stale socket file (Unix only)
  if (target.type === "unix") {
    try {
      const stat = fs.statSync(target.path);
      if (stat.isSocket()) fs.unlinkSync(target.path);
    } catch {
      /* doesn't exist — fine */
    }
  }

  const meshSecret = options.meshSecret?.trim() || null;
  const meshSecretPath = options.meshSecretPath?.trim() || null;
  const resolvedMeshSecret =
    meshSecret || (meshSecretPath ? loadOrCreateMeshSecret(meshSecretPath) : null);

  const server = new BrokerSocketServer(db, target, undefined, {
    ...(resolvedMeshSecret ? { meshSecret: resolvedMeshSecret } : {}),
  });
  try {
    await server.start();
  } catch (err) {
    db.close();
    lock.release();
    throw err;
  }

  const adapters: MessageAdapter[] = [];

  const broker: Broker = {
    db,
    server,
    lock,
    adapters,

    addAdapter(adapter: MessageAdapter): void {
      adapters.push(adapter);
    },

    async stop(): Promise<void> {
      for (const adapter of adapters) {
        try {
          await adapter.disconnect();
        } catch {
          // best effort
        }
      }
      adapters.length = 0;
      await server.stop();
      db.close();
      lock.release();
    },
  };

  return broker;
}
