import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseSocketFrame,
  extractThreadStarted,
  classifyMessage,
  parseMemberJoinedChannel,
  SlackAdapter,
  RECONNECT_DELAY_MS,
} from "./slack.js";
import type { OutboundMessage } from "./types.js";

// ─── parseSocketFrame ────────────────────────────────────

describe("parseSocketFrame", () => {
  it("returns null for malformed JSON", () => {
    expect(parseSocketFrame("not json{{{")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSocketFrame("")).toBeNull();
  });

  it("parses a hello frame", () => {
    const frame = JSON.stringify({ type: "hello" });
    const result = parseSocketFrame(frame);
    expect(result).toEqual({ type: "hello" });
  });

  it("parses a disconnect frame", () => {
    const frame = JSON.stringify({ type: "disconnect", reason: "refresh" });
    const result = parseSocketFrame(frame);
    expect(result).toEqual({ type: "disconnect" });
  });

  it("extracts envelope_id", () => {
    const frame = JSON.stringify({
      envelope_id: "abc-123",
      type: "events_api",
      payload: {
        event: { type: "message", text: "hello" },
      },
    });
    const result = parseSocketFrame(frame);
    expect(result?.envelopeId).toBe("abc-123");
  });

  it("extracts event from events_api type", () => {
    const frame = JSON.stringify({
      type: "events_api",
      payload: {
        event: { type: "message", text: "hello", user: "U123" },
      },
    });
    const result = parseSocketFrame(frame);
    expect(result?.event).toEqual({
      type: "message",
      text: "hello",
      user: "U123",
    });
  });

  it("does not extract event from non-events_api types", () => {
    const frame = JSON.stringify({
      type: "hello",
      payload: { event: { type: "message" } },
    });
    const result = parseSocketFrame(frame);
    expect(result?.event).toBeUndefined();
  });

  it("handles missing payload in events_api", () => {
    const frame = JSON.stringify({ type: "events_api" });
    const result = parseSocketFrame(frame);
    expect(result?.event).toBeUndefined();
  });
});

// ─── extractThreadStarted ────────────────────────────────

describe("extractThreadStarted", () => {
  it("returns null when assistant_thread is missing", () => {
    expect(extractThreadStarted({})).toBeNull();
  });

  it("extracts basic thread info", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
      },
    };
    const result = extractThreadStarted(evt);
    expect(result).toEqual({
      channelId: "D123",
      threadTs: "111.222",
      userId: "U456",
    });
  });

  it("extracts context when present", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: {
          channel_id: "C789",
          team_id: "T001",
        },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context).toEqual({
      channelId: "C789",
      teamId: "T001",
    });
  });

  it("defaults teamId to empty string when missing", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: { channel_id: "C789" },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context?.teamId).toBe("");
  });

  it("omits context when context has no channel_id", () => {
    const evt = {
      type: "assistant_thread_started",
      assistant_thread: {
        channel_id: "D123",
        thread_ts: "111.222",
        user_id: "U456",
        context: { team_id: "T001" },
      },
    };
    const result = extractThreadStarted(evt);
    expect(result?.context).toBeUndefined();
  });
});

// ─── classifyMessage ─────────────────────────────────────

