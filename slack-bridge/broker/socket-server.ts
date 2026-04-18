import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

import * as crypto from "node:crypto";
import type { BrokerDB } from "./schema.js";
import { DEFAULT_SOCKET_PATH } from "./paths.js";
import { MessageRouter } from "./router.js";
import { dispatchDirectAgentMessage } from "./agent-messaging.js";
import { sendBrokerMessage } from "./message-send.js";
import type {
  AgentInfo,
  BrokerMessage,
  ClientAgentInfo,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  MessageAdapter,
} from "./types.js";
import {
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_AUTH_REQUIRED,
  RPC_AGENT_NAME_CONFLICT,
  RPC_AGENT_STABLE_ID_CONFLICT,
} from "./types.js";

export type SlackProxyFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
export const DEFAULT_PRUNE_INTERVAL_MS = 5_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 2_000;

// ─── Listen target: Unix socket path or TCP host:port ────

export type ListenTarget =
  | { type: "unix"; path: string }
  | { type: "tcp"; host: string; port: number };

export type AgentMessageCallback = (
  targetAgentId: string,
  msg: BrokerMessage,
  metadata: Record<string, unknown>,
) => void;

export type AgentStatusChangeCallback = (agentId: string, status: "working" | "idle") => void;

function toClientAgentInfo(agent: AgentInfo): ClientAgentInfo {
  const { stableId, ...clientAgent } = agent;
  void stableId;
  return clientAgent;
}

export type AgentRegistrationResolver = (input: {
  agentId: string;
  name: string;
  emoji: string;
  pid: number;
  stableId?: string;
  metadata?: Record<string, unknown>;
}) => {
  name: string;
  emoji: string;
  metadata?: Record<string, unknown>;
} | null;
export interface BrokerSocketServerOptions {
  heartbeatTimeoutMs?: number;
  pruneIntervalMs?: number;
  authTimeoutMs?: number;
  meshSecret?: string;
}

// ─── Connection state ────────────────────────────────────

interface ConnectionState {
  agentId: string | null;
  buffer: string;
  authenticated: boolean;
  authTimer: ReturnType<typeof setTimeout> | null;
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

function isJsonRpcRequestId(value: unknown): value is number | string {
  if (typeof value === "number") {
    return Number.isFinite(value) && value !== 0;
  }
  return typeof value === "string" && value.length > 0;
}

function isJsonRpcRequestPayload(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const request = value as Record<string, unknown>;
  if (request.jsonrpc !== "2.0") {
    return false;
  }
  if (typeof request.method !== "string" || request.method.length === 0) {
    return false;
  }
  if (!isJsonRpcRequestId(request.id)) {
    return false;
  }
  if (
    request.params !== undefined &&
    (typeof request.params !== "object" || request.params === null || Array.isArray(request.params))
  ) {
    return false;
  }

  return true;
}

function extractJsonRpcRequestId(value: unknown): number | string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const id = (value as Record<string, unknown>).id;
  return isJsonRpcRequestId(id) ? id : null;
}

// ─── Socket server ───────────────────────────────────────

export class BrokerSocketServer {
  private server: net.Server | null = null;
  private readonly target: ListenTarget;
  private readonly db: BrokerDB;
  private readonly router: MessageRouter;
  private readonly slackProxyFn: SlackProxyFn | null;
  private readonly connections = new Map<net.Socket, ConnectionState>();
  private readonly heartbeatTimeoutMs: number;
  private readonly pruneIntervalMs: number;
  private readonly authTimeoutMs: number;
  private readonly meshSecret: string | null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private assignedPort: number | null = null;
  private agentMessageCallback: AgentMessageCallback | null = null;
  private agentStatusChangeCallback: AgentStatusChangeCallback | null = null;
  private outboundMessageAdapters: ReadonlyArray<Pick<MessageAdapter, "name" | "send">> = [];
  private agentRegistrationResolver: AgentRegistrationResolver | null = null;

