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
  buildAgentDisplayInfo,
  rankAgentsForRouting,
  evaluateRalphLoopCycle,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopFollowUpMessage,
  shouldDeliverRalphLoopFollowUp,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  buildBrokerPromptGuidelines,
  buildIdentityReplyGuidelines,
  resolvePersistedAgentIdentity,
  buildAgentStableId,
  resolveAgentStableId,
  buildSlackRequest,
  stripBotMention,
  isChannelId,
  FORM_METHODS,
  resolveAgentIdentity,
  trackBrokerInboundThread,
  syncFollowerInboxEntries,
  resolveFollowerThreadChannel,
  isDirectMessageChannel,
  getFollowerReconnectUiUpdate,
  getFollowerOwnedThreadClaims,
  normalizeThreadConfirmationState,
  isThreadConfirmationStateEmpty,
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  MAX_PENDING_CONFIRMATION_REQUESTS_PER_THREAD,
  type InboxMessage,
  type AgentDisplayInfo,
  type FollowerThreadState,
  type ThreadConfirmationState,
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
    expect(result).toContain(
      "ACK briefly, do the work, report blockers immediately, report the outcome when done.",
    );
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

// ─── buildBrokerPromptGuidelines ──────────────────────────────

describe("buildBrokerPromptGuidelines", () => {
  it("returns broker-specific coordination guidelines", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    expect(guidelines.length).toBeGreaterThan(0);
    expect(guidelines[0]).toContain("BROKER");
    expect(guidelines[0]).toContain("Solar Mantis");
  });

  it("instructs not to pick up coding tasks", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("DO NOT pick up coding tasks");
  });

  it("instructs to use pinet_message instead of Agent tool", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("pinet_message");
    expect(joined).toContain("DO NOT use the Agent tool");
  });

  it("instructs to check pinet_agents for idle workers", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("pinet_agents");
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

// ─── buildAgentStableId ───────────────────────────────────

describe("buildAgentStableId", () => {
  it("prefers session file when available", () => {
    expect(buildAgentStableId("/tmp/pi/session.json", "macbook", "/repo", "leaf-1")).toBe(
      `macbook:session:${path.resolve("/tmp/pi/session.json")}`,
    );
  });

  it("falls back to leaf id when session file is missing", () => {
    expect(buildAgentStableId(undefined, "macbook", "/repo", "leaf-1")).toBe("macbook:leaf:leaf-1");
  });

  it("falls back to cwd when neither session file nor leaf id is available", () => {
    expect(buildAgentStableId(undefined, "macbook", "/repo")).toBe(
      `macbook:cwd:${path.resolve("/repo")}`,
    );
  });
});

describe("resolveAgentStableId", () => {
  it("prefers the persisted stable id across reloads", () => {
    expect(
      resolveAgentStableId(
        "persisted:agent:123",
        "/tmp/pi/changed-session.json",
        "macbook",
        "/repo",
        "leaf-2",
      ),
    ).toBe("persisted:agent:123");
  });

  it("falls back to buildAgentStableId when no persisted stable id exists", () => {
    expect(resolveAgentStableId(undefined, "/tmp/pi/session.json", "macbook", "/repo")).toBe(
      `macbook:session:${path.resolve("/tmp/pi/session.json")}`,
    );
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

  it("formats health, lease, and capability tags", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🤖",
        name: "Visible Bot",
        id: "agent-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:08.000Z",
        metadata: {
          cwd: "/Users/alice/src/extensions",
          branch: "main",
          host: "macbook",
          capabilities: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            tools: ["test", "lint"],
          },
        },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    const result = formatAgentList([agent], homedir);
    expect(result).toContain("Visible Bot (agent-1) — idle [stale]");
    expect(result).toContain("heartbeat 12s ago · lease in 3s");
    expect(result).toContain(
      "caps: role:worker, repo:extensions, branch:main, tool:test, tool:lint",
    );
  });
});

describe("buildAgentDisplayInfo", () => {
  it("marks a disconnected agent with resumable lease as resumable", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "🤖",
        name: "Resume Bot",
        id: "agent-2",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        disconnectedAt: "2026-01-01T00:00:10.000Z",
        resumableUntil: "2026-01-01T00:00:25.000Z",
        metadata: { role: "worker" },
      },
      { now: Date.parse("2026-01-01T00:00:20.000Z") },
    );

    expect(agent.health).toBe("resumable");
    expect(agent.ghost).toBe(false);
    expect(agent.leaseSummary).toBe("lease in 5s");
  });

  it("marks expired agents as ghosts", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "👻",
        name: "Ghost Bot",
        id: "ghost-1",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: { role: "worker" },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(agent.health).toBe("ghost");
    expect(agent.ghost).toBe(true);
    expect(agent.leaseSummary).toBe("lease expired 5s ago");
  });
});

