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
  function setup() {
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
    } as unknown as ExtensionAPI;

    const inbox: InboxMessage[] = [];
    let botToken = "xoxb-initial";
    let defaultChannel = "general";
    let securityPrompt = "INITIAL SECURITY PROMPT";

    const slack = vi.fn<
      (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>
    >(async (method, token, body) => {
      if (method === "chat.postMessage") {
        return {
          ok: true,
          token,
          body,
          message: { ts: "123.456" },
        } as SlackResult;
      }

      return {
        ok: true,
        token,
        body,
        messages: [],
      } as SlackResult;
    });

    let resolveFollowerReplyChannel: (
      threadTs: string | undefined,
    ) => Promise<string | null> = async () => null;

    registerSlackTools(pi, {
      getBotToken: () => botToken,
      getDefaultChannel: () => defaultChannel,
      getSecurityPrompt: () => securityPrompt,
      inbox,
      slack,
      getAgentName: () => "Radiant Koala",
      getAgentEmoji: () => "🐨",
      getLastDmChannel: () => null,
      updateBadge: () => {},
      resolveUser: async (userId) => userId,
      resolveFollowerReplyChannel: (threadTs) => resolveFollowerReplyChannel(threadTs),
      resolveChannel: async (nameOrId) => `resolved:${nameOrId}`,
      rememberChannel: () => {},
      requireToolPolicy: () => {},
      trackOutboundThread: () => {},
      claimThreadOwnership: () => {},
      clearPendingEyes: () => {},
      registerConfirmationRequest: () => ({ status: "created" }),
    });

    return {
      inbox,
      slack,
      tools,
      setBotToken: (value: string) => {
        botToken = value;
      },
      setDefaultChannel: (value: string) => {
        defaultChannel = value;
      },
      setSecurityPrompt: (value: string) => {
        securityPrompt = value;
      },
      setResolveFollowerReplyChannel: (
        fn: (threadTs: string | undefined) => Promise<string | null>,
      ) => {
        resolveFollowerReplyChannel = fn;
      },
    };
  }

  it("reads the latest security prompt when slack_inbox executes", async () => {
    const { inbox, tools, setSecurityPrompt } = setup();
    inbox.push({
      channel: "D123",
      threadTs: "123.456",
      userId: "U123",
      text: "hello",
      timestamp: "123.456",
    });

    setSecurityPrompt("UPDATED SECURITY PROMPT");

    const response = await tools.get("slack_inbox")!.execute("tool-1", {});
    expect(response.content?.[0]?.text).toContain("UPDATED SECURITY PROMPT");
    expect(response.content?.[0]?.text).not.toContain("INITIAL SECURITY PROMPT");
  });

  it("reads the latest bot token and default channel when slack_post_channel executes", async () => {
    const { slack, tools, setBotToken, setDefaultChannel } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    await tools.get("slack_post_channel")!.execute("tool-2", {
      text: "hello from reloaded config",
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-reloaded",
      expect.objectContaining({
        channel: "resolved:ops-alerts",
        text: "hello from reloaded config",
      }),
    );
  });

  it("uses read-through thread resolution for slack_read", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    await tools.get("slack_read")!.execute("tool-3", { thread_ts: "123.456" });

    expect(slack).toHaveBeenCalledWith("conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 20,
    });
  });
});
