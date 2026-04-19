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

export interface NormalizedMessageContent {
  text: string;
  markdown?: string;
  slackBlocks?: ReadonlyArray<Record<string, unknown>>;
}

export interface OutboundMessage {
  threadId: string;
  channel: string;
  text: string;
  content?: NormalizedMessageContent;
  blocks?: ReadonlyArray<Record<string, unknown>>;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