describe("rankAgentsForRouting", () => {
  it("prefers healthy idle agents that match repo, branch, role, and tools", () => {
    const agents = [
      buildAgentDisplayInfo(
        {
          emoji: "🤖",
          name: "Best Bot",
          id: "best",
          status: "idle",
          lastHeartbeat: "2026-01-01T00:00:18.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["test", "lint"],
            },
          },
        },
        { now: Date.parse("2026-01-01T00:00:20.000Z") },
      ),
      buildAgentDisplayInfo(
        {
          emoji: "🛠️",
          name: "Busy Bot",
          id: "busy",
          status: "working",
          lastHeartbeat: "2026-01-01T00:00:19.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["lint"],
            },
          },
        },
        { now: Date.parse("2026-01-01T00:00:20.000Z") },
      ),
      buildAgentDisplayInfo(
        {
          emoji: "👻",
          name: "Ghost Bot",
          id: "ghost",
          status: "idle",
          lastHeartbeat: "2026-01-01T00:00:00.000Z",
          metadata: {
            repo: "extensions",
            branch: "main",
            role: "worker",
            capabilities: {
              repo: "extensions",
              branch: "main",
              role: "worker",
              tools: ["test", "lint"],
            },
          },
        },
        {
          now: Date.parse("2026-01-01T00:00:20.000Z"),
          heartbeatTimeoutMs: 15_000,
          heartbeatIntervalMs: 5_000,
        },
      ),
    ];

    const ranked = rankAgentsForRouting(agents, {
      repo: "extensions",
      branch: "main",
      role: "worker",
      requiredTools: ["test"],
      task: "run tests on extensions main",
    });

    expect(ranked[0]?.id).toBe("best");
    expect(ranked[ranked.length - 1]?.id).toBe("ghost");
    expect(ranked[0]?.routingReasons).toContain("repo:extensions");
    expect(ranked[0]?.routingReasons).toContain("tools:1/1");
  });
});

// ─── Ralph loop helpers ────────────────────────────────

describe("evaluateRalphLoopCycle", () => {
  it("flags ghost agents, nudges idle agents with work, and reports self-repair anomalies", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦎",
          name: "Idle Gecko",
          id: "idle-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:01:55.000Z",
          pendingInboxCount: 2,
          ownedThreadCount: 1,
        },
        {
          emoji: "🦉",
          name: "Ready Owl",
          id: "ready-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:01:20.000Z",
          lastHeartbeat: "2026-04-01T00:01:55.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
        {
          emoji: "👻",
          name: "Ghost Fox",
          id: "ghost-worker",
          status: "idle",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:00:00.000Z",
          disconnectedAt: "2026-04-01T00:00:10.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        idleWithWorkThresholdMs: 60_000,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
        pendingBacklogCount: 3,
        currentBranch: "feat/not-main",
        brokerHeartbeatActive: false,
        brokerMaintenanceActive: false,
      },
    );

    expect(result.ghostAgentIds).toEqual(["ghost-worker"]);
    expect(result.nudgeAgentIds).toEqual(["idle-worker"]);
    expect(result.idleDrainAgentIds).toEqual(["ready-worker"]);
    expect(result.anomalies).toContain("Idle Gecko idle with assigned work (2 inbox, 1 threads)");
    expect(result.anomalies).toContain("ghost agents detected: ghost-worker");
    expect(result.anomalies).toContain("pending backlog (3) with 1 idle worker");
    expect(result.anomalies).toContain("broker heartbeat timer is not running");
    expect(result.anomalies).toContain("broker maintenance timer is not running");
    expect(result.anomalies.some((item) => item.includes("expected `main`"))).toBe(true);
  });
});

