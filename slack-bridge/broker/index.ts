import * as fs from "node:fs";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer, defaultSocketPath } from "./socket-server.js";
import type { MessageAdapter } from "./types.js";

export { BrokerDB } from "./schema.js";
export { BrokerSocketServer } from "./socket-server.js";
export type { AgentMessageCallback } from "./socket-server.js";
export type {
  AgentInfo,
  ThreadInfo,
  BrokerMessage,
  InboxEntry,
  InboundMessage,
  OutboundMessage,
  MessageAdapter,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

// ─── Broker orchestrator ─────────────────────────────────

export interface BrokerOptions {
  dbPath?: string;
  socketPath?: string;
}

export interface Broker {
  db: BrokerDB;
  server: BrokerSocketServer;
  adapters: MessageAdapter[];
  addAdapter(adapter: MessageAdapter): void;
  stop(): Promise<void>;
}

/**
 * Start the broker: initialize SQLite, start the Unix socket server.
 * Only one broker should run at a time — use /pinet-start explicitly.
 */
export async function startBroker(options: BrokerOptions = {}): Promise<Broker> {
  const db = new BrokerDB(options.dbPath);
  db.initialize();

  // Clean up stale socket file
  const socketPath = options.socketPath ?? defaultSocketPath();
  try {
    const stat = fs.statSync(socketPath);
    if (stat.isSocket()) fs.unlinkSync(socketPath);
  } catch {
    /* doesn't exist — fine */
  }

  const server = new BrokerSocketServer(db, socketPath);
  try {
    await server.start();
  } catch (err) {
    db.close();
    throw err;
  }

  const adapters: MessageAdapter[] = [];

  const broker: Broker = {
    db,
    server,
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
    },
  };

  return broker;
}
