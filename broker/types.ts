// ─── Domain types ─────────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  emoji: string;
  pid: number;
  connectedAt: string;
  lastSeen: string;
}

export interface ThreadInfo {
  threadId: string;
  source: string;
  channel: string;
  ownerAgent: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrokerMessage {
  id: number;
  threadId: string;
  source: string;
  direction: "inbound" | "outbound";
  sender: string;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface InboxEntry {
  id: number;
  agentId: string;
  messageId: number;
  delivered: boolean;
  createdAt: string;
}

// ─── JSON-RPC protocol ───────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// ─── Message adapter (for future Slack/Discord adapters) ──

export interface InboundMessage {
  source: string;
  threadId: string;
  channel: string;
  sender: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(threadId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
}
