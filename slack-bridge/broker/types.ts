// ─── Domain types ─────────────────────────────────────────

export interface AgentInfo {
  id: string;
  stableId?: string | null;
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

export interface BacklogEntry {
  id: number;
  threadId: string;
  channel: string;
  messageId: number;
  reason: string;
  status: "pending" | "assigned" | "dropped";
  preferredAgentId: string | null;
  assignedAgentId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskAssignmentStatus =
  | "assigned"
  | "branch_pushed"
  | "pr_open"
  | "pr_merged"
  | "pr_closed";

export interface TaskAssignmentInfo {
  id: number;
  agentId: string;
  issueNumber: number;
  branch: string | null;
  prNumber: number | null;
  status: TaskAssignmentStatus;
  threadId: string;
  sourceMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledWakeupInfo {
  id: number;
  agentId: string;
  threadId: string;
  body: string;
  fireAt: string;
  createdAt: string;
}

export interface ScheduledWakeupDelivery {
  wakeup: ScheduledWakeupInfo;
  message: BrokerMessage;
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

// Server-defined broker auth error codes
export const RPC_AUTH_REQUIRED = -32001;

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

  /**
   * Atomically claim a thread for an agent (first-responder-wins).
   * Creates the thread if it doesn't exist. Returns true if the claim
   * succeeded, false if another agent already owns the thread.
   */
  claimThread(threadId: string, agentId: string, source?: string, channel?: string): boolean;

  queueMessage(agentId: string, message: InboundMessage): void;
}
