import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { LeaderLock } from "./leader.js";
import type { MessageAdapter } from "./types.js";

export { BrokerDB } from "./schema.js";
export { BrokerSocketServer } from "./socket-server.js";
export { LeaderLock } from "./leader.js";
export type {
  AgentInfo,
  ThreadInfo,
  BrokerMessage,
  InboxEntry,
  InboundMessage,
  MessageAdapter,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

// ─── Broker orchestrator ─────────────────────────────────

export interface BrokerOptions {
  dbPath?: string;
  socketPath?: string;
  lockPath?: string;
}

export interface Broker {
  db: BrokerDB;
  server: BrokerSocketServer;
  leader: LeaderLock;
  adapters: MessageAdapter[];
  addAdapter(adapter: MessageAdapter): void;
  stop(): Promise<void>;
}

/**
 * Start the broker: acquire leader lock, initialize SQLite, start
 * the Unix socket server. Throws if another broker is already running.
 */
export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  const leader = new LeaderLock(options.lockPath);

  if (!leader.tryAcquire()) {
    throw new Error("Another broker is already running (lock file held by active process)");
  }

  const db = new BrokerDB(options.dbPath);
  try {
    db.initialize();
  } catch (err) {
    leader.release();
    throw err;
  }

  const server = new BrokerSocketServer(db, options.socketPath);
  try {
    await server.start();
  } catch (err) {
    db.close();
    leader.release();
    throw err;
  }

  const adapters: MessageAdapter[] = [];

  const broker: Broker = {
    db,
    server,
    leader,
    adapters,

    addAdapter(adapter: MessageAdapter): void {
      adapters.push(adapter);
    },

    async stop(): Promise<void> {
      // Disconnect adapters
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
      leader.release();
    },
  };

  return broker;
}
