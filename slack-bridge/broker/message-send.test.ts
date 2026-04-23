import type { RuntimeScopeCarrier } from "@gugu910/pi-transport-core";
import { describe, expect, it, vi } from "vitest";
import { sendBrokerMessage } from "./message-send.js";
import type { BrokerMessage, ThreadInfo } from "./types.js";

function createFakeDb() {
  const threads = new Map<string, ThreadInfo>();
  const threadScopes = new Map<string, RuntimeScopeCarrier>();
  let nextMessageId = 1;

  return {
    threads,
    threadScopes,
    getThread(threadId: string) {
      return threads.get(threadId) ?? null;
    },
    getThreadScope(threadId: string) {
      return threadScopes.get(threadId) ?? null;
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

  it("threads stored scope carriers into outbound adapter sends", async () => {
    const db = createFakeDb();
    db.createThread("slack:100.1", "slack", "C123", "agent-1");
    db.threadScopes.set("slack:100.1", {
      workspace: {
        provider: "slack",
        source: "explicit",
        workspaceId: "T_PRIMARY",
        installId: "primary",
      },
    });
    const send = vi.fn(async () => undefined);

    await sendBrokerMessage(
      {
        db,
        adapters: [{ name: "slack", send }],
      },
      {
        threadId: "slack:100.1",
        body: "scoped follow-up",
        senderAgentId: "agent-1",
      },
    );

    expect(send).toHaveBeenCalledWith({
      threadId: "slack:100.1",
      channel: "C123",
      text: "scoped follow-up",
      scope: {
        workspace: {
          provider: "slack",
          source: "explicit",
          workspaceId: "T_PRIMARY",
          installId: "primary",
        },
      },
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
