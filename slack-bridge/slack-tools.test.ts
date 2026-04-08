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
    let resolveUser = async (userId: string) => userId;
    let conversationsRepliesResponses: SlackResult[] = [];
    let usersListResponse: SlackResult = {
      ok: true,
      members: [],
      response_metadata: { next_cursor: "" },
    } as SlackResult;
    let conversationsInfoResponse: SlackResult = {
      ok: true,
      channel: { id: "C_PROJ", properties: {} },
    } as SlackResult;
    let canvasSectionsLookupResponse: SlackResult = {
      ok: true,
      sections: [],
    } as SlackResult;
    const presenceResponses = new Map<string, SlackResult>();
    const dndResponses = new Map<string, SlackResult>();

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

      if (method === "views.open" || method === "views.push" || method === "views.update") {
        return {
          ok: true,
          token,
          body,
          view: {
            id: "V123",
            external_id: typeof body?.external_id === "string" ? body.external_id : undefined,
            hash: "hash-123",
            ...(body?.view as Record<string, unknown> | undefined),
          },
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

      if (method === "users.getPresence") {
        const user = typeof body?.user === "string" ? body.user : "";
        return (
          presenceResponses.get(user) ??
          ({ ok: true, token, body, presence: "away", online: false } as SlackResult)
        );
      }

      if (method === "dnd.info") {
        const user = typeof body?.user === "string" ? body.user : "";
        return (
          dndResponses.get(user) ??
          ({ ok: true, token, body, dnd_enabled: false, snooze_enabled: false } as SlackResult)
        );
      }

      if (method === "users.list") {
        return usersListResponse;
      }

      if (method === "conversations.replies" && conversationsRepliesResponses.length > 0) {
        return conversationsRepliesResponses.shift() as SlackResult;
      }

      if (method === "conversations.create") {
        const name = typeof body?.name === "string" ? body.name : "test-channel";
        return {
          ok: true,
          channel: { id: "C_PROJ", name },
        } as unknown as SlackResult;
      }

      if (method === "conversations.canvases.create") {
        return { ok: true, canvas_id: "CANVAS_1" } as unknown as SlackResult;
      }

      if (method === "conversations.info") {
        return conversationsInfoResponse;
      }

      if (method === "canvases.sections.lookup") {
        return canvasSectionsLookupResponse;
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
      getAgentOwnerToken: () => "owner:test-token",
      getLastDmChannel: () => null,
      updateBadge: () => {},
      resolveUser: async (userId) => resolveUser(userId),
      resolveFollowerReplyChannel: (threadTs) => resolveFollowerReplyChannel(threadTs),
      resolveChannel: async (nameOrId) => `resolved:${nameOrId}`,
      rememberChannel: () => {},
      requireToolPolicy: () => {},
      trackOutboundThread: () => {},
      claimThreadOwnership: () => {},
      clearPendingEyes: () => {},
      registerConfirmationRequest: () => ({ status: "created" }),
      getBotUserId: () => "U_BOT",
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
      setResolveUser: (fn: (userId: string) => Promise<string>) => {
        resolveUser = fn;
      },
      setConversationsReplies: (responses: SlackResult[]) => {
        conversationsRepliesResponses = [...responses];
      },
      setUsersListResponse: (response: SlackResult) => {
        usersListResponse = response;
      },
      setConversationsInfoResponse: (response: SlackResult) => {
        conversationsInfoResponse = response;
      },
      setCanvasSectionsLookupResponse: (response: SlackResult) => {
        canvasSectionsLookupResponse = response;
      },
      setPresenceResponse: (userId: string, response: SlackResult) => {
        presenceResponses.set(userId, response);
      },
      setDndResponse: (userId: string, response: SlackResult) => {
        dndResponses.set(userId, response);
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

  it("reports presence and dnd status for a single user", async () => {
    const { tools, setPresenceResponse, setDndResponse, setResolveUser } = setup();
    setResolveUser(async (userId: string) => (userId === "U123" ? "Alice" : userId));
    setPresenceResponse("U123", {
      ok: true,
      presence: "active",
      online: true,
      auto_away: false,
      manual_away: false,
      connection_count: 2,
      last_activity: 1_700_000_000,
    } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: true,
      next_dnd_end_ts: 1_800_000_000,
      snooze_enabled: false,
    } as SlackResult);

    const response = await tools.get("slack_presence")!.execute("tool-4", { user: "U123" });

    expect(response.content?.[0]?.text).toContain("Alice (U123) | presence: active");
    expect(response.content?.[0]?.text).toContain("DND: on until 2027-01-15T08:00:00.000Z");
    expect(response.details?.count).toBe(1);
  });

  it("supports batch presence lookups by name via users.list", async () => {
    const { slack, tools, setUsersListResponse, setPresenceResponse, setDndResponse } = setup();
    setUsersListResponse({
      ok: true,
      members: [
        {
          id: "U123",
          name: "alice",
          real_name: "Alice Example",
          profile: { display_name: "Ali" },
        },
        {
          id: "U456",
          name: "bob",
          real_name: "Bob Example",
          profile: { display_name: "Bobby" },
        },
      ],
      response_metadata: { next_cursor: "" },
    } as SlackResult);
    setPresenceResponse("U123", { ok: true, presence: "active", online: true } as SlackResult);
    setPresenceResponse("U456", { ok: true, presence: "away", online: false } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);
    setDndResponse("U456", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);

    const response = await tools.get("slack_presence")!.execute("tool-5", {
      users: ["Ali", "@bob"],
    });

    expect(slack).toHaveBeenCalledWith("users.list", "xoxb-initial", {
      limit: 1000,
    });
    expect(response.content?.[0]?.text).toContain("Ali (U123)");
    expect(response.content?.[0]?.text).toContain("Bobby (U456)");
    expect(response.details?.count).toBe(2);
  });

  it("caches presence lookups briefly to avoid duplicate Slack API calls", async () => {
    const { slack, tools, setPresenceResponse, setDndResponse, setResolveUser } = setup();
    setResolveUser(async (userId: string) => userId);
    setPresenceResponse("U123", { ok: true, presence: "active", online: true } as SlackResult);
    setDndResponse("U123", {
      ok: true,
      dnd_enabled: false,
      snooze_enabled: false,
    } as SlackResult);

    await tools.get("slack_presence")!.execute("tool-6", { user: "U123" });
    await tools.get("slack_presence")!.execute("tool-7", { user: "U123" });

    expect(slack.mock.calls.filter(([method]) => method === "users.getPresence")).toHaveLength(1);
    expect(slack.mock.calls.filter(([method]) => method === "dnd.info")).toHaveLength(1);
  });

  it("adds reactions with normalized emoji names via slack_react", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_react")!.execute("tool-4", {
      emoji: "✅",
      thread_ts: "123.456",
    });

    expect(slack).toHaveBeenCalledWith("reactions.add", "xoxb-initial", {
      channel: "C-DB",
      timestamp: "123.456",
      name: "white_check_mark",
    });
    expect(response.content?.[0]?.text).toContain("Added :white_check_mark:");
  });

  it("reads the latest bot token and default channel when slack_schedule executes", async () => {
    const { slack, tools, setBotToken, setDefaultChannel } = setup();
    setBotToken("xoxb-reloaded");
    setDefaultChannel("ops-alerts");

    await tools.get("slack_schedule")!.execute("tool-5", {
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
      await tools.get("slack_schedule")!.execute("tool-6", {
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

    const response = await tools.get("slack_pin")!.execute("tool-7", {
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

    const response = await tools.get("slack_pin")!.execute("tool-8", {
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

    const response = await tools.get("slack_bookmark")!.execute("tool-9", {
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

    const response = await tools.get("slack_bookmark")!.execute("tool-10", {
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

    const response = await tools.get("slack_bookmark")!.execute("tool-11", {
      action: "remove",
      bookmark_id: "Bk404",
    });

    expect(slack).toHaveBeenCalledWith("bookmarks.remove", "xoxb-initial", {
      channel_id: "resolved:docs",
      bookmark_id: "Bk404",
    });
    expect(response.details?.status).toBe("not_found");
  });

  it("exports paginated thread content as markdown", async () => {
    const {
      slack,
      tools,
      setConversationsReplies,
      setResolveFollowerReplyChannel,
      setResolveUser,
    } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });
    setResolveUser(async (userId: string) => ({ U123: "alice", U456: "bob" })[userId] ?? userId);
    setConversationsReplies([
      {
        ok: true,
        messages: [
          {
            ts: "123.456",
            user: "U123",
            text: "Hello <@U456>",
          },
        ],
        response_metadata: { next_cursor: "cursor-1" },
      } as SlackResult,
      {
        ok: true,
        messages: [
          {
            ts: "123.789",
            user: "U456",
            text: "See <https://example.com|the doc>",
            files: [
              {
                title: "incident.md",
                filetype: "markdown",
                permalink: "https://files.example/incident.md",
              },
            ],
          },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    const response = await tools.get("slack_export")!.execute("tool-12", {
      thread_ts: "123.456",
      format: "markdown",
    });

    expect(slack).toHaveBeenNthCalledWith(1, "conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 1000,
    });
    expect(slack).toHaveBeenNthCalledWith(2, "conversations.replies", "xoxb-initial", {
      channel: "C-DB",
      ts: "123.456",
      limit: 1000,
      cursor: "cursor-1",
    });
    expect(response.content?.[0]?.text).toContain("# Slack Thread Export");
    expect(response.content?.[0]?.text).toContain("Hello @bob");
    expect(response.content?.[0]?.text).toContain("[the doc](https://example.com)");
    expect(response.content?.[0]?.text).toContain(
      "incident.md (markdown) — https://files.example/incident.md",
    );
    expect(response.details?.count).toBe(2);
  });

  it("filters exported threads by oldest/latest boundaries", async () => {
    const { tools, setConversationsReplies, setDefaultChannel } = setup();
    setDefaultChannel("docs");
    setConversationsReplies([
      {
        ok: true,
        messages: [
          { ts: "100.000001", user: "U100", text: "too early" },
          { ts: "200.000002", user: "U200", text: "keep me" },
          { ts: "300.000003", user: "U300", text: "too late" },
        ],
        response_metadata: { next_cursor: "" },
      } as SlackResult,
    ]);

    const response = await tools.get("slack_export")!.execute("tool-13", {
      thread_ts: "100.000001",
      format: "plain",
      oldest: "150",
      latest: "250",
      channel: "docs",
    });

    expect(response.content?.[0]?.text).toContain("keep me");
    expect(response.content?.[0]?.text).not.toContain("too early");
    expect(response.content?.[0]?.text).not.toContain("too late");
    expect(response.details?.count).toBe(1);
  });

  it("includes blocks when slack_send posts a rich message", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async () => "D123");

    await tools.get("slack_send")!.execute("tool-14", {
      thread_ts: "123.456",
      text: "Deploy complete",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*Deploy complete*" } },
        { type: "actions", elements: [] },
      ],
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "D123",
        thread_ts: "123.456",
        text: "Deploy complete",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Deploy complete*" } },
          { type: "actions", elements: [] },
        ],
      }),
    );
  });

  it("includes blocks when slack_post_channel posts a rich message", async () => {
    const { slack, tools } = setup();

    await tools.get("slack_post_channel")!.execute("tool-15", {
      channel: "deployments",
      text: "Status update",
      blocks: [{ type: "header", text: { type: "plain_text", text: "Deploy status" } }],
    });

    expect(slack).toHaveBeenCalledWith(
      "chat.postMessage",
      "xoxb-initial",
      expect.objectContaining({
        channel: "resolved:deployments",
        text: "Status update",
        blocks: [{ type: "header", text: { type: "plain_text", text: "Deploy status" } }],
      }),
    );
  });

  it("returns structured inbox messages including block action metadata", async () => {
    const { inbox, tools } = setup();
    inbox.push({
      channel: "C123",
      threadTs: "123.456",
      userId: "U123",
      text: 'Clicked Slack "Approve" (action_id: review.approve).',
      timestamp: "123.789",
      metadata: {
        kind: "slack_block_action",
        actionId: "review.approve",
        parsedValue: { decision: "approve" },
      },
    });

    const response = await tools.get("slack_inbox")!.execute("tool-16", {});

    expect(response.content?.[0]?.text).toContain('metadata={"kind":"slack_block_action"');
    expect(response.content?.[0]?.text).toContain('"actionId":"review.approve"');
    expect(response.details).toEqual({
      count: 1,
      messages: [
        {
          channel: "C123",
          threadTs: "123.456",
          userId: "U123",
          text: 'Clicked Slack "Approve" (action_id: review.approve).',
          timestamp: "123.789",
          metadata: {
            kind: "slack_block_action",
            actionId: "review.approve",
            parsedValue: { decision: "approve" },
          },
        },
      ],
    });
  });

  it("builds block kit templates via slack_blocks_build", async () => {
    const { tools } = setup();

    const response = await tools.get("slack_blocks_build")!.execute("tool-17", {
      template: "action_buttons",
      title: "Review",
      text: "Choose an action.",
      buttons: [
        { text: "Approve", action_id: "review.approve", style: "primary", value: "approve" },
        { text: "Reject", action_id: "review.reject", style: "danger", value: "reject" },
      ],
    });

    expect(response.content?.[0]?.text).toContain("Use this JSON as the blocks parameter");
    expect(response.details).toMatchObject({
      template: "action_buttons",
      fallbackText: expect.stringContaining("Choose an action."),
      blocks: [
        { type: "header" },
        { type: "section" },
        { type: "actions", elements: expect.any(Array) },
      ],
    });
  });

  it("builds modal templates via slack_modal_build", async () => {
    const { tools } = setup();

    const response = await tools.get("slack_modal_build")!.execute("tool-18", {
      template: "confirmation",
      title: "Deploy approval",
      text: "Ready to deploy to production.",
      confirm_phrase: "CONFIRM",
      callback_id: "deploy.confirm",
    });

    expect(response.content?.[0]?.text).toContain("Use this JSON as the view parameter");
    expect(response.details).toMatchObject({
      template: "confirmation",
      view: {
        type: "modal",
        callback_id: "deploy.confirm",
        blocks: expect.any(Array),
      },
    });
  });

  it("opens a modal and embeds thread context in private_metadata", async () => {
    const { slack, tools, setResolveFollowerReplyChannel } = setup();
    setResolveFollowerReplyChannel(async (threadTs: string | undefined) => {
      expect(threadTs).toBe("123.456");
      return "C-DB";
    });

    const response = await tools.get("slack_modal_open")!.execute("tool-19", {
      trigger_id: "trigger-1",
      thread_ts: "123.456",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Deploy" },
        submit: { type: "plain_text", text: "Approve" },
        close: { type: "plain_text", text: "Cancel" },
        private_metadata: JSON.stringify({ workflow: "deploy" }),
        blocks: [],
      },
    });

    expect(slack).toHaveBeenCalledWith(
      "views.open",
      "xoxb-initial",
      expect.objectContaining({
        trigger_id: "trigger-1",
        view: expect.objectContaining({
          private_metadata: expect.stringContaining("123.456"),
        }),
      }),
    );
    expect(response.details).toMatchObject({
      thread_ts: "123.456",
      view_id: "V123",
    });
  });

  it("updates a modal by view_id", async () => {
    const { slack, tools } = setup();

    await tools.get("slack_modal_update")!.execute("tool-20", {
      view_id: "V555",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Step 2" },
        submit: { type: "plain_text", text: "Continue" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [],
      },
    });

    expect(slack).toHaveBeenCalledWith(
      "views.update",
      "xoxb-initial",
      expect.objectContaining({
        view_id: "V555",
        view: expect.objectContaining({ type: "modal" }),
      }),
    );
  });

  it("returns structured inbox messages including modal submission metadata", async () => {
    const { inbox, tools } = setup();
    inbox.push({
      channel: "C123",
      threadTs: "123.456",
      userId: "U123",
      text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
      timestamp: "hash-123",
      metadata: {
        kind: "slack_view_submission",
        triggerId: "trigger-1",
        callbackId: "deploy.confirm",
        viewId: "V123",
        stateValues: {
          confirm_phrase: {
            confirm_phrase: { type: "plain_text_input", value: "CONFIRM" },
          },
        },
      },
    });

    const response = await tools.get("slack_inbox")!.execute("tool-21", {});

    expect(response.content?.[0]?.text).toContain('metadata={"kind":"slack_view_submission"');
    expect(response.content?.[0]?.text).toContain('"triggerId":"trigger-1"');
    expect(response.details).toEqual({
      count: 1,
      messages: [
        {
          channel: "C123",
          threadTs: "123.456",
          userId: "U123",
          text: 'Submitted Slack modal (deploy.confirm) "Deploy approval".',
          timestamp: "hash-123",
          metadata: {
            kind: "slack_view_submission",
            triggerId: "trigger-1",
            callbackId: "deploy.confirm",
            viewId: "V123",
            stateValues: {
              confirm_phrase: {
                confirm_phrase: { type: "plain_text_input", value: "CONFIRM" },
              },
            },
          },
        },
      ],
    });
  });

  it("reads canvas markdown by canvas_id", async () => {
    const { slack, tools, setCanvasSectionsLookupResponse } = setup();
    setCanvasSectionsLookupResponse({
      ok: true,
      sections: [
        { id: "temp:C:1", markdown: "# Results" },
        { id: "temp:C:2", markdown: "- Test A ✅\n- Test B ✅" },
      ],
    } as SlackResult);

    const result = await tools.get("slack_canvas_read")!.execute("tool-canvas-read-1", {
      canvas_id: "F123",
    });

    expect(slack).toHaveBeenCalledWith("canvases.sections.lookup", "xoxb-initial", {
      canvas_id: "F123",
    });
    expect(result.content?.[0]?.text).toContain("Read canvas F123.");
    expect(result.content?.[0]?.text).toContain("# Results\n\n- Test A ✅\n- Test B ✅");
    expect(result.details).toEqual({
      canvas_id: "F123",
      channel: undefined,
      markdown: "# Results\n\n- Test A ✅\n- Test B ✅",
      section_count: 2,
      sections: [
        { id: "temp:C:1", markdown: "# Results" },
        { id: "temp:C:2", markdown: "- Test A ✅\n- Test B ✅" },
      ],
    });
  });

  it("reads a channel canvas after resolving canvas_id from conversations.info", async () => {
    const { slack, tools, setCanvasSectionsLookupResponse, setConversationsInfoResponse } = setup();
    setConversationsInfoResponse({
      ok: true,
      channel: {
        id: "resolved:eng",
        properties: { canvas: { id: "FCHAN" } },
      },
    } as SlackResult);
    setCanvasSectionsLookupResponse({
      ok: true,
      sections: [{ id: "temp:C:1", markdown: "Channel notes" }],
    } as SlackResult);

    const result = await tools.get("slack_canvas_read")!.execute("tool-canvas-read-2", {
      channel: "eng",
    });

    expect(slack).toHaveBeenCalledWith("conversations.info", "xoxb-initial", {
      channel: "resolved:eng",
    });
    expect(slack).toHaveBeenCalledWith("canvases.sections.lookup", "xoxb-initial", {
      canvas_id: "FCHAN",
    });
    expect(result.content?.[0]?.text).toContain("Read channel canvas FCHAN for eng.");
    expect(result.details).toMatchObject({
      canvas_id: "FCHAN",
      channel: "resolved:eng",
      markdown: "Channel notes",
      section_count: 1,
    });
  });

  // ─── slack_project_create ─────────────────────────────

  it("creates a project channel with canvas and bot invite in one call", async () => {
    const { slack, tools } = setup();

    const result = await tools.get("slack_project_create")!.execute("tool-proj-1", {
      name: "proj-alpha",
      topic: "Alpha project",
      canvas_title: "Alpha RFC",
      canvas_markdown: "# Overview\nProject goals.",
    });

    expect(slack).toHaveBeenCalledWith("conversations.create", "xoxb-initial", {
      name: "proj-alpha",
    });
    expect(slack).toHaveBeenCalledWith("conversations.setTopic", "xoxb-initial", {
      channel: "C_PROJ",
      topic: "Alpha project",
    });
    expect(slack).toHaveBeenCalledWith(
      "conversations.invite",
      "xoxb-initial",
      expect.objectContaining({ channel: "C_PROJ", users: "U_BOT" }),
    );
    expect(slack).toHaveBeenCalledWith(
      "conversations.canvases.create",
      "xoxb-initial",
      expect.objectContaining({ channel_id: "C_PROJ", title: "Alpha RFC" }),
    );

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.channel_id).toBe("C_PROJ");
    expect(details.channel_name).toBe("proj-alpha");
    expect(details.canvas_id).toBe("CANVAS_1");
    expect(details.bot_invited).toBe(true);
  });

  it("creates project channel even when canvas creation fails", async () => {
    const { slack, tools } = setup();

    // Override slack to fail on canvas creation
    const originalSlack = slack.getMockImplementation()!;
    slack.mockImplementation(
      async (method: string, token: string, body?: Record<string, unknown>) => {
        if (method === "conversations.canvases.create") {
          throw new Error("canvas_error");
        }
        return originalSlack(method, token, body);
      },
    );

    const result = await tools.get("slack_project_create")!.execute("tool-proj-2", {
      name: "proj-beta",
    });

    const details = (result as { details: Record<string, unknown> }).details;
    expect(details.channel_id).toBe("C_PROJ");
    expect(details.canvas_id).toBeNull();
  });
});
