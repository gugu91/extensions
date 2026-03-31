import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSettings,
  buildAllowlist,
  isUserAllowed,
  formatInboxMessages,
  buildSlackRequest,
  stripBotMention,
  isChannelId,
  FORM_METHODS,
  loadPersistedName,
  persistName,
  resolveAgentIdentity,
  type InboxMessage,
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

// ─── persistName / loadPersistedName ───────────────────

describe("persistName / loadPersistedName", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-identity-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips correctly", () => {
    persistName("Cosmic Fox", "🦊", tmpDir);
    const result = loadPersistedName(tmpDir);
    expect(result).toEqual({ name: "Cosmic Fox", emoji: "🦊" });
  });

  it("returns null for missing file", () => {
    expect(loadPersistedName(tmpDir)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "slack-bridge-identity.json"), "not json");
    expect(loadPersistedName(tmpDir)).toBeNull();
  });

  it("returns null when fields are missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "slack-bridge-identity.json"),
      JSON.stringify({ name: "X" }),
    );
    expect(loadPersistedName(tmpDir)).toBeNull();
  });

  it("creates directory if needed", () => {
    const nested = path.join(tmpDir, "sub", "dir");
    persistName("Neon Owl", "🦉", nested);
    expect(loadPersistedName(nested)).toEqual({ name: "Neon Owl", emoji: "🦉" });
  });
});

// ─── resolveAgentIdentity ───────────────────────────

describe("resolveAgentIdentity", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pinet-resolve-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns settings name/emoji when both are configured", () => {
    const result = resolveAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      undefined,
      tmpDir,
    );
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("settings take priority over persisted name", () => {
    persistName("Old Name", "🐻", tmpDir);
    const result = resolveAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      undefined,
      tmpDir,
    );
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("returns persisted name when file exists", () => {
    persistName("Saved Fox", "🦊", tmpDir);
    const result = resolveAgentIdentity({}, undefined, tmpDir);
    expect(result).toEqual({ name: "Saved Fox", emoji: "🦊" });
  });

  it("persisted name takes priority over env var", () => {
    persistName("Saved Fox", "🦊", tmpDir);
    const result = resolveAgentIdentity({}, "env-nick", tmpDir);
    expect(result).toEqual({ name: "Saved Fox", emoji: "🦊" });
  });

  it("falls back to env var PI_NICKNAME", () => {
    const result = resolveAgentIdentity({}, "my-agent", tmpDir);
    expect(result.name).toBe("my-agent");
    expect(typeof result.emoji).toBe("string");
    expect(result.emoji.length).toBeGreaterThan(0);
    // Should also persist
    const persisted = loadPersistedName(tmpDir);
    expect(persisted).toEqual(result);
  });

  it("generates and persists a new name when nothing else is available", () => {
    const result = resolveAgentIdentity({}, undefined, tmpDir);
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
    expect(typeof result.emoji).toBe("string");
    // Should be persisted
    const persisted = loadPersistedName(tmpDir);
    expect(persisted).toEqual(result);
  });

  it("does not persist when using settings config", () => {
    resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" }, undefined, tmpDir);
    expect(loadPersistedName(tmpDir)).toBeNull();
  });

  it("ignores settings when only agentName is set (no emoji)", () => {
    const result = resolveAgentIdentity({ agentName: "Half Config" }, undefined, tmpDir);
    // Should fall through to generated name since agentEmoji is missing
    expect(result.name).not.toBe("Half Config");
  });
});
