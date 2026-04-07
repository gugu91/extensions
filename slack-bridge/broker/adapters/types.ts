// ─── Adapter message types ───────────────────────────────

export interface InboundMessage {
  source: string;
  threadId: string;
  channel: string;
  userId: string;
  userName?: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  threadId: string;
  channel: string;
  text: string;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: Record<string, unknown>;
}

// ─── Adapter interface ───────────────────────────────────

export interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