describe("buildRalphLoopNudgeMessage", () => {
  it("formats pending inbox and claimed thread counts", () => {
    expect(buildRalphLoopNudgeMessage(2, 1)).toContain("2 inbox items and 1 claimed thread");
  });
});

describe("buildRalphLoopAnomalySignature", () => {
  it("joins anomalies into a stable dedupe signature", () => {
    expect(
      buildRalphLoopAnomalySignature({
        ghostAgentIds: ["ghost-1"],
        nudgeAgentIds: ["idle-1"],
        idleDrainAgentIds: ["ready-1"],
        anomalies: [
          "ghost agents detected: ghost-1",
          "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        ],
      }),
    ).toBe(
      "ghost agents detected: ghost-1|Idle Gecko idle with assigned work (2 inbox, 1 threads)",
    );
  });
});

describe("shouldDeliverRalphLoopFollowUp", () => {
  it("delivers new actionable findings", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
      }),
    ).toBe(true);
  });

  it("allows the same signature again after cooldown", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredAt: 10_000,
        now: 10_000 + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
      }),
    ).toBe(true);
  });

  it("does not send while a Ralph prompt is already pending", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        pending: true,
      }),
    ).toBe(false);
  });

  it("does not send while the broker is busy", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        idle: false,
      }),
    ).toBe(false);
  });

  it("throttles repeated Ralph follow-ups during cooldown", () => {
    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredAt: 10_000,
        now: 10_000 + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });

  it("keeps cooldown active across a transient clean cycle", () => {
    const deliveredAt = 10_000;

    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "",
        lastDeliveredAt: deliveredAt,
        now: deliveredAt + 15_000,
      }),
    ).toBe(false);

    expect(
      shouldDeliverRalphLoopFollowUp({
        signature: "ghost agents detected: ghost-1",
        lastDeliveredAt: deliveredAt,
        now: deliveredAt + DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });
});

describe("buildRalphLoopFollowUpMessage", () => {
  it("formats actionable anomalies into a broker follow-up prompt", () => {
    expect(
      buildRalphLoopFollowUpMessage({
        ghostAgentIds: ["ghost-1"],
        nudgeAgentIds: ["idle-1"],
        idleDrainAgentIds: ["ready-1"],
        anomalies: [
          "ghost agents detected: ghost-1",
          "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
          "main checkout is on `feat/not-main`, expected `main`",
        ],
      }),
    ).toBe(
      [
        "RALPH LOOP CYCLE:",
        "- ghost agents detected: ghost-1",
        "- Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        "- main checkout is on `feat/not-main`, expected `main`",
        "",
        "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, and repair broker anomalies.",
      ].join("\n"),
    );
  });

  it("returns null when there is nothing actionable", () => {
    expect(
      buildRalphLoopFollowUpMessage({
        ghostAgentIds: [],
        nudgeAgentIds: [],
        idleDrainAgentIds: [],
        anomalies: [],
      }),
    ).toBeNull();
  });
});

// ─── resolvePersistedAgentIdentity / resolveAgentIdentity ───────────────────────────

describe("resolvePersistedAgentIdentity", () => {
  it("prefers persisted identity from session state", () => {
    const result = resolvePersistedAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      "Restored Gecko",
      "🦎",
      "env-nick",
    );
    expect(result).toEqual({ name: "Restored Gecko", emoji: "🦎" });
  });

  it("falls back to generated/config identity when persisted identity is incomplete", () => {
    const result = resolvePersistedAgentIdentity(
      { agentName: "Config Bot", agentEmoji: "🤖" },
      "Half",
      undefined,
    );
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });
});