describe("classifyMessage", () => {
  const botId = "U_BOT";
  const emptyTracked = new Set<string>();

  it("rejects messages with subtype", () => {
    const evt = {
      type: "message",
      subtype: "channel_join",
      user: "U1",
      text: "joined",
      channel: "C1",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("rejects messages from bots", () => {
    const evt = {
      type: "message",
      bot_id: "B123",
      user: "U1",
      text: "hello",
      channel: "C1",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("rejects untracked channel messages without mention", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "hello",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    expect(classifyMessage(evt, botId, emptyTracked)).toEqual({
      relevant: false,
    });
  });

  it("accepts DM messages", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "hello",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isDM).toBe(true);
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("hello");
      expect(result.threadTs).toBe("1.1");
      expect(result.userId).toBe("U1");
    }
  });

  it("accepts messages in tracked threads", () => {
    const tracked = new Set(["100.200"]);
    const evt = {
      type: "message",
      user: "U1",
      text: "follow up",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "100.200",
      ts: "100.300",
    };
    const result = classifyMessage(evt, botId, tracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.threadTs).toBe("100.200");
      expect(result.isChannelMention).toBe(false);
    }
  });

  it("accepts channel mentions and strips bot mention", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> check this out",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(true);
      expect(result.text).toBe("check this out");
      expect(result.isDM).toBe(false);
    }
  });

  it("does not strip mention in tracked threads", () => {
    const tracked = new Set(["1.1"]);
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hey again",
      channel: "C1",
      channel_type: "channel",
      thread_ts: "1.1",
      ts: "1.2",
    };
    const result = classifyMessage(evt, botId, tracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("<@U_BOT> hey again");
    }
  });

  it("does not strip mention in DMs", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hi from DM",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    expect(result.relevant).toBe(true);
    if (result.relevant) {
      expect(result.isChannelMention).toBe(false);
      expect(result.text).toBe("<@U_BOT> hi from DM");
    }
  });

  it("uses ts as threadTs when thread_ts is absent", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "new DM",
      channel: "D1",
      channel_type: "im",
      ts: "999.111",
    };
    const result = classifyMessage(evt, botId, emptyTracked);
    if (result.relevant) {
      expect(result.threadTs).toBe("999.111");
      expect(result.messageTs).toBe("999.111");
    }
  });

  it("handles null botUserId (no mention detection)", () => {
    const evt = {
      type: "message",
      user: "U1",
      text: "<@U_BOT> hello",
      channel: "C1",
      channel_type: "channel",
      ts: "1.1",
    };
    // With null botUserId, mention detection is disabled
    expect(classifyMessage(evt, null, emptyTracked)).toEqual({
      relevant: false,
    });
  });
});

// ─── parseMemberJoinedChannel ────────────────────────────

describe("parseMemberJoinedChannel", () => {
  it("returns null when user is missing", () => {
    expect(parseMemberJoinedChannel({ channel: "C1" }, "U_BOT")).toBeNull();
  });

  it("returns null when channel is missing", () => {
    expect(parseMemberJoinedChannel({ user: "U1" }, "U_BOT")).toBeNull();
  });

  it("returns isSelf=true when bot joins", () => {
    const result = parseMemberJoinedChannel({ user: "U_BOT", channel: "C1" }, "U_BOT");
    expect(result).toEqual({ channel: "C1", isSelf: true });
  });

  it("returns isSelf=false when another user joins", () => {
    const result = parseMemberJoinedChannel({ user: "U_OTHER", channel: "C1" }, "U_BOT");
    expect(result).toEqual({ channel: "C1", isSelf: false });
  });

  it("handles null botUserId", () => {
    const result = parseMemberJoinedChannel({ user: "U1", channel: "C1" }, null);
    expect(result).toEqual({ channel: "C1", isSelf: false });
  });
});

// ─── SlackAdapter — construction ─────────────────────────

describe("SlackAdapter", () => {
  const baseConfig = {
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
  };

  it("can be constructed with minimal config", () => {
    const adapter = new SlackAdapter(baseConfig);
    expect(adapter.name).toBe("slack");
    expect(adapter.getBotUserId()).toBeNull();
    expect(adapter.getTrackedThreadIds().size).toBe(0);
  });

  it("can be constructed with allowedUsers", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      allowedUsers: ["U1", "U2"],
    });
    expect(adapter.name).toBe("slack");
  });

  it("can be constructed with suggestedPrompts", () => {
    const adapter = new SlackAdapter({
      ...baseConfig,
      suggestedPrompts: [{ title: "Hello", message: "Hi there" }],
    });
    expect(adapter.name).toBe("slack");
  });

  it("registers an inbound handler", () => {
    const adapter = new SlackAdapter(baseConfig);
    const handler = vi.fn();
    adapter.onInbound(handler);
    // handler is registered (can't easily verify without triggering a message)
    expect(adapter.name).toBe("slack");
  });
});

// ─── SlackAdapter — allowlist filtering ──────────────────

