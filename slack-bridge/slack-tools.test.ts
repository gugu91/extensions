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

      if (method === "chat.scheduleMessage") {
        return {
          ok: true,
          token,
          body,
          channel: typeof body?.channel === "string" ? body.channel : "C123",
          post_at: typeof body?.post_at === "number" ? body.post_at : 1_800_000_000,
          scheduled_message_id: "Q12345",
        } as SlackResult;
      }

      if (method === "pins.add" || method === "pins.remove") {
        return {
          ok: true,
          token,
          body,
        } as SlackResult;
      }

      if (method === "bookmarks.add") {
        return {
          ok: true,
          token,
          body,
          bookmark: {
            id: "Bk123",
            title: body?.title,
            link: body?.link,
            emoji: body?.emoji,
          },
        } as SlackResult;
      }

      if (method === "bookmarks.list") {
        return {
          ok: true,
          token,
          body,
          bookmarks: [
            {
              id: "Bk123",
              title: "Repo",
              link: "https://github.com/gugu91/extensions",
              emoji: ":rabbit:",
            },
          ],
        } as SlackResult;
      }

      if (method === "bookmarks.remove") {
        return {
          ok: true,
          token,
          body,
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

  it("reads the latest bot token and default channel when slack_schedule executes", async () => {
    const { slack, tools, setBotToken, setDefaultChannel } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    await tools.get("slack_schedule")!.execute("tool-4", {
      text: "hello from the future",
      at: "2030-01-02T03:04:05Z",
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.scheduleMessage",
      "xoxb-reloaded",
      expect.objectContaining({
        channel: "resolved:ops-alerts",
        text: "hello from the future",
        post_at: Math.floor(Date.parse("2030-01-02T03:04:05Z") / 1000),
      }),
    );
  });

  it("uses thread channel resolution for slack_schedule delays", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-02T14:00:00Z"));
    try {
      await tools.get("slack_schedule")!.execute("tool-5", {
        text: "follow up later",
        thread_ts: "123.456",
        delay: "30m",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(slack).toHaveBeenCalledWith(
      "chat.scheduleMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "C-DB",
        thread_ts: "123.456",
        text: "follow up later",
        post_at: Math.floor(Date.parse("2026-04-02T14:30:00.000Z") / 1000),
      }),
    );
  });

  it("handles already_pinned gracefully", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack pins.add: already_pinned");
    });

    const response = await tools.get("slack_pin")!.execute("tool-6", {
      action: "pin",
      message_ts: "123.789",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("pins.add", "xoxb-initial", {
      channel: "C-DB",
      timestamp: "123.789",
    });
    expect(response.details?.status).toBe("already_pinned");
  });

  it("handles no_pin gracefully when unpinning", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("ops-alerts");
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack pins.remove: no_pin");
    });

    const response = await tools.get("slack_pin")!.execute("tool-7", {
      action: "unpin",
      message_ts: "123.789",
    });

    expect(slack).toHaveBeenCalledWith("pins.remove", "xoxb-initial", {
      channel: "resolved:ops-alerts",
      timestamp: "123.789",
    });
    expect(response.details?.status).toBe("not_pinned");
  });

  it("adds channel bookmarks", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("docs");

    const response = await tools.get("slack_bookmark")!.execute("tool-8", {
      action: "add",
      title: "Repo",
      url: "https://github.com/gugu91/extensions",
      emoji: ":rocket:",
    });

    expect(slack).toHaveBeenCalledWith(
      "bookmarks.add",
      "xoxb-initial",
      expect.objectContaining({
        channel_id: "resolved:docs",
        title: "Repo",
        type: "link",
        link: "https://github.com/gugu91/extensions",
        emoji: ":rocket:",
      }),
    );
    expect(response.details?.bookmark_id).toBe("Bk123");
  });

  it("lists bookmarks from the resolved thread channel", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_bookmark")!.execute("tool-9", {
      action: "list",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("bookmarks.list", "xoxb-initial", {
      channel_id: "C-DB",
    });
    expect(response.content?.[0]?.text).toContain("Bk123");
  });

  it("handles missing bookmarks gracefully when removing", async () => {
    const { slack, tools, setDefaultChannel } = setup();
    setDefaultChannel("docs");
    slack.mockImplementationOnce(async () => {
      throw new Error("Slack bookmarks.remove: not_found");
    });

    const response = await tools.get("slack_bookmark")!.execute("tool-10", {
      action: "remove",
      bookmark_id: "Bk404",
    });

    expect(slack).toHaveBeenCalledWith("bookmarks.remove", "xoxb-initial", {
      channel_id: "resolved:docs",
      bookmark_id: "Bk404",
    });
    expect(response.details?.status).toBe("not_found");
  });
});