describe("resolveAgentIdentity", () => {
  it("returns settings name/emoji when both are configured", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" });
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("settings take priority over env nickname", () => {
    const result = resolveAgentIdentity({ agentName: "Config Bot", agentEmoji: "🤖" }, "env-nick");
    expect(result).toEqual({ name: "Config Bot", emoji: "🤖" });
  });

  it("derives the same generated identity for the same seed", () => {
    const first = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    expect(first).toEqual(second);
  });

  it("derives different generated identities for different seeds", () => {
    const first = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, undefined, "/tmp/pi/session-b.json");
    expect(second.name).not.toBe(first.name);
  });

  it("falls back to env var PI_NICKNAME with deterministic emoji when seeded", () => {
    const first = resolveAgentIdentity({}, "my-agent", "/tmp/pi/session-a.json");
    const second = resolveAgentIdentity({}, "my-agent", "/tmp/pi/session-a.json");
    expect(first.name).toBe("my-agent");
    expect(first.emoji).toBe(second.emoji);
  });

  it("generates a name when nothing else is available", () => {
    const result = resolveAgentIdentity({});
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name).toMatch(/^\w+ \w+$/); // "Adjective Animal"
    expect(typeof result.emoji).toBe("string");
  });

  it("ignores settings when only agentName is set (no emoji)", () => {
    const result = resolveAgentIdentity(
      { agentName: "Half Config" },
      undefined,
      "/tmp/pi/session-a.json",
    );
    // Should fall through to generated name since agentEmoji is missing
    expect(result.name).not.toBe("Half Config");
  });

  it("ignores settings when only agentEmoji is set (no name)", () => {
    const result = resolveAgentIdentity({ agentEmoji: "🤖" }, undefined, "/tmp/pi/session-a.json");
    // Should fall through to generated name since agentName is missing
    expect(result.emoji).not.toBe("🤖");
  });
});

// ─── trackBrokerInboundThread ─────────────────────────────

describe("trackBrokerInboundThread", () => {
  it("adds a new thread to the map for a channel mention", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(
      threads,
      { threadId: "1234.5678", channel: "C0APL58LB1R", userId: "U_ALICE" },
      "TestAgent",
    );
    expect(threads.get("1234.5678")).toEqual({
      channelId: "C0APL58LB1R",
      threadTs: "1234.5678",
      userId: "U_ALICE",
      owner: "TestAgent",
    });
  });

  it("does not overwrite an existing thread entry", () => {
    const threads = new Map<string, FollowerThreadState>([
      [
        "1234.5678",
        { channelId: "C0APL58LB1R", threadTs: "1234.5678", userId: "U_ORIGINAL", owner: "First" },
      ],
    ]);
    trackBrokerInboundThread(
      threads,
      { threadId: "1234.5678", channel: "C_OTHER", userId: "U_NEW" },
      "Second",
    );
    expect(threads.get("1234.5678")?.userId).toBe("U_ORIGINAL");
    expect(threads.get("1234.5678")?.owner).toBe("First");
  });

  it("is a no-op when threadId is empty", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "", channel: "C123", userId: "U1" });
    expect(threads.size).toBe(0);
  });

  it("is a no-op when channel is empty", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "1.1", channel: "", userId: "U1" });
    expect(threads.size).toBe(0);
  });

  it("defaults userId to empty string when undefined", () => {
    const threads = new Map<string, FollowerThreadState>();
    trackBrokerInboundThread(threads, { threadId: "1.1", channel: "C1" });
    expect(threads.get("1.1")?.userId).toBe("");
  });
});

// ─── isDirectMessageChannel ───────────────────────────────

describe("isDirectMessageChannel", () => {
  it("recognizes DM channel IDs", () => {
    expect(isDirectMessageChannel("D0APMDC3GNR")).toBe(true);
  });

  it("rejects public channel IDs", () => {
    expect(isDirectMessageChannel("C0APL58LB1R")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isDirectMessageChannel("")).toBe(false);
  });
});

// ─── syncFollowerInboxEntries ─────────────────────────────

