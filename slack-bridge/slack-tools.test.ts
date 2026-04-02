import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSlackTools } from "./slack-tools.js";
import type { InboxMessage } from "./helpers.js";
import type { SlackResult } from "./slack-api.js";

type ToolResponse = {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResponse>;
};

describe("registerSlackTools", () => {
  it("uses read-through thread resolution for slack_read", async () => {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
    } as unknown as ExtensionAPI;

    const inbox: InboxMessage[] = [];
    const slack = vi.fn<
      (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>
    >(async () => ({ ok: true, messages: [] }) as SlackResult);
    const resolveFollowerReplyChannel = vi.fn(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    registerSlackTools(pi, {
      botToken: "xoxb-test-token",
      defaultChannel: undefined,
      securityPrompt: "",
      guardrails: {},
      inbox,
      slack,
      getAgentName: () => "Radiant Koala",
      getAgentEmoji: () => "🐨",
      getLastDmChannel: () => null,
      updateBadge: () => {},
      resolveUser: async (userId) => userId,
      resolveFollowerReplyChannel,
      resolveChannel: async (nameOrId) => nameOrId,
      rememberChannel: () => {},
      requireToolPolicy: () => {},
      trackOutboundThread: () => {},
      claimThreadOwnership: () => {},
      clearPendingEyes: () => {},
      registerConfirmationRequest: () => ({ status: "created" }),
    });

    const tool = tools.get("slack_read");
    expect(tool).toBeDefined();

    await tool!.execute("tool-1", { thread_ts: "123.456" });

    expect(slack).toHaveBeenCalledWith("conversations.replies", "xoxb-test-token", {
      channel: "C-DB",
      ts: "123.456",
      limit: 20,
    });
  });
});
