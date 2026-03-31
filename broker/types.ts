// ─── Broker types — shared across router, DB, and client ─

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
  ownerAgent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelAssignment {
  channel: string;
  agentId: string;
}

export interface InboundMessage {
  source: string;
  threadId: string;
  channel: string;
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
}

export type RoutingDecision =
  | { action: "deliver"; agentId: string }
  | { action: "broadcast"; agentIds: string[] }
  | { action: "unrouted" }
  | { action: "reject"; reason: string };

// ─── BrokerDB interface (subset used by the router) ──────

export interface BrokerDB {
  getThread(threadId: string): ThreadInfo | null;
  getAgents(): AgentInfo[];
  getChannelAssignment(channel: string): ChannelAssignment | null;
  getAllowedUsers(): Set<string> | null;

  createThread(thread: ThreadInfo): void;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;

  queueMessage(agentId: string, message: InboundMessage): void;
}