describe("syncFollowerInboxEntries", () => {
  it("produces thread updates and inbox messages", () => {
    const threads = new Map<string, FollowerThreadState>();
    const result = syncFollowerInboxEntries(
      [
        {
          message: {
            threadId: "100.1",
            sender: "U_SENDER",
            body: "hello",
            createdAt: "100.1",
            metadata: { channel: "C_CHAN" },
          },
        },
      ],
      threads,
      "MyAgent",
      null,
    );
    expect(result.inboxMessages).toHaveLength(1);
    expect(result.inboxMessages[0].channel).toBe("C_CHAN");
    expect(result.threadUpdates).toHaveLength(1);
    expect(result.threadUpdates[0].channelId).toBe("C_CHAN");
    expect(result.changed).toBe(true);
  });

  it("updates lastDmChannel for DM messages", () => {
    const threads = new Map<string, FollowerThreadState>();
    const result = syncFollowerInboxEntries(
      [
        {
          message: {
            threadId: "200.1",
            sender: "U1",
            body: "dm",
            createdAt: "200.1",
            metadata: { channel: "D0ABC123" },
          },
        },
      ],
      threads,
      "Agent",
      null,
    );
    expect(result.lastDmChannel).toBe("D0ABC123");
  });

  it("returns changed=false when thread already exists with same data", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["300.1", { channelId: "C1", threadTs: "300.1", userId: "U1", owner: "Agent" }],
    ]);
    const result = syncFollowerInboxEntries(
      [
        {
          message: {
            threadId: "300.1",
            sender: "U1",
            body: "repeat",
            createdAt: "300.1",
            metadata: { channel: "C1" },
          },
        },
      ],
      threads,
      "Agent",
      null,
    );
    expect(result.changed).toBe(false);
  });
});

// ─── resolveFollowerThreadChannel ─────────────────────────

describe("resolveFollowerThreadChannel", () => {
  it("returns the local channel without calling the broker", async () => {
    const resolveThread = async () => {
      throw new Error("should not be called");
    };

    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        "follower",
        resolveThread,
      ),
    ).resolves.toEqual({ channelId: "C123", changed: false });
  });

  it("asks the broker for the channel when the follower has no local thread", async () => {
    const result = await resolveFollowerThreadChannel(
      "1234.5678",
      undefined,
      "follower",
      async (threadTs) => {
        expect(threadTs).toBe("1234.5678");
        return "C999";
      },
    );

    expect(result).toEqual({
      channelId: "C999",
      changed: true,
      threadUpdate: {
        channelId: "C999",
        threadTs: "1234.5678",
        userId: "",
        owner: undefined,
      },
    });
  });

  it("returns null when the broker cannot resolve the thread", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", undefined, "follower", async () => null),
    ).resolves.toEqual({ channelId: null, changed: false });
  });

  it("returns null when the broker lookup throws", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", undefined, "follower", async () => {
        throw new Error("broker offline");
      }),
    ).resolves.toEqual({ channelId: null, changed: false });
  });

  it("does not query the broker for non-followers", async () => {
    const resolveThread = async () => {
      throw new Error("should not be called");
    };

    await expect(
      resolveFollowerThreadChannel("1234.5678", undefined, "broker", resolveThread),
    ).resolves.toEqual({ channelId: null, changed: false });
  });
});

// ─── getFollowerReconnectUiUpdate ─────────────────────────

describe("getFollowerReconnectUiUpdate", () => {
  it("notifies on first disconnect", () => {
    const result = getFollowerReconnectUiUpdate("disconnect", false);
    expect(result.nextWasDisconnected).toBe(true);
    expect(result.notify?.level).toBe("warning");
  });

  it("suppresses notification on repeated disconnect", () => {
    const result = getFollowerReconnectUiUpdate("disconnect", true);
    expect(result.nextWasDisconnected).toBe(true);
    expect(result.notify).toBeUndefined();
  });

  it("notifies on reconnect after disconnect", () => {
    const result = getFollowerReconnectUiUpdate("reconnect", true);
    expect(result.nextWasDisconnected).toBe(false);
    expect(result.notify?.level).toBe("info");
  });

  it("suppresses notification on reconnect when not disconnected", () => {
    const result = getFollowerReconnectUiUpdate("reconnect", false);
    expect(result.nextWasDisconnected).toBe(false);
    expect(result.notify).toBeUndefined();
  });
});

