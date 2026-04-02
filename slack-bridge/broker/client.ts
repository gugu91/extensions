import * as net from "node:net";
import { DEFAULT_SOCKET_PATH as PINET_DEFAULT_SOCKET_PATH } from "./paths.js";

// ─── Types ───────────────────────────────────────────────

export interface InboxItem {
  inboxId: number;
  message: {
    id: number;
    threadId: string;
    source: string;
    direction: string;
    sender: string;
    body: string;
    metadata: Record<string, unknown> | null;
    createdAt: string;
  };
}

export interface ThreadInfo {
  threadId: string;
  source: string;
  channel: string;
  ownerAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  pid: number;
  connectedAt: string;
  lastSeen: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown> | null;
  status: "working" | "idle";
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  idleSince?: string | null;
  lastActivity?: string | null;
}

// ─── JSON-RPC types ──────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Constants (exported for testing) ────────────────────

export const DEFAULT_SOCKET_PATH = PINET_DEFAULT_SOCKET_PATH;
export const REQUEST_TIMEOUT_MS = 5000;
export const RECONNECT_DELAY_MS = 3000;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Compute reconnect delay with exponential backoff and jitter. */
export function computeReconnectDelay(attempt: number, random = Math.random()): number {
  const baseDelay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(baseDelay, MAX_RECONNECT_DELAY_MS);
  // Add jitter: ±25%
  const jitter = capped * (0.75 + random * 0.5);
  return Math.round(jitter);
}

// ─── Pending request tracker ─────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RegistrationSnapshot {
  name: string;
  emoji: string;
  metadata?: Record<string, unknown>;
  stableId?: string;
}

interface RegistrationResult {
  agentId: string;
  name: string;
  emoji: string;
}

// ─── Connection options ──────────────────────────────────

export type BrokerConnectOpts = { path: string } | { host: string; port: number };

// ─── BrokerClient ────────────────────────────────────────

export class BrokerClient {
  private readonly connectOpts: BrokerConnectOpts;
  private socket: net.Socket | null = null;
  private connected = false;
  private shuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectHandler: (() => void) | null = null;
  private reconnectHandler: (() => void) | null = null;
  private reconnectAttempt = 0;
  private registrationSnapshot: RegistrationSnapshot | null = null;
  private registeredIdentity: RegistrationResult | null = null;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";

  constructor(opts?: string | BrokerConnectOpts) {
    if (opts === undefined) {
      this.connectOpts = { path: DEFAULT_SOCKET_PATH };
    } else if (typeof opts === "string") {
      this.connectOpts = { path: opts };
    } else {
      this.connectOpts = opts;
    }
  }

  // ─── Connection ──────────────────────────────────────

  connect(): Promise<void> {
    this.shuttingDown = false;
    return this.connectSocket();
  }

  disconnect(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.rejectAllPending(new Error("Client disconnected"));
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Registration ────────────────────────────────────

  async register(
    name: string,
    emoji: string,
    metadata?: Record<string, unknown>,
    stableId?: string,
  ): Promise<{ agentId: string; name: string; emoji: string }> {
    this.registrationSnapshot = {
      name,
      emoji,
      ...(metadata ? { metadata } : {}),
      ...(stableId ? { stableId } : {}),
    };
    return this.performRegister(this.registrationSnapshot);
  }

  async unregister(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.request("unregister");
    } finally {
      this.stopHeartbeat();
      this.registrationSnapshot = null;
      this.registeredIdentity = null;
    }
  }

  async heartbeat(): Promise<void> {
    await this.request("heartbeat");
  }

  // ─── Messaging ───────────────────────────────────────

  async pollInbox(): Promise<InboxItem[]> {
    const result = (await this.request("inbox.poll")) as InboxItem[];
    return result;
  }

  async ackMessages(ids: number[]): Promise<void> {
    await this.request("inbox.ack", { ids });
  }

  async send(threadId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.request("send", { threadId, body: text, ...(metadata ? { metadata } : {}) });
  }

  // ─── Thread ownership ─────────────────────────────────

  async claimThread(threadId: string, channel?: string): Promise<{ claimed: boolean }> {
    const params: Record<string, unknown> = { threadId };
    if (channel) params.channel = channel;
    const result = (await this.request("thread.claim", params)) as { claimed: boolean };
    return result;
  }