describe("SlackAdapter — allowlist filtering", () => {
  it("filters unauthorized users via classifyMessage + isUserAllowed flow", async () => {
    // This tests the integration: classifyMessage marks message as relevant,
    // but the adapter's onMessage checks the allowlist before emitting
    const evt = {
      type: "message",
      user: "U_UNAUTHORIZED",
      text: "hello",
      channel: "D1",
      channel_type: "im",
      ts: "1.1",
    };
    // classifyMessage sees it as relevant (it's a DM)
    const result = classifyMessage(evt, "U_BOT", new Set());
    expect(result.relevant).toBe(true);

    // But the adapter with an allowlist would filter it out
    // (We test the helper directly since the adapter's onMessage is private)
    const { isUserAllowed, buildAllowlist } = await import("../../helpers.js");
    const allowlist = buildAllowlist({ allowedUsers: ["U_AUTHORIZED"] }, undefined);
    expect(isUserAllowed(allowlist, "U_UNAUTHORIZED")).toBe(false);
    expect(isUserAllowed(allowlist, "U_AUTHORIZED")).toBe(true);
  });

  it("allows all users when no allowlist is configured", async () => {
    const { isUserAllowed, buildAllowlist } = await import("../../helpers.js");
    const allowlist = buildAllowlist({}, undefined);
    expect(allowlist).toBeNull();
    expect(isUserAllowed(null, "U_ANYONE")).toBe(true);
  });
});

// ─── SlackAdapter — send (mocked fetch) ─────────────────

describe("SlackAdapter — send", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockSlackResponse(data: Record<string, unknown> = {}) {
    return new Response(JSON.stringify({ ok: true, ...data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("calls chat.postMessage with correct body", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const msg: OutboundMessage = {
      threadId: "100.200",
      channel: "C123",
      text: "Hello from adapter",
    };

    await adapter.send(msg);

    // First call is chat.postMessage; second is assistant.threads.setStatus (fire-and-forget)
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("Hello from adapter");
    expect(body.thread_ts).toBe("100.200");
  });

  it("includes agent metadata when agentName is provided", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    const msg: OutboundMessage = {
      threadId: "100.200",
      channel: "C123",
      text: "Hello",
      agentName: "TestBot",
      agentEmoji: "🤖",
    };

    await adapter.send(msg);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const meta = body.metadata as {
      event_type: string;
      event_payload: Record<string, unknown>;
    };
    expect(meta.event_type).toBe("pi_agent_msg");
    expect(meta.event_payload.agent).toBe("TestBot");
    expect(meta.event_payload.emoji).toBe("🤖");
  });

  it("does not include metadata when no agentName or metadata", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "plain message",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.metadata).toBeUndefined();
  });

  it("uses buildSlackRequest for proper encoding", async () => {
    fetchMock.mockResolvedValue(mockSlackResponse({ message: { ts: "1.1" } }));

    const adapter = new SlackAdapter({
      botToken: "xoxb-secret",
      appToken: "xapp-test",
    });

    await adapter.send({
      threadId: "1.1",
      channel: "C1",
      text: "test",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    // chat.postMessage is a JSON method, not form-encoded
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain("application/json");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-secret");
  });

  it("throws on Slack API error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    await expect(adapter.send({ threadId: "1.1", channel: "C1", text: "test" })).rejects.toThrow(
      "channel_not_found",
    );
  });
});

// ─── SlackAdapter — connect (mocked fetch) ───────────────

describe("SlackAdapter — connect", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws when auth.test fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const adapter = new SlackAdapter({
      botToken: "xoxb-bad",
      appToken: "xapp-test",
    });

    await expect(adapter.connect()).rejects.toThrow("invalid_auth");
  });
});

// ─── SlackAdapter — disconnect ───────────────────────────

describe("SlackAdapter — disconnect", () => {
  it("can disconnect without prior connect", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    // Should not throw
    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});

// ─── SlackAdapter — reconnect scheduling ─────────────────

describe("SlackAdapter — reconnect scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports RECONNECT_DELAY_MS as 5000", () => {
    expect(RECONNECT_DELAY_MS).toBe(5000);
  });

  it("disconnect clears pending reconnect timers", async () => {
    const adapter = new SlackAdapter({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });

    // Manually trigger disconnect to verify timer cleanup
    await adapter.disconnect();

    // Advance timers — nothing should throw or reconnect
    vi.advanceTimersByTime(RECONNECT_DELAY_MS * 2);

    expect(adapter.isConnected()).toBe(false);
  });
});