// ─── getFollowerOwnedThreadClaims ────────────────────────

describe("getFollowerOwnedThreadClaims", () => {
  it("returns only threads owned by the agent", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "C1", userId: "U1", owner: "Sonic Gecko" }],
      ["t-2", { threadTs: "t-2", channelId: "C2", userId: "U2", owner: "Other Agent" }],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Sonic Gecko")).toEqual([
      { threadTs: "t-1", channelId: "C1" },
    ]);
  });

  it("ignores incomplete thread records", () => {
    const threads = new Map<string, FollowerThreadState>([
      ["t-1", { threadTs: "t-1", channelId: "", userId: "U1", owner: "Sonic Gecko" }],
      ["t-2", { threadTs: "", channelId: "C2", userId: "U2", owner: "Sonic Gecko" }],
    ]);

    expect(getFollowerOwnedThreadClaims(threads, "Sonic Gecko")).toEqual([]);
  });
});

// ─── confirmation state cleanup ─────────────────────────

describe("normalizeThreadConfirmationState", () => {
  function makeState(): ThreadConfirmationState {
    return {
      pending: [],
      approved: [],
      rejected: [],
    };
  }

  it("expires stale pending, approved, and rejected requests", () => {
    const now = Date.now();
    const fresh = now - 1_000;
    const stale = now - DEFAULT_CONFIRMATION_REQUEST_TTL_MS - 1_000;
    const state: ThreadConfirmationState = {
      pending: [
        { toolPattern: "bash", action: "fresh pending", requestedAt: fresh },
        { toolPattern: "edit", action: "stale pending", requestedAt: stale },
      ],
      approved: [
        { toolPattern: "write", action: "fresh approved", requestedAt: fresh },
        { toolPattern: "memory_write", action: "stale approved", requestedAt: stale },
      ],
      rejected: [
        { toolPattern: "bash", action: "fresh rejected", requestedAt: fresh },
        { toolPattern: "edit", action: "stale rejected", requestedAt: stale },
      ],
    };

    expect(normalizeThreadConfirmationState(state, now)).toEqual({
      pending: [{ toolPattern: "bash", action: "fresh pending", requestedAt: fresh }],
      approved: [{ toolPattern: "write", action: "fresh approved", requestedAt: fresh }],
      rejected: [{ toolPattern: "bash", action: "fresh rejected", requestedAt: fresh }],
    });
  });

  it("caps pending requests per thread to the newest entries", () => {
    const now = Date.now();
    const state: ThreadConfirmationState = {
      pending: Array.from(
        { length: MAX_PENDING_CONFIRMATION_REQUESTS_PER_THREAD + 2 },
        (_, idx) => ({
          toolPattern: `tool-${idx}`,
          action: `action-${idx}`,
          requestedAt: now - (MAX_PENDING_CONFIRMATION_REQUESTS_PER_THREAD + 2 - idx) * 1_000,
        }),
      ),
      approved: [],
      rejected: [],
    };

    const result = normalizeThreadConfirmationState(state, now);

    expect(result.pending).toHaveLength(MAX_PENDING_CONFIRMATION_REQUESTS_PER_THREAD);
    expect(result.pending.map((request) => request.toolPattern)).toEqual([
      `tool-2`,
      `tool-3`,
      `tool-4`,
    ]);
  });

  it("detects when a confirmation state is empty", () => {
    expect(isThreadConfirmationStateEmpty(makeState())).toBe(true);
    expect(
      isThreadConfirmationStateEmpty({
        pending: [{ toolPattern: "bash", action: "run", requestedAt: Date.now() }],
        approved: [],
        rejected: [],
      }),
    ).toBe(false);
  });
});
