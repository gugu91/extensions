import { describe, expect, it, vi } from "vitest";
import { sendBrokerMessage } from "./message-send.js";
import type { BrokerMessage, ThreadInfo } from "./types.js";

function createFakeDb() {
  const threads = new Map<string, ThreadInfo>();
  let nextMessageId = 1;

  return {
    threads,
    getThread(threadId: string) {
      return threads.get(threadId) ?? null;
    },
    createThread(threadId: string, source: string, channel: string, ownerAgent: string | null) {
      const now = new Date().toISOString();
      const thread: ThreadInfo = {
        threadId,
        source,
        channel,
        ownerAgent,
        ownerBinding: null,
        createdAt: now,
        updatedAt: now,
      };
      threads.set(threadId, thread);
      return thread;
    },
    updateThread(threadId: string, updates: Partial<ThreadInfo>) {
      const existing = threads.get(threadId);
      if (!existing) {
        throw new Error(`Unknown thread ${threadId}`);
      }
      threads.set(threadId, { ...existing, ...updates });
    },
    insertMessage(
      threadId: string,
      source: string,
      direction: "inbound" | "outbound",
      sender: string,
      body: string,
      _targetAgentIds: string[],
      metadata?: Record<string, unknown>,
    ): BrokerMessage {
      return {
        id: nextMessageId++,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        createdAt: new Date().toISOString(),
      };
    },
  };
}

describe("sendBrokerMessage", () => {
  it("creates a new thread and sends through the matching adapter", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);

    const result = await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "imessage", send }],
      },
      {
        threadId: "imessage:chat:alice",
        body: "hello",
        senderAgentId: "agent-1",
        source: "imessage",
        channel: "chat:alice",
        agentName: "Sender",
        agentOwnerToken: "owner-token",
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "imessage:chat:alice",
      channel: "chat:alice",
      text: "hello",
      agentName: "Sender",
      agentOwnerToken: "owner-token",
    });
    expect(db.getThread("imessage:chat:alice")).toMatchObject({
      source: "imessage",
      channel: "chat:alice",
      ownerAgent: "agent-1",
    });
    expect(result.message.direction).toBe("outbound");
    expect(result.adapter).toBe("imessage");
  });

  it("passes normalized outbound content and fallback blocks through to the adapter", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;
    const slackBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Transport-aware blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    const result = await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "100.200",
        body: "  raw fallback body  ",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C123",
        content: {
          text: " canonical fallback text ",
          markdown: " **canonical fallback text** ",
          slackBlocks,
        },
        blocks: legacyBlocks,
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "100.200",
      channel: "C123",
      text: "canonical fallback text",
      content: {
        text: "canonical fallback text",
        markdown: "**canonical fallback text**",
        slackBlocks,
      },
      blocks: legacyBlocks,
    });
    expect(result.message.body).toBe("canonical fallback text");
  });

  it("omits empty Slack-native content blocks so transports can use legacy fallback blocks", async () => {
    const db = createFakeDb();
    const send = vi.fn(async () => undefined);
    const legacyBlocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Legacy blocks*" },
      },
    ] satisfies ReadonlyArray<Record<string, unknown>>;

    await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "100.201",
        body: "fallback text",
        senderAgentId: "agent-1",
        source: "slack",
        channel: "C123",
        content: {
          text: "fallback text",
          slackBlocks: [],
        },
        blocks: legacyBlocks,
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "100.201",
      channel: "C123",
      text: "fallback text",
      content: {
        text: "fallback text",
      },
      blocks: legacyBlocks,
    });
  });

  it("reuses the stored thread transport when source and channel are omitted", async () => {
    const db = createFakeDb();
    db.createThread("imessage:chat:bob", "imessage", "chat:bob", "agent-1");
    const send = vi.fn(async () => undefined);

    await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "imessage", send }],
      },
      {
        threadId: "imessage:chat:bob",
        body: "follow-up",
        senderAgentId: "agent-1",
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "imessage:chat:bob",
      channel: "chat:bob",
      text: "follow-up",
    });
  });

  it("fails cleanly when no adapter is registered for the thread source", async () => {
    const db = createFakeDb();

    await expect(
      sendBrokerMessage(
        {
          db,
          adapters: [],
        },
        {
          threadId: "imessage:chat:carol",
          body: "hello",
          senderAgentId: "agent-1",
          source: "imessage",
          channel: "chat:carol",
        },
      ),
    ).rejects.toThrow('No adapter is registered for transport source "imessage".');
  });
});
