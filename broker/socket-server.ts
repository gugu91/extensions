import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcError } from "./types.js";
import {
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
} from "./types.js";

export type SlackProxyFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function defaultSocketPath(): string {
  return path.join(os.homedir(), ".pi", "pinet.sock");
}

// ─── Listen target: Unix socket path or TCP host:port ────

export type ListenTarget =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

// ─── Connection state ────────────────────────────────────

interface ConnectionState {
  agentId: string | null;
  buffer: string;
}

// ─── RPC helpers ─────────────────────────────────────────

function rpcOk(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

// ─── Socket server ───────────────────────────────────────

export class BrokerSocketServer {
  private server: net.Server | null = null;
  private readonly target: ListenTarget;
  private readonly db: BrokerDB;
  private readonly slackProxyFn: SlackProxyFn | null;
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private assignedPort: number | null = null;

  constructor(db: BrokerDB, target?: ListenTarget | string, slackProxyFn?: SlackProxyFn) {
    this.db = db;
    this.slackProxyFn = slackProxyFn ?? null;
    if (typeof target === "string") {
      this.target = { type: "unix", path: target };
    } else if (target) {
      this.target = target;
    } else {
      this.target = { type: "unix", path: defaultSocketPath() };
    }
  }

  async start(): Promise<void> {
    // Clean up stale socket file for Unix mode
    if (this.target.type === "unix") {
      if (fs.existsSync(this.target.path)) {
        fs.unlinkSync(this.target.path);
      }
      fs.mkdirSync(path.dirname(this.target.path), { recursive: true });
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.onConnection(socket));

      this.server.on("error", (err) => {
        reject(err);
      });

      if (this.target.type === "unix") {
        this.server.listen(this.target.path, () => {
          resolve();
        });
      } else {
        this.server.listen(this.target.port, this.target.host, () => {
          const addr = this.server!.address();
          if (addr && typeof addr === "object") {
            this.assignedPort = addr.port;
          }
          resolve();
        });
      }
    });
  }

  async stop(): Promise<void> {
    // Clean up all connected agents. Clear agentId so the async
    // close handler won't try to unregister after db is closed.
    for (const [socket, state] of this.connections) {
      if (state.agentId) {
        this.db.unregisterAgent(state.agentId);
        state.agentId = null;
      }
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        // Clean up socket file for Unix mode
        if (this.target.type === "unix") {
          try {
            if (fs.existsSync(this.target.path)) {
              fs.unlinkSync(this.target.path);
            }
          } catch {
            // best effort
          }
        }
        this.server = null;
        this.assignedPort = null;
        resolve();
      });
    });
  }

  /**
   * Get connection info for clients. Returns the socket path (Unix)
   * or { host, port } (TCP).
   */
  getConnectInfo(): { type: "unix"; path: string } | { type: "tcp"; host: string; port: number } {
    if (this.target.type === "unix") {
      return { type: "unix", path: this.target.path };
    }
    return {
      type: "tcp",
      host: this.target.host,
      port: this.assignedPort ?? this.target.port,
    };
  }

  // ─── Connection handling ─────────────────────────────

  private onConnection(socket: net.Socket): void {
    const state: ConnectionState = { agentId: null, buffer: "" };
    this.connections.set(socket, state);

    socket.on("data", (chunk) => {
      state.buffer += chunk.toString("utf-8");
      void this.processBuffer(socket, state);
    });

    socket.on("close", () => {
      if (state.agentId) {
        this.db.unregisterAgent(state.agentId);
      }
      this.connections.delete(socket);
    });

    socket.on("error", () => {
      // close event will handle cleanup
    });
  }

  private processBuffer(socket: net.Socket, state: ConnectionState): void {
    let newlineIdx: number;
    while ((newlineIdx = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, newlineIdx).trim();
      state.buffer = state.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        this.send(socket, rpcError(null, RPC_PARSE_ERROR, "Parse error"));
        continue;
      }

      if (
        request.jsonrpc !== "2.0" ||
        typeof request.method !== "string" ||
        request.id === undefined
      ) {
        this.send(socket, rpcError(null, RPC_INVALID_REQUEST, "Invalid request"));
        continue;
      }

      void this.dispatchRequest(request, state, socket);
    }
  }

  private async dispatchRequest(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): Promise<void> {
    try {
      const response = await this.handleRequest(req, state);
      this.send(socket, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(socket, rpcError(req.id, RPC_INTERNAL_ERROR, message));
    }
  }

  private send(socket: net.Socket, response: JsonRpcResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // connection may have closed
    }
  }

  // ─── Request dispatch ────────────────────────────────

  private async handleRequest(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
    try {
      switch (req.method) {
        case "register":
          return this.handleRegister(req, state);
        case "unregister":
          return this.handleUnregister(req, state);
        case "inbox.poll":
          return this.handleInboxPoll(req, state);
        case "inbox.ack":
          return this.handleInboxAck(req, state);
        case "send":
          return this.handleSend(req, state);
        case "threads.list":
          return this.handleThreadsList(req, state);
        case "agents.list":
          return this.handleAgentsList(req);
        case "slack.proxy":
          return await this.handleSlackProxy(req);
        default:
          return rpcError(req.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INTERNAL_ERROR, message);
    }
  }

  // ─── Method handlers ─────────────────────────────────

  private handleRegister(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    const params = req.params ?? {};
    const name = typeof params.name === "string" ? params.name : "anonymous";
    const emoji = typeof params.emoji === "string" ? params.emoji : "";

    const agentId = state.agentId ?? crypto.randomUUID();
    const agent = this.db.registerAgent(agentId, name, emoji, process.pid);
    state.agentId = agentId;

    return rpcOk(req.id, { agentId: agent.id, name: agent.name, emoji: agent.emoji });
  }

  private handleUnregister(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.unregisterAgent(state.agentId);
    state.agentId = null;

    return rpcOk(req.id, { ok: true });
  }

  private handleInboxPoll(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.touchAgent(state.agentId);

    const params = req.params ?? {};
    const limit = typeof params.limit === "number" ? params.limit : 50;
    const items = this.db.getInbox(state.agentId, limit);

    return rpcOk(
      req.id,
      items.map((item) => ({
        inboxId: item.entry.id,
        message: item.message,
      })),
    );
  }

  private handleInboxAck(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const ids = params.ids;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "number")) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "ids must be an array of numbers");
    }

    this.db.markDelivered(ids as number[], state.agentId);
    return rpcOk(req.id, { ok: true });
  }

  private handleSend(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!threadId || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId and body are required");
    }

    const source = typeof params.source === "string" ? params.source : "agent";
    const direction =
      params.direction === "inbound" || params.direction === "outbound"
        ? params.direction
        : "outbound";
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    // Ensure thread exists
    let thread = this.db.getThread(threadId);
    if (!thread) {
      const channel = typeof params.channel === "string" ? params.channel : "";
      thread = this.db.createThread(threadId, source, channel, state.agentId);
    }

    // Route to all OTHER connected agents
    const allAgents = this.db.getAgents();
    const targetIds = allAgents.filter((a) => a.id !== state.agentId).map((a) => a.id);

    const msg = this.db.insertMessage(
      threadId,
      source,
      direction,
      state.agentId,
      body,
      targetIds,
      metadata,
    );

    return rpcOk(req.id, { messageId: msg.id });
  }

  private handleThreadsList(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const threads = this.db.getThreads(state.agentId);
    return rpcOk(req.id, threads);
  }

  private handleAgentsList(req: JsonRpcRequest): JsonRpcResponse {
    const agents = this.db.getAgents();
    return rpcOk(req.id, agents);
  }

  // ─── Slack proxy handler ──────────────────────────────

  private async handleSlackProxy(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.slackProxyFn) {
      return rpcError(req.id, RPC_METHOD_NOT_FOUND, "slack.proxy is not configured on this broker");
    }

    const params = req.params ?? {};
    const method = typeof params.method === "string" ? params.method : null;
    if (!method) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "method is required for slack.proxy");
    }

    const apiParams =
      params.params && typeof params.params === "object"
        ? (params.params as Record<string, unknown>)
        : {};

    try {
      const result = await this.slackProxyFn(method, apiParams);
      return rpcOk(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INTERNAL_ERROR, `slack.proxy ${method}: ${message}`);
    }
  }
}
