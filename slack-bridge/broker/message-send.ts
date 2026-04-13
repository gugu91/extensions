import type { BrokerMessage, MessageAdapter, OutboundMessage, ThreadInfo } from "./types.js";

export interface BrokerMessageSenderDb {
  getThread(threadId: string): ThreadInfo | null;
  createThread(threadId: string, source: string, channel: string, ownerAgent: string | null): ThreadInfo;
  updateThread(threadId: string, updates: Partial<ThreadInfo>): void;
  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: Record<string, unknown>,
  ): BrokerMessage;
}

export interface BrokerMessageSenderDeps {
  db: BrokerMessageSenderDb;
  adapters: ReadonlyArray<Pick<MessageAdapter, "name" | "send">>;
}

export interface SendBrokerMessageInput {
  threadId: string;
  body: string;
  senderAgentId: string;
  source?: string;
  channel?: string;
  agentName?: string;
  agentEmoji?: string;
  agentOwnerToken?: string;
  metadata?: Record<string, unknown>;
}

export interface SendBrokerMessageResult {
  thread: ThreadInfo;
  message: BrokerMessage;
  adapter: string;
}

export async function sendBrokerMessage(
  deps: BrokerMessageSenderDeps,
  input: SendBrokerMessageInput,
): Promise<SendBrokerMessageResult> {
  const threadId = input.threadId.trim();
  const body = input.body.trim();
  if (!threadId || !body) {
    throw new Error("threadId and body are required.");
  }

  const existingThread = deps.db.getThread(threadId);
  const source = (input.source ?? existingThread?.source ?? "").trim();
  const channel = (input.channel ?? existingThread?.channel ?? "").trim();

  if (!source) {
    throw new Error(`No transport source is recorded for thread ${threadId}.`);
  }
  if (!channel) {
    throw new Error(`No transport channel is recorded for thread ${threadId}.`);
  }

  const adapter = deps.adapters.find((candidate) => candidate.name === source);
  if (!adapter) {
    throw new Error(`No adapter is registered for transport source ${JSON.stringify(source)}.`);
  }

  const outbound: OutboundMessage = {
    threadId,
    channel,
    text: body,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(input.agentEmoji ? { agentEmoji: input.agentEmoji } : {}),
    ...(input.agentOwnerToken ? { agentOwnerToken: input.agentOwnerToken } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  await adapter.send(outbound);

  let thread = existingThread;
  if (!thread) {
    thread = deps.db.createThread(threadId, source, channel, input.senderAgentId);
  } else if (thread.source !== source || thread.channel !== channel) {
    deps.db.updateThread(threadId, { source, channel });
    thread = { ...thread, source, channel };
  }

  const message = deps.db.insertMessage(
    threadId,
    source,
    "outbound",
    input.senderAgentId,
    body,
    [],
    input.metadata,
  );

  return {
    thread,
    message,
    adapter: adapter.name,
  };
}
