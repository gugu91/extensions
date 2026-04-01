import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSettings,
  buildAllowlist,
  isUserAllowed,
  formatInboxMessages,
  formatAgentList,
  shortenPath,
  buildIdentityReplyGuidelines,
  buildSlackRequest,
  stripBotMention,
  isChannelId,
  FORM_METHODS,
  resolveAgentIdentity,
  type InboxMessage,
  type AgentDisplayInfo,
} from "./helpers.js";

// ─── loadSettings ─────────────────────────────────────────

describe("loadSettings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object for missing file", () => {
    const result = loadSettings(path.join(tmpDir, "nope.json"));
    expect(result).toEqual({});
  });

  it("returns empty object for invalid JSON", () => {
    const p = path.join(tmpDir, "bad.json");
    fs.writeFileSync(p, "not json{{{");
    expect(loadSettings(p)).toEqual({});
  });

  it("returns empty object when slack-bridge key is missing", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ other: "stuff" }));
    expect(loadSettings(p)).toEqual({});
  });

  it("returns slack-bridge settings", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        botToken: "xoxb-test",
        appToken: "xapp-test",
        autoConnect: true,
        allowedUsers: ["U123"],
        defaultChannel: "C456",
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.botToken).toBe("xoxb-test");
    expect(result.appToken).toBe("xapp-test");
    expect(result.autoConnect).toBe(true);
    expect(result.allowedUsers).toEqual(["U123"]);
    expect(result.defaultChannel).toBe("C456");
  });

  it("returns autoFollow setting", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { autoFollow: true } }));
    const result = loadSettings(p);
    expect(result.autoFollow).toBe(true);
  });

  it("returns autoFollow as undefined when not set", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { botToken: "xoxb-test" } }));
    const result = loadSettings(p);
    expect(result.autoFollow).toBeUndefined();
  });

  it("returns security settings", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        security: {
          readOnly: true,
          requireConfirmation: ["bash", "edit"],
          blockedTools: ["comment_wipe_all"],
        },
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.security).toEqual({
      readOnly: true,
      requireConfirmation: ["bash", "edit"],
      blockedTools: ["comment_wipe_all"],
    });
  });

  it("returns security as undefined when not set", () => {
    const p = path.join(tmpDir, "settings.json");
    fs.writeFileSync(p, JSON.stringify({ "slack-bridge": { botToken: "xoxb-test" } }));
    const result = loadSettings(p);
    expect(result.security).toBeUndefined();
  });

  it("returns suggested prompts", () => {
    const p = path.join(tmpDir, "settings.json");
    const settings = {
      "slack-bridge": {
        suggestedPrompts: [{ title: "Hi", message: "Hello!" }],
      },
    };
    fs.writeFileSync(p, JSON.stringify(settings));
    const result = loadSettings(p);
    expect(result.suggestedPrompts).toEqual([{ title: "Hi", message: "Hello!" }]);
  });
});

// ─── buildAllowlist ───────────────────────────────────────

describe("buildAllowlist", () => {
  it("returns null when no allowlist configured", () => {
    expect(buildAllowlist({}, undefined)).toBeNull();
  });

  it("returns null for empty allowedUsers array", () => {
    expect(buildAllowlist({ allowedUsers: [] }, undefined)).toBeNull();
  });

  it("builds from settings.allowedUsers", () => {
    const result = buildAllowlist({ allowedUsers: ["U1", "U2"] }, undefined);
    expect(result).toEqual(new Set(["U1", "U2"]));
  });

  it("settings takes priority over env var", () => {
    const result = buildAllowlist({ allowedUsers: ["U1"] }, "U2,U3");
    expect(result).toEqual(new Set(["U1"]));
  });

  it("falls back to env var when settings empty", () => {
    const result = buildAllowlist({}, "U2, U3 , U4");
    expect(result).toEqual(new Set(["U2", "U3", "U4"]));
  });

  it("trims and filters empty entries from env var", () => {
    const result = buildAllowlist({}, " U1 , , U2 , ");
    expect(result).toEqual(new Set(["U1", "U2"]));
  });
});

// ─── isUserAllowed ────────────────────────────────────────

describe("isUserAllowed", () => {
  it("allows everyone when allowlist is null", () => {
    expect(isUserAllowed(null, "U_ANYONE")).toBe(true);
  });

  it("allows user in the set", () => {
    expect(isUserAllowed(new Set(["U1", "U2"]), "U1")).toBe(true);
  });

  it("rejects user not in the set", () => {
    expect(isUserAllowed(new Set(["U1"]), "U_INTRUDER")).toBe(false);
  });
});