  async resolveThread(threadTs: string): Promise<string | null> {
    const result = (await this.request("resolveThread", { threadTs })) as {
      channelId?: string | null;
    };
    return typeof result.channelId === "string" ? result.channelId : null;
  }

  // ─── Status ────────────────────────────────────────────

  async updateStatus(status: "working" | "idle"): Promise<void> {
    await this.request("status.update", { status });
  }

  // ─── Agent-to-agent messaging ─────────────────────────

  async sendAgentMessage(target: string, body: string): Promise<number> {
    const result = (await this.request("agent.message", {
      targetAgent: target,
      body,
    })) as { ok: boolean; messageId: number };
    return result.messageId;
  }

  // ─── Queries ─────────────────────────────────────────

  async listThreads(): Promise<ThreadInfo[]> {
    const result = (await this.request("threads.list")) as ThreadInfo[];
    return result;
  }

  async listAgents(includeDisconnected = false): Promise<AgentInfo[]> {
    const result = (await this.request(
      "agents.list",
      includeDisconnected ? { includeDisconnected: true } : undefined,
    )) as AgentInfo[];
    return result;
  }

  // ─── Slack proxy (read-through) ──────────────────────

  async slackProxy(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = (await this.request("slack.proxy", { method, params })) as Record<
      string,
      unknown
    >;
    return result;
  }

  // ─── Events ──────────────────────────────────────────

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandler = handler;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  getRegisteredIdentity(): { agentId: string; name: string; emoji: string } | null {
    return this.registeredIdentity ? { ...this.registeredIdentity } : null;
  }

  // ─── JSON-RPC transport ──────────────────────────────

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error("Not connected to broker"));
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

      const line = JSON.stringify(msg) + "\n";
      this.socket!.write(line, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        this.handleResponse(msg);
      } catch {
        /* malformed JSON — skip */
      }
    }
  }

  private handleResponse(msg: JsonRpcResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(msg.id);

    if (msg.error) {
      entry.reject(new Error(msg.error.message));
    } else {
      entry.resolve(msg.result);
    }
  }

  // ─── Reconnect ──────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    const delay = computeReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.connectOpts);

      sock.on("connect", () => {
        this.socket = sock;
        this.connected = true;
        this.buffer = "";
        resolve();
      });

      sock.on("data", (chunk: Buffer) => {
        this.onData(chunk.toString("utf-8"));
      });

      sock.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this.stopHeartbeat();
        this.rejectAllPending(new Error("Socket closed"));
        if (wasConnected && !this.shuttingDown) {
          this.disconnectHandler?.();
          this.scheduleReconnect();
        }
      });

      sock.on("error", (err: Error) => {
        if (!this.connected) {
          reject(err);
        }
        // If already connected, the close event handles cleanup
      });
    });
  }

  private async performRegister(
    snapshot: RegistrationSnapshot,
  ): Promise<{ agentId: string; name: string; emoji: string }> {
    const result = (await this.request("register", {
      name: snapshot.name,
      emoji: snapshot.emoji,
      pid: process.pid,
      ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
      ...(snapshot.stableId ? { stableId: snapshot.stableId } : {}),
    })) as RegistrationResult;
    this.registrationSnapshot = {
      ...snapshot,
      name: result.name,
      emoji: result.emoji,
    };
    this.registeredIdentity = result;
    this.startHeartbeat();
    return result;
  }

  private async reconnectOnce(): Promise<void> {
    try {
      await this.connectSocket();
    } catch {
      this.scheduleReconnect();
      return;
    }

    try {
      if (this.registrationSnapshot) {
        await this.performRegister(this.registrationSnapshot);
      }
      this.reconnectAttempt = 0;
      this.reconnectHandler?.();
    } catch {
      // Re-registration failed after the socket connected. Clear the connection
      // state immediately instead of waiting for the async "close" event so the
      // client cannot stay in a broken "connected but not registered" state.
      // Then schedule the next reconnect attempt ourselves. (#139)
      const failedSocket = this.socket;
      this.socket = null;
      this.connected = false;
      this.buffer = "";
      this.stopHeartbeat();
      this.rejectAllPending(new Error("Socket closed"));
      try {
        failedSocket?.destroy();
      } catch {
        /* ignore */
      }
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      void this.heartbeat().catch(() => {
        /* best effort */
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }
}