  constructor(
    db: BrokerDB,
    target?: ListenTarget | string,
    slackProxyFn?: SlackProxyFn,
    options: BrokerSocketServerOptions = {},
  ) {
    this.db = db;
    this.router = new MessageRouter(db);
    this.slackProxyFn = slackProxyFn ?? null;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
    const meshSecret = options.meshSecret?.trim();
    this.meshSecret = meshSecret && meshSecret.length > 0 ? meshSecret : null;
    if (typeof target === "string") {
      this.target = { type: "unix", path: target };
    } else if (target) {
      this.target = target;
    } else {
      this.target = { type: "unix", path: DEFAULT_SOCKET_PATH };
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
          this.startPruning();
          resolve();
        });
      } else {
        this.server.listen(this.target.port, this.target.host, () => {
          const addr = this.server!.address();
          if (addr && typeof addr === "object") {
            this.assignedPort = addr.port;
          }
          this.startPruning();
          resolve();
        });
      }
    });
  }

  async stop(): Promise<void> {
    this.stopPruning();

    // Mark all connected agents as resumably disconnected. Clear agentId so the
    // async close handler won't mark them a second time after db shutdown.
    for (const [socket, state] of this.connections) {
      if (state.agentId) {
        this.db.disconnectAgent(state.agentId, this.heartbeatTimeoutMs);
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

  /**
   * Register a callback invoked whenever a worker sends an agent-to-agent
   * message via the socket server. The broker uses this to push messages
   * targeting itself into its in-memory inbox.
   */
  onAgentMessage(cb: AgentMessageCallback): void {
    this.agentMessageCallback = cb;
  }

  /**
   * Register a callback invoked whenever a connected agent explicitly updates
   * its broker status. The broker uses idle transitions to kick maintenance so
   * backlog can be reassigned immediately.
   */
  onAgentStatusChange(cb: AgentStatusChangeCallback): void {
    this.agentStatusChangeCallback = cb;
  }

  setAgentRegistrationResolver(resolver: AgentRegistrationResolver | null): void {
    this.agentRegistrationResolver = resolver;
  }

  setOutboundMessageAdapters(adapters: ReadonlyArray<Pick<MessageAdapter, "name" | "send">>): void {
    this.outboundMessageAdapters = adapters;
  }

  private startPruning(): void {
    this.stopPruning();
    this.pruneTimer = setInterval(() => {
      try {
        this.db.pruneStaleAgents(this.heartbeatTimeoutMs);
      } catch {
        /* best effort */
      }
    }, this.pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  private stopPruning(): void {
    if (!this.pruneTimer) return;
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  private clearAuthTimer(state: ConnectionState): void {
    if (!state.authTimer) return;
    clearTimeout(state.authTimer);
    state.authTimer = null;
  }

  private startAuthTimer(socket: net.Socket, state: ConnectionState): void {
    this.clearAuthTimer(state);
    if (state.authenticated || !this.meshSecret) {
      return;
    }

    state.authTimer = setTimeout(() => {
      this.clearAuthTimer(state);
      socket.destroy();
    }, this.authTimeoutMs);
    state.authTimer.unref?.();
  }

  private disconnectDuplicateConnections(agentId: string, currentSocket: net.Socket): void {
    for (const [socket, state] of this.connections) {
      if (socket === currentSocket || state.agentId !== agentId) {
        continue;
      }
      state.agentId = null;
      socket.destroy();
    }
  }

  private findLiveStableIdConflict(
    stableId: string,
    currentSocket: net.Socket,
  ): { ownerAgentId: string } | null {
    const existing = this.db.getAgentByStableId(stableId);
    if (!existing) {
      return null;
    }

    for (const [socket, state] of this.connections) {
      if (socket === currentSocket || state.agentId !== existing.id) {
        continue;
      }
      return { ownerAgentId: existing.id };
    }

    return null;
  }

  // ─── Connection handling ─────────────────────────────

  private onConnection(socket: net.Socket): void {
    const state: ConnectionState = {
      agentId: null,
      buffer: "",
      authenticated: this.meshSecret == null,
      authTimer: null,
    };
    this.connections.set(socket, state);
    this.startAuthTimer(socket, state);

    socket.on("data", (chunk) => {
      state.buffer += chunk.toString("utf-8");
      void this.processBuffer(socket, state);
    });

    socket.on("close", () => {
      this.clearAuthTimer(state);
      if (state.agentId) {
        this.db.disconnectAgent(state.agentId, this.heartbeatTimeoutMs);
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

      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        this.send(socket, rpcError(null, RPC_PARSE_ERROR, "Parse error"));
        continue;
      }

      if (!isJsonRpcRequestPayload(parsed)) {
        this.send(
          socket,
          rpcError(extractJsonRpcRequestId(parsed), RPC_INVALID_REQUEST, "Invalid request"),
        );
        continue;
      }

      void this.dispatchRequest(parsed, state, socket);
    }
  }

  private async dispatchRequest(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): Promise<void> {
    try {
      const response = await this.handleRequest(req, state, socket);
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
    socket: net.Socket,
  ): Promise<JsonRpcResponse> {
    try {
      if (!state.authenticated && req.method !== "auth") {
        setImmediate(() => socket.destroy());
        return rpcError(
          req.id,
          RPC_AUTH_REQUIRED,
          "Authentication required before calling broker methods.",
        );
      }

      switch (req.method) {
        case "auth":
          return this.handleAuth(req, state, socket);
        case "register":
          return this.handleRegister(req, state, socket);
        case "unregister":
          return this.handleUnregister(req, state);
        case "heartbeat":
          return this.handleHeartbeat(req, state);
        case "inbox.poll":
          return this.handleInboxPoll(req, state);
        case "inbox.ack":
          return this.handleInboxAck(req, state);
        case "send":
          return this.handleSend(req, state);
        case "message.send":
          return await this.handleMessageSend(req, state);
        case "threads.list":
          return this.handleThreadsList(req, state);
        case "agents.list":
          return this.handleAgentsList(req);
        case "thread.claim":
          return this.handleThreadClaim(req, state);
        case "resolveThread":
          return this.handleResolveThread(req, state);
        case "agent.message":
          return this.handleAgentMessage(req, state);
        case "agent.broadcast":
          return this.handleAgentBroadcast(req, state);
        case "schedule.create":
          return this.handleScheduleCreate(req, state);
        case "status.update":
          return this.handleStatusUpdate(req, state);
        case "slack.proxy":
          return await this.handleSlackProxy(req, state);
        default:
          return rpcError(req.id, RPC_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INTERNAL_ERROR, message);
    }
  }

  // ─── Method handlers ─────────────────────────────────

  private handleAuth(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): JsonRpcResponse {
    if (!this.meshSecret) {
      state.authenticated = true;
      this.clearAuthTimer(state);
      return rpcOk(req.id, { ok: true });
    }

    const params = req.params ?? {};
    const providedSecret = typeof params.secret === "string" ? params.secret.trim() : "";
    if (!providedSecret) {
      setImmediate(() => socket.destroy());
      return rpcError(req.id, RPC_AUTH_REQUIRED, "Mesh secret is required.");
    }

    if (providedSecret !== this.meshSecret) {
      setImmediate(() => socket.destroy());
      return rpcError(req.id, RPC_AUTH_REQUIRED, "Invalid mesh secret.");
    }

    state.authenticated = true;
    this.clearAuthTimer(state);
    return rpcOk(req.id, { ok: true });
  }

  private handleRegister(
    req: JsonRpcRequest,
    state: ConnectionState,
    socket: net.Socket,
  ): JsonRpcResponse {
    const params = req.params ?? {};
    const requestedName = typeof params.name === "string" ? params.name.trim() : "";
    const requestedEmoji = typeof params.emoji === "string" ? params.emoji : "";
    const pid = typeof params.pid === "number" ? params.pid : 0;
    const stableId = typeof params.stableId === "string" ? params.stableId : undefined;
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    if (stableId) {
      const liveStableIdConflict = this.findLiveStableIdConflict(stableId, socket);
      if (liveStableIdConflict) {
        return rpcError(
          req.id,
          RPC_AGENT_STABLE_ID_CONFLICT,
          `Agent stableId "${stableId}" is already active on another live connection. Wait for that agent to disconnect before retrying.`,
          {
            code: "AGENT_STABLE_ID_CONFLICT",
            stableId,
            ownerAgentId: liveStableIdConflict.ownerAgentId,
            retryable: true,
          },
        );
      }
    }

    const candidateId = state.agentId ?? crypto.randomUUID();
    const resolved = this.agentRegistrationResolver?.({
      agentId: candidateId,
      name: requestedName,
      emoji: requestedEmoji,
      pid,
      stableId,
      metadata,
    });
    const explicitNameRequest = requestedName.length > 0;
    const finalName = explicitNameRequest
      ? requestedName
      : (resolved?.name ?? requestedName) || "anonymous";
    const finalEmoji = explicitNameRequest
      ? requestedEmoji.trim() || resolved?.emoji?.trim() || ""
      : (resolved?.emoji ?? requestedEmoji).trim();
    const finalMetadata = resolved?.metadata ?? metadata;

    if (explicitNameRequest) {
      const conflict = this.db.findAgentNameConflict(finalName, candidateId, stableId);
      if (conflict) {
        return rpcError(
          req.id,
          RPC_AGENT_NAME_CONFLICT,
          `Agent name "${finalName}" is already reserved. Retry with a different name or leave the name empty so the broker can assign one.`,
          {
            code: "AGENT_NAME_CONFLICT",
            requestedName: finalName,
            ownerAgentId: conflict.id,
            ownerStableId: conflict.stableId,
            retryable: true,
          },
        );
      }
    }

    const agent = this.db.registerAgent(
      candidateId,
      finalName,
      finalEmoji,
      pid,
      finalMetadata,
      stableId,
    );
    this.disconnectDuplicateConnections(agent.id, socket);
    state.agentId = agent.id;

    return rpcOk(req.id, {
      agentId: agent.id,
      name: agent.name,
      emoji: agent.emoji,
      metadata: agent.metadata,
    });
  }

  private handleUnregister(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.unregisterAgent(state.agentId);
    state.agentId = null;

    return rpcOk(req.id, { ok: true });
  }

  private handleHeartbeat(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    this.db.heartbeatAgent(state.agentId);
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

    // Activity tracking: acknowledging messages proves the agent processed them
    if (state.agentId) {
      this.db.touchAgentActivity(state.agentId);
    }

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

    // Activity tracking: sending a message proves the agent is working
    this.db.touchAgentActivity(state.agentId);

    return rpcOk(req.id, { messageId: msg.id });
  }

  private async handleMessageSend(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const body = typeof params.body === "string" ? params.body : null;
    const source = typeof params.source === "string" ? params.source : undefined;
    const channel = typeof params.channel === "string" ? params.channel : undefined;
    const agentName = typeof params.agentName === "string" ? params.agentName : undefined;
    const agentEmoji = typeof params.agentEmoji === "string" ? params.agentEmoji : undefined;
    const agentOwnerToken =
      typeof params.agentOwnerToken === "string" ? params.agentOwnerToken : undefined;
    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    if (!threadId || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId and body are required");
    }

    const result = await sendBrokerMessage(
      {
        db: this.db,
        adapters: this.outboundMessageAdapters,
      },
      {
        threadId,
        body,
        senderAgentId: state.agentId,
        ...(source ? { source } : {}),
        ...(channel ? { channel } : {}),
        ...(agentName ? { agentName } : {}),
        ...(agentEmoji ? { agentEmoji } : {}),
        ...(agentOwnerToken ? { agentOwnerToken } : {}),
        ...(metadata ? { metadata } : {}),
      },
    );

    this.db.touchAgentActivity(state.agentId);

    return rpcOk(req.id, {
      adapter: result.adapter,
      messageId: result.message.id,
      threadId: result.thread.threadId,
      channel: result.thread.channel,
      source: result.thread.source,
    });
  }

  private handleThreadsList(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const threads = this.db.getThreads(state.agentId);
    return rpcOk(req.id, threads);
  }

  private handleAgentsList(req: JsonRpcRequest): JsonRpcResponse {
    const params = req.params ?? {};
    const includeDisconnected = params.includeDisconnected === true;
    const agents = (includeDisconnected ? this.db.getAllAgents() : this.db.getAgents()).map(
      toClientAgentInfo,
    );
    return rpcOk(req.id, agents);
  }

  // ─── Thread claim handler ─────────────────────────────

  private handleThreadClaim(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadId is required");
    }

    const channel = typeof params.channel === "string" ? params.channel : undefined;
    const source =
      typeof params.source === "string" && params.source.trim().length > 0
        ? params.source.trim()
        : undefined;
    const claimed = this.router.claimThread(threadId, state.agentId, channel, source);
    return rpcOk(req.id, { claimed });
  }

  private handleResolveThread(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const threadTs = typeof params.threadTs === "string" ? params.threadTs : null;
    if (!threadTs) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "threadTs is required");
    }

    const channelId = this.db.getThread(threadTs)?.channel || null;
    return rpcOk(req.id, { channelId });
  }

  // ─── Agent-to-agent messaging ─────────────────────────

  private handleAgentMessage(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const targetAgent = typeof params.targetAgent === "string" ? params.targetAgent : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!targetAgent || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "targetAgent and body are required");
    }

    const metadata =
      params.metadata && typeof params.metadata === "object"
        ? (params.metadata as Record<string, unknown>)
        : undefined;

    const sender = this.db.getAgents().find((agent) => agent.id === state.agentId);
    const senderName = sender?.name ?? state.agentId;

    try {
      const result = dispatchDirectAgentMessage(
        this.db,
        {
          senderAgentId: state.agentId,
          senderAgentName: senderName,
          target: targetAgent,
          body,
          metadata,
        },
        (target, msg, enrichedMeta) => {
          this.agentMessageCallback?.(target.id, msg, enrichedMeta);
        },
      );

      // Activity tracking: sending agent-to-agent messages proves the agent is working
      this.db.touchAgentActivity(state.agentId);
      return rpcOk(req.id, { ok: true, messageId: result.messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INVALID_PARAMS, message);
    }
  }

  private handleAgentBroadcast(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const channel = typeof params.channel === "string" ? params.channel : null;
    const body = typeof params.body === "string" ? params.body : null;

    if (!channel || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "channel and body are required");
    }

    return rpcError(
      req.id,
      RPC_INVALID_PARAMS,
      "Broadcast channels are broker-only and cannot be sent by connected clients.",
    );
  }

  private handleScheduleCreate(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const fireAt = typeof params.fireAt === "string" ? params.fireAt : null;
    const body = typeof params.body === "string" ? params.body.trim() : null;

    if (!fireAt || !body) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "fireAt and body are required");
    }

    if (Number.isNaN(Date.parse(fireAt))) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "fireAt must be a valid ISO timestamp");
    }

    const wakeup = this.db.scheduleWakeup(state.agentId, body, fireAt);
    return rpcOk(req.id, {
      id: wakeup.id,
      threadId: wakeup.threadId,
      fireAt: wakeup.fireAt,
    });
  }

  // ─── Status update handler ─────────────────────────────

  private handleStatusUpdate(req: JsonRpcRequest, state: ConnectionState): JsonRpcResponse {
    if (!state.agentId) {
      return rpcError(req.id, RPC_INVALID_PARAMS, "Not registered");
    }

    const params = req.params ?? {};
    const status = params.status === "working" ? "working" : "idle";
    this.db.updateAgentStatus(state.agentId, status);
    try {
      this.agentStatusChangeCallback?.(state.agentId, status);
    } catch {
      /* best effort */
    }
    return rpcOk(req.id, { ok: true });
  }

  // ─── Slack proxy handler ──────────────────────────────

  private async handleSlackProxy(
    req: JsonRpcRequest,
    state: ConnectionState,
  ): Promise<JsonRpcResponse> {
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

      // Auto-claim thread ownership when a registered agent posts a message
      if (method === "chat.postMessage" && state.agentId) {
        const threadTs = typeof apiParams.thread_ts === "string" ? apiParams.thread_ts : null;
        const messageTs = typeof result.ts === "string" ? (result.ts as string) : null;
        const effectiveTs = threadTs ?? messageTs;
        if (effectiveTs) {
          this.router.claimThread(effectiveTs, state.agentId, undefined, "slack");
        }
      }

      return rpcOk(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return rpcError(req.id, RPC_INTERNAL_ERROR, `slack.proxy ${method}: ${message}`);
    }
  }
}