// ─── formatInboxMessages ──────────────────────────────────

describe("formatInboxMessages", () => {
  const names = new Map([["U1", "will"]]);

  it("formats a DM message", () => {
    const msgs: InboxMessage[] = [
      { channel: "D123", threadTs: "123.456", userId: "U1", text: "hello", timestamp: "123.456" },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("[thread 123.456] will: hello");
    expect(result).toContain("Respond to each via slack_send");
  });

  it("formats a channel mention", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "C789",
        threadTs: "789.012",
        userId: "U1",
        text: "check this",
        timestamp: "789.012",
        isChannelMention: true,
      },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("(channel mention in <#C789>)");
    expect(result).toContain("will: check this");
  });

  it("falls back to userId when name not in map", () => {
    const msgs: InboxMessage[] = [
      {
        channel: "D123",
        threadTs: "111.222",
        userId: "U_UNKNOWN",
        text: "hey",
        timestamp: "111.222",
      },
    ];
    const result = formatInboxMessages(msgs, new Map());
    expect(result).toContain("U_UNKNOWN: hey");
  });

  it("formats multiple messages", () => {
    const msgs: InboxMessage[] = [
      { channel: "D1", threadTs: "1.1", userId: "U1", text: "first", timestamp: "1.1" },
      { channel: "D2", threadTs: "2.2", userId: "U1", text: "second", timestamp: "2.2" },
    ];
    const result = formatInboxMessages(msgs, names);
    expect(result).toContain("will: first");
    expect(result).toContain("will: second");
  });
});

// ─── buildSlackRequest ────────────────────────────────────

describe("buildSlackRequest", () => {
  it("uses JSON for write methods", () => {
    const { url, init } = buildSlackRequest("chat.postMessage", "xoxb-tok", {
      channel: "C1",
      text: "hi",
    });
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ channel: "C1", text: "hi" });
  });

  it("uses form encoding for read methods", () => {
    const { url, init } = buildSlackRequest("conversations.history", "xoxb-tok", {
      channel: "C1",
      limit: 10,
    });
    expect(url).toBe("https://slack.com/api/conversations.history");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(init.body).toContain("channel=C1");
    expect(init.body).toContain("limit=10");
  });

  it("includes auth header", () => {
    const { init } = buildSlackRequest("auth.test", "xoxb-secret");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer xoxb-secret");
  });

  it("handles no body", () => {
    const { init } = buildSlackRequest("auth.test", "xoxb-tok");
    expect(init.body).toBeUndefined();
  });

  it("all FORM_METHODS use form encoding", () => {
    for (const method of FORM_METHODS) {
      const { init } = buildSlackRequest(method, "xoxb-tok", { key: "val" });
      expect((init.headers as Record<string, string>)["Content-Type"]).toContain(
        "application/x-www-form-urlencoded",
      );
    }
  });
});

// ─── stripBotMention ──────────────────────────────────────

describe("stripBotMention", () => {
  it("strips a single mention", () => {
    expect(stripBotMention("<@U_BOT> hello there", "U_BOT")).toBe("hello there");
  });

  it("strips multiple mentions", () => {
    expect(stripBotMention("<@U_BOT> hey <@U_BOT> again", "U_BOT")).toBe("hey again");
  });

  it("leaves text alone when no mention", () => {
    expect(stripBotMention("just text", "U_BOT")).toBe("just text");
  });

  it("handles mention at end", () => {
    expect(stripBotMention("hey <@U_BOT>", "U_BOT")).toBe("hey");
  });

  it("does not strip other users", () => {
    expect(stripBotMention("<@U_OTHER> hello", "U_BOT")).toBe("<@U_OTHER> hello");
  });
});

// ─── isChannelId ──────────────────────────────────────────

describe("isChannelId", () => {
  it("recognizes C-prefix channel IDs", () => {
    expect(isChannelId("C0APL58LB1R")).toBe(true);
  });

  it("recognizes G-prefix group IDs", () => {
    expect(isChannelId("G012ABCDE")).toBe(true);
  });

  it("recognizes D-prefix DM IDs", () => {
    expect(isChannelId("D0APMDC3GNR")).toBe(true);
  });

  it("rejects channel names", () => {
    expect(isChannelId("general")).toBe(false);
    expect(isChannelId("#general")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isChannelId("")).toBe(false);
  });
});

// ─── shortenPath ──────────────────────────────────────────

