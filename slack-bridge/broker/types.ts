// ─── Domain types ─────────────────────────────────────────

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
}

export interface ThreadInfo {
  threadId: string;
  source: string;
  channel: string;
  ownerAgent: string | null;
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

export interface ChannelAssignment {
  channel: string;
  agentId: string;
}

// ─── Routing ──────────────────────────────────────────────

export type RoutingDecision =
  | { action: "deliver"; agentId: string }
  | { action: "broadcast"; agentIds: string[] }
  | { action: "unrouted" }
  | { action: "reject"; reason: string };

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

// ─── Message adapter (canonical types from adapters) ─────

import type {
  InboundMessage as _InboundMessage,
  OutboundMessage as _OutboundMessage,
  MessageAdapter as _MessageAdapter,
} from "./adapters/types.js";

export type InboundMessage = _InboundMessage;
export type OutboundMessage = _OutboundMessage;
export type MessageAdapter = _MessageAdapter;

// ─── BrokerDB interface (subset used by the router) ──────

export interface BrokerDBInterface {
  getThread(threadId: string): ThreadInfo | null;
  getAgentById(agentId: string): AgentInfo | null;
  getAgents(): AgentInfo[];
  getChannelAssignment(channel: string): ChannelAssignment | null;
  getAllowedUsers(): Set<string> | null;

  createThread(thread: ThreadInfo): void;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;

  queueMessage(agentId: string, message: InboundMessage): void;
}