describe("shortenPath", () => {
  it("replaces homedir prefix with ~", () => {
    expect(shortenPath("/Users/alice/src/project", "/Users/alice")).toBe("~/src/project");
  });

  it("leaves path unchanged when homedir does not match", () => {
    expect(shortenPath("/opt/data/project", "/Users/alice")).toBe("/opt/data/project");
  });

  it("handles exact homedir match", () => {
    expect(shortenPath("/Users/alice", "/Users/alice")).toBe("~");
  });

  it("does not match partial directory names", () => {
    expect(shortenPath("/Users/alicewonder/src", "/Users/alice")).toBe("/Users/alicewonder/src");
  });
});

// ─── buildIdentityReplyGuidelines ─────────────────────────────

describe("buildIdentityReplyGuidelines", () => {
  it("builds strict first-post and follow-up identity guidance", () => {
    const [first, followUp, bareRule] = buildIdentityReplyGuidelines(
      "🦅",
      "Sonic Eagle",
      "~/repo@my-host",
    );

    expect(first).toBe(
      "First message in a new thread: use exact format — '🦅 `Sonic Eagle` reporting from `~/repo@my-host`\\n\\n<message body>'",
    );
    expect(followUp).toBe(
      "Follow-up messages in the same thread: keep the same full identity prefix — '🦅 `Sonic Eagle` <message>'",
    );
    expect(bareRule).toContain("emoji-only");
  });
});

// ─── formatAgentList ──────────────────────────────────────

describe("formatAgentList", () => {
  const homedir = "/Users/alice";

  it("returns placeholder when no agents", () => {
    expect(formatAgentList([], homedir)).toBe("(no agents connected)");
  });

  it("formats a single agent with full metadata", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F9A6}",
        name: "Stellar Otter",
        id: "broker-97446",
        status: "working",
        metadata: { cwd: "/Users/alice/src/extensions", branch: "main", host: "macbook" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe(
      "\u{1F9A6} Stellar Otter (broker-97446) \u2014 working\n   ~/src/extensions (main) @ macbook",
    );
  });

  it("formats multiple agents", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F9A6}",
        name: "Stellar Otter",
        id: "broker-97446",
        status: "working",
        metadata: { cwd: "/Users/alice/src/extensions", branch: "main", host: "macbook" },
      },
      {
        emoji: "\u{1F43A}",
        name: "Crystal Wolf",
        id: "6e3e51ca",
        status: "idle",
        metadata: {
          cwd: "/Users/alice/src/extensions",
          branch: "feat/broker-reconnect",
          host: "macbook",
        },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("\u{1F9A6} Stellar Otter (broker-97446) \u2014 working");
    expect(result).toContain("~/src/extensions (main) @ macbook");
    expect(result).toContain("\u{1F43A} Crystal Wolf (6e3e51ca) \u2014 idle");
    expect(result).toContain("~/src/extensions (feat/broker-reconnect) @ macbook");
  });

  it("handles agent with null metadata", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "idle", metadata: null },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 idle");
    expect(result).not.toContain("\n");
  });

  it("handles agent with empty metadata", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "working", metadata: {} },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 working");
  });

  it("handles partial metadata (only cwd)", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        status: "idle",
        metadata: { cwd: "/opt/project" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("/opt/project");
    expect(result).not.toContain("@");
  });

  it("shortens cwd using homedir", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        status: "idle",
        metadata: { cwd: "/Users/alice/work", branch: "dev", host: "srv" },
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toContain("~/work (dev) @ srv");
  });
});

// ─── resolveAgentIdentity ───────────────────────────

describe("resolveAgentIdentity", () => {
  it("returns settings name/emoji when both are configured", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" });
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("settings take priority over env nickname", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" }, "env-nick");
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("falls back to env var PI_NICKNAME with generated emoji", () => {
    const result = resolveAgentIdentity({}, "my-agent");
    expect(result.name).toBe("my-agent");
    expect(typeof result.emoji).toBe("string");
    expect(result.emoji.length).toBeGreaterThan(0);
  });

  it("generates a random name when nothing else is available", () => {
    const result = resolveAgentIdentity({});
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name).toMatch(/^\w+ \w+$/); // "Adjective Animal"
    expect(typeof result.emoji).toBe("string");
  });

  it("ignores settings when only agentName is set (no emoji)", () => {
    const result = resolveAgentIdentity({ agentName: "Half Config" });
    // Should fall through to generated name since agentEmoji is missing
    expect(result.name).not.toBe("Half Config");
  });

  it("ignores settings when only agentEmoji is set (no name)", () => {
    const result = resolveAgentIdentity({ agentEmoji: "🤖" });
    // Should fall through to generated name since agentName is missing
    expect(result.emoji).not.toBe("🤖");
  });
});
