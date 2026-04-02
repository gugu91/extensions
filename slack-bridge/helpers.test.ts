import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadSettings,
  buildAllowlist,
  isUserAllowed,
  formatInboxMessages,
  formatPinetInboxMessages,
  parsePinetControlCommand,
  getPinetControlCommandFromText,
  buildPinetControlMetadata,
  extractPinetControlCommand,
  queuePinetRemoteControl,
  finishPinetRemoteControl,
  reloadPinetRuntimeSafely,
  getSqliteJournalMode,
  isSqliteWalEnabled,
  buildSqliteWalFallbackWarning,
  formatAgentList,
  shortenPath,
  buildAgentDisplayInfo,
  rankAgentsForRouting,
  evaluateRalphLoopCycle,
  rewriteRalphLoopGhostAnomalies,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopCycleNotifications,
  buildRalphLoopFollowUpMessage,
  buildRalphLoopStatusMessage,
  shouldDeliverRalphLoopFollowUp,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  isRalphNudgeEntry,
  isAgentToAgentEntry,
  partitionFollowerInboxEntries,
  buildBrokerPromptGuidelines,
  buildWorkerPromptGuidelines,
  buildIdentityReplyGuidelines,
  resolvePersistedAgentIdentity,
  resolveRuntimeAgentIdentity,
  buildAgentStableId,
  resolveAgentStableId,
  isLikelyLocalSubagentContext,
  buildSlackRequest,
  createAbortableOperationTracker,
  abortableDelay,
  stripBotMention,
  isChannelId,
  FORM_METHODS,
  generateAgentName,
  resolveAgentIdentity,
  alignAgentIdentityToRole,
  trackBrokerInboundThread,
  syncFollowerInboxEntries,
  resolveFollowerThreadChannel,
  isDirectMessageChannel,
  getFollowerReconnectUiUpdate,
  getFollowerOwnedThreadClaims,
  normalizeThreadConfirmationState,
  isThreadConfirmationStateEmpty,
  confirmationRequestMatches,
  consumeMatchingConfirmationRequest,
  registerThreadConfirmationRequest,
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  type InboxMessage,
  type AgentDisplayInfo,
  type FollowerThreadState,
  type ThreadConfirmationState,
} from "./helpers.js";

type NudgeTestEntry = {
  inboxId: number;
  message: {
    threadId: string;
    sender: string;
    body: string;
    metadata: Record<string, unknown> | null;
  };
};

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

describe("formatPinetInboxMessages", () => {
  it("formats agent messages with reply guidance", () => {
    const result = formatPinetInboxMessages([
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "Take issue #175",
          metadata: { senderAgent: "Broker Bunny", a2a: true },
        },
      },
    ]);

    expect(result).toContain("New Pinet messages:");
    expect(result).toContain(
      "[thread a2a:broker:worker] broker-id (Broker Bunny): Take issue #175",
    );
    expect(result).toContain("Reply via pinet_message.");
  });

  it("falls back to the sender id when no senderAgent metadata exists", () => {
    const result = formatPinetInboxMessages([
      {
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker-id",
          body: "hello",
          metadata: { a2a: true },
        },
      },
    ]);

    expect(result).toContain("[thread a2a:broker:worker] broker-id: hello");
  });
});

// ─── Pinet control messages ──────────────────────────────

describe("Pinet control helpers", () => {
  it("parses supported control commands", () => {
    expect(parsePinetControlCommand("reload")).toBe("reload");
    expect(parsePinetControlCommand("exit")).toBe("exit");
    expect(parsePinetControlCommand("noop")).toBeNull();
  });

  it("detects control commands from exact message text", () => {
    expect(getPinetControlCommandFromText("/reload")).toBe("reload");
    expect(getPinetControlCommandFromText(" /exit ")).toBe("exit");
    expect(getPinetControlCommandFromText("/exit now please")).toBeNull();
    expect(getPinetControlCommandFromText("please /reload")).toBeNull();
  });

  it("builds structured control metadata", () => {
    expect(buildPinetControlMetadata("reload")).toEqual({
      kind: "pinet_control",
      command: "reload",
    });
  });

  it("extracts structured control commands from a2a messages", () => {
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "hello",
        metadata: { a2a: true, kind: "pinet_control", command: "reload" },
      }),
    ).toBe("reload");
  });

  it("falls back to exact slash commands for a2a messages", () => {
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "/exit",
        metadata: { a2a: true },
      }),
    ).toBe("exit");
    expect(
      extractPinetControlCommand({
        threadId: "a2a:sender:target",
        body: "/exit now please",
        metadata: { a2a: true },
      }),
    ).toBeNull();
  });

  it("ignores slash commands from non-a2a messages", () => {
    expect(
      extractPinetControlCommand({
        threadId: "123.456",
        body: "/reload",
        metadata: { channel: "D123" },
      }),
    ).toBeNull();
  });

  it("queues a retry reload while reload is already running", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: null }, "reload"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "reload",
      accepted: true,
      shouldStartNow: false,
      status: "queued",
    });
  });

  it("prefers a queued exit over a queued reload", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "reload", queuedCommand: "reload" }, "exit"),
    ).toMatchObject({
      currentCommand: "reload",
      queuedCommand: "exit",
      accepted: true,
      shouldStartNow: false,
      status: "queued",
    });
  });

  it("treats later commands as covered once exit is already running", () => {
    expect(
      queuePinetRemoteControl({ currentCommand: "exit", queuedCommand: null }, "reload"),
    ).toMatchObject({
      currentCommand: "exit",
      queuedCommand: null,
      accepted: true,
      shouldStartNow: false,
      status: "covered",
    });
  });

  it("promotes the queued command when the active control finishes", () => {
    expect(finishPinetRemoteControl({ currentCommand: "reload", queuedCommand: "exit" })).toEqual({
      currentCommand: "exit",
      queuedCommand: null,
      nextCommand: "exit",
    });
  });
});

// ─── Safe reload orchestration ───────────────────────────

describe("reloadPinetRuntimeSafely", () => {
  it("restores the snapshot when validation fails after refresh mutates live state", async () => {
    let activeConfig = "previous";
    const restoreState = vi.fn((snapshot: string) => {
      activeConfig = snapshot;
    });
    const stopRuntime = vi.fn(async () => {
      throw new Error("should not stop");
    });

    await expect(
      reloadPinetRuntimeSafely({
        getCurrentRole: () => "broker",
        snapshotState: () => activeConfig,
        restoreState,
        refreshState: () => {
          activeConfig = "refreshed";
        },
        validateRefreshedState: () => {
          throw new Error("bad config");
        },
        stopRuntime,
        startRuntime: async () => {
          throw new Error("should not start");
        },
      }),
    ).rejects.toThrow("bad config");

    expect(activeConfig).toBe("previous");
    expect(restoreState).toHaveBeenCalledWith("previous");
    expect(stopRuntime).not.toHaveBeenCalled();
  });

  it("restores the previous runtime when the refreshed runtime fails to start", async () => {
    let activeConfig = "previous";
    const starts: string[] = [];

    await expect(
      reloadPinetRuntimeSafely({
        getCurrentRole: () => "follower",
        snapshotState: () => activeConfig,
        restoreState: (snapshot) => {
          activeConfig = snapshot;
        },
        refreshState: () => {
          activeConfig = "refreshed";
        },
        validateRefreshedState: () => {},
        stopRuntime: async () => {},
        startRuntime: async (role) => {
          starts.push(`${role}:${activeConfig}`);
          if (activeConfig === "refreshed") {
            throw new Error("refreshed start failed");
          }
        },
      }),
    ).rejects.toThrow("Reload failed: refreshed start failed. Restored the previous runtime.");

    expect(starts).toEqual(["follower:refreshed", "follower:previous"]);
    expect(activeConfig).toBe("previous");
  });
});
// ─── SQLite journal mode helpers ─────────────────────────

describe("SQLite journal mode helpers", () => {
  it("parses the reported journal mode", () => {
    expect(getSqliteJournalMode({ journal_mode: "wal" })).toBe("wal");
    expect(getSqliteJournalMode({ journal_mode: "DELETE" })).toBe("delete");
    expect(getSqliteJournalMode({ journal_mode: null })).toBe("unknown");
    expect(getSqliteJournalMode(undefined)).toBe("unknown");
  });

  it("detects whether WAL is enabled", () => {
    expect(isSqliteWalEnabled({ journal_mode: "wal" })).toBe(true);
    expect(isSqliteWalEnabled({ journal_mode: "delete" })).toBe(false);
    expect(isSqliteWalEnabled(undefined)).toBe(false);
  });

  it("builds a helpful fallback warning", () => {
    expect(buildSqliteWalFallbackWarning("BrokerDB", { journal_mode: "delete" })).toBe(
      "[BrokerDB] SQLite WAL mode not available, using delete journal mode fallback",
    );
    expect(buildSqliteWalFallbackWarning("SqliteCommentStore", undefined)).toContain(
      "using unknown journal mode fallback",
    );
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

// ─── abort / shutdown helpers ───────────────────────────

describe("abortableDelay", () => {
  it("rejects with AbortError when the signal is aborted", async () => {
    const controller = new AbortController();
    const pending = abortableDelay(1_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("createAbortableOperationTracker", () => {
  it("aborts pending operations and waits for them to settle", async () => {
    const tracker = createAbortableOperationTracker();
    const pending = tracker.run(async (signal) => {
      await abortableDelay(60_000, signal);
    });

    await tracker.abortAndWait();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tracker.isAborting()).toBe(true);
  });

  it("rejects new operations after shutdown begins", async () => {
    const tracker = createAbortableOperationTracker();
    await tracker.abortAndWait();

    await expect(tracker.run(async () => Promise.resolve())).rejects.toThrow(
      "shutdown in progress",
    );
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

  it("contains a hard rule against writing code", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("HARD RULE");
    expect(joined).toContain("NEVER WRITE CODE");
  });

  it("lists forbidden actions explicitly", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("FORBIDDEN");
    expect(joined).toContain("Agent tool");
    expect(joined).toContain("edit");
    expect(joined).toContain("write");
    expect(joined).toContain("bash");
  });

  it("lists allowed actions explicitly", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("ALLOWED");
    expect(joined).toContain("Route messages");
    expect(joined).toContain("pinet_agents");
    expect(joined).toContain("pinet_message");
  });

  it("includes a refusal template for coding requests", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("IF ASKED TO CODE");
    expect(joined).toContain("Refuse");
    expect(joined).toContain("delegate");
  });

  it("explains why the constraint exists (mesh stalls)", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("mesh");
    expect(joined).toContain("stall");
  });

  it("instructs to use pinet_message instead of Agent tool", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("pinet_message");
  });

  it("tells broker to never do the work as a fallback", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("NEVER do the work yourself");
  });

  it("includes explicit main-checkout and worktree lifecycle rules", () => {
    const guidelines = buildBrokerPromptGuidelines("🦗", "Solar Mantis");
    const joined = guidelines.join(" ");
    expect(joined).toContain("NEVER checkout a branch in the main repo");
    expect(joined).toContain("git worktree add .worktrees/<name> -b <branch>");
    expect(joined).toContain("git worktree remove .worktrees/<name>");
  });
});

// ─── buildIdentityReplyGuidelines ─────────────────────────────

describe("buildWorkerPromptGuidelines", () => {
  it("includes Pinet delegation guidance for connected workers", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("PINET DELEGATION RULES");
    expect(joined).toContain("pinet_agents");
    expect(joined).toContain("pinet_message");
  });

  it("tells workers not to use the Agent tool for mesh delegation", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("do NOT use the Agent tool");
    expect(joined).toContain("local subagent");
  });

  it("requires delegated work to report status back through the thread", () => {
    const guidelines = buildWorkerPromptGuidelines();
    const joined = guidelines.join(" ");
    expect(joined).toContain("ACKs, blockers, status updates, and final results");
    expect(joined).toContain("ack/work/ask/report");
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

describe("isLikelyLocalSubagentContext", () => {
  it("detects branched or child sessions via parentSession header", () => {
    expect(
      isLikelyLocalSubagentContext({
        sessionHeader: { parentSession: "/tmp/pi/parent-session.jsonl" },
        argv: [],
      }),
    ).toBe(true);
  });

  it("detects headless no-session subagents from argv fallback", () => {
    expect(isLikelyLocalSubagentContext({ argv: ["--mode", "json", "-p", "--no-session"] })).toBe(
      true,
    );
    expect(isLikelyLocalSubagentContext({ argv: ["--mode", "rpc", "--no-session"] })).toBe(true);
  });

  it("does not classify regular interactive sessions as subagents", () => {
    expect(isLikelyLocalSubagentContext({ argv: [] })).toBe(false);
    expect(
      isLikelyLocalSubagentContext({ argv: ["--continue"], sessionHeader: { parentSession: "" } }),
    ).toBe(false);
  });

  it("does not classify plain no-session interactive use as a subagent", () => {
    expect(isLikelyLocalSubagentContext({ argv: ["--no-session"] })).toBe(false);
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

  it("includes pid when present", () => {
    const agents: AgentDisplayInfo[] = [
      {
        emoji: "\u{1F916}",
        name: "Bot",
        id: "abc",
        pid: 12345,
        status: "idle",
        metadata: null,
      },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).toBe("\u{1F916} Bot (abc) \u2014 idle pid:12345");
  });

  it("omits pid when not present", () => {
    const agents: AgentDisplayInfo[] = [
      { emoji: "\u{1F916}", name: "Bot", id: "abc", status: "idle", metadata: null },
    ];
    const result = formatAgentList(agents, homedir);
    expect(result).not.toContain("pid:");
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
            worktreeKind: "main",
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
      "caps: role:worker, repo:extensions, branch:main, checkout:main, tool:test, tool:lint",
    );
  });

  it("shows linked worktree metadata and cleanup guidance for ghost agents", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "👻",
        name: "Ghost Worker",
        id: "ghost-2",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: {
          cwd: "/Users/alice/src/extensions/.worktrees/feat-87/slack-bridge",
          branch: "feat/enforce-worktree-rule",
          host: "macbook",
          repo: "extensions",
          repoRoot: "/Users/alice/src/extensions",
          worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
          worktreeKind: "linked",
          capabilities: {
            repo: "extensions",
            repoRoot: "/Users/alice/src/extensions",
            branch: "feat/enforce-worktree-rule",
            role: "worker",
            worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
            worktreeKind: "linked",
            tools: ["test"],
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
    expect(result).toContain(
      "worktree: ~/src/extensions/.worktrees/feat-87 (main: ~/src/extensions)",
    );
    expect(result).toContain("cleanup: git worktree remove ~/src/extensions/.worktrees/feat-87");
  });
});

describe("buildAgentDisplayInfo", () => {
  it("passes pid through to display info", () => {
    const agent = buildAgentDisplayInfo(
      { emoji: "\u{1F916}", name: "Bot", id: "a1", pid: 42, status: "idle" },
      { now: Date.now() },
    );
    expect(agent.pid).toBe(42);
  });

  it("omits pid when not provided", () => {
    const agent = buildAgentDisplayInfo(
      { emoji: "\u{1F916}", name: "Bot", id: "a1", status: "idle" },
      { now: Date.now() },
    );
    expect(agent.pid).toBeUndefined();
  });

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

  it("flags ghost linked worktrees for cleanup", () => {
    const agent = buildAgentDisplayInfo(
      {
        emoji: "👻",
        name: "Ghost Bot",
        id: "ghost-worktree",
        status: "idle",
        lastHeartbeat: "2026-01-01T00:00:00.000Z",
        metadata: {
          role: "worker",
          repoRoot: "/Users/alice/src/extensions",
          worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
          worktreeKind: "linked",
          capabilities: {
            role: "worker",
            repo: "extensions",
            repoRoot: "/Users/alice/src/extensions",
            worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
            worktreeKind: "linked",
          },
        },
      },
      {
        now: Date.parse("2026-01-01T00:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(agent.cleanupWorktreePath).toBe("/Users/alice/src/extensions/.worktrees/feat-87");
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

  it("flags orphaned linked worktrees for cleanup", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "👻",
          name: "Ghost Fox",
          id: "ghost-worker",
          status: "idle",
          metadata: {
            role: "worker",
            repo: "extensions",
            repoRoot: "/Users/alice/src/extensions",
            worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
            worktreeKind: "linked",
            capabilities: {
              role: "worker",
              repo: "extensions",
              repoRoot: "/Users/alice/src/extensions",
              worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
              worktreeKind: "linked",
            },
          },
          lastSeen: "2026-04-01T00:00:00.000Z",
          lastHeartbeat: "2026-04-01T00:00:00.000Z",
          disconnectedAt: "2026-04-01T00:00:10.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:02:00.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.anomalies).toContain(
      "orphaned worktree cleanup: Ghost Fox at `/Users/alice/src/extensions/.worktrees/feat-87`",
    );
  });

  it("detects stuck agents: working with no activity for > threshold", () => {
    const now = Date.parse("2026-04-01T00:10:00.000Z");
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐺",
          name: "Stuck Wolf",
          id: "stuck-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:03:00.000Z", // 7 min ago
          pendingInboxCount: 0,
          ownedThreadCount: 1,
        },
        {
          emoji: "🦊",
          name: "Active Fox",
          id: "active-worker",
          status: "working",
          metadata: { role: "worker" },
          lastSeen: "2026-04-01T00:09:55.000Z",
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:09:30.000Z", // 30s ago
          pendingInboxCount: 1,
          ownedThreadCount: 0,
        },
      ],
      {
        now,
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual(["stuck-worker"]);
    expect(result.anomalies.some((a) => a.includes("Stuck Wolf appears stuck"))).toBe(true);
    // Active Fox should NOT be flagged as stuck
    expect(result.stuckAgentIds).not.toContain("active-worker");
  });

  it("does not flag idle agents as stuck", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🦉",
          name: "Idle Owl",
          id: "idle-1",
          status: "idle",
          metadata: { role: "worker" },
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          lastActivity: "2026-04-01T00:01:00.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
  });

  it("does not flag working agent without lastActivity as stuck", () => {
    const result = evaluateRalphLoopCycle(
      [
        {
          emoji: "🐼",
          name: "New Panda",
          id: "new-1",
          status: "working",
          metadata: { role: "worker" },
          lastHeartbeat: "2026-04-01T00:09:55.000Z",
          // no lastActivity — agent just started, hasn't reported activity yet
          pendingInboxCount: 1,
          ownedThreadCount: 0,
        },
      ],
      {
        now: Date.parse("2026-04-01T00:10:00.000Z"),
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
    );

    expect(result.stuckAgentIds).toEqual([]);
  });

  it("includes stuckAgentIds in result even when empty", () => {
    const result = evaluateRalphLoopCycle([], {
      now: Date.now(),
      heartbeatTimeoutMs: 15_000,
      heartbeatIntervalMs: 5_000,
    });
    expect(result.stuckAgentIds).toEqual([]);
  });
});

describe("rewriteRalphLoopGhostAnomalies", () => {
  const buildEvaluation = (ghostAgentIds: string[], anomalies: string[]) => ({
    ghostAgentIds,
    nudgeAgentIds: [],
    idleDrainAgentIds: [],
    stuckAgentIds: [],
    anomalies,
  });

  it("only surfaces ghost deltas while keeping non-ghost anomalies stable across cycles", () => {
    const cycle1 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"], ["ghost agents detected: ghost-1"]),
    );
    expect(cycle1.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-1"]);
    expect(cycle1.nextReportedGhostIds).toEqual(["ghost-1"]);

    const cycle2 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"], ["ghost agents detected: ghost-1"]),
      cycle1.nextReportedGhostIds,
    );
    expect(cycle2.evaluation.anomalies).toEqual([]);
    expect(buildRalphLoopAnomalySignature(cycle2.evaluation)).toBe("");

    const cycle3 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(
        ["ghost-1"],
        ["ghost agents detected: ghost-1", "pending backlog (3) with 1 idle worker"],
      ),
      cycle2.nextReportedGhostIds,
    );
    expect(cycle3.evaluation.anomalies).toEqual(["pending backlog (3) with 1 idle worker"]);
    expect(cycle3.nonGhostAnomalies).toEqual(["pending backlog (3) with 1 idle worker"]);

    const cycle4 = rewriteRalphLoopGhostAnomalies(
      buildEvaluation([], []),
      cycle3.nextReportedGhostIds,
    );
    expect(cycle4.evaluation.anomalies).toEqual(["ghost agents cleared from registry: ghost-1"]);
    expect(cycle4.clearedGhostIds).toEqual(["ghost-1"]);
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
        stuckAgentIds: [],
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

describe("buildRalphLoopStatusMessage", () => {
  it("formats inline Ralph notifications with the captured cycle timestamp", () => {
    expect(
      buildRalphLoopStatusMessage(
        "ghost agents detected: ghost-1; Idle Gecko idle with assigned work",
        "2026-04-02T14:10:00.000Z",
      ),
    ).toBe(
      "RALPH loop (2026-04-02T14:10:00.000Z): ghost agents detected: ghost-1; Idle Gecko idle with assigned work",
    );
  });
});

describe("buildRalphLoopCycleNotifications", () => {
  it("threads the captured cycle timestamp through follow-up and inline status output", () => {
    expect(
      buildRalphLoopCycleNotifications(
        {
          ghostAgentIds: ["ghost-1"],
          nudgeAgentIds: ["idle-1"],
          idleDrainAgentIds: ["ready-1"],
          stuckAgentIds: [],
          anomalies: [
            "ghost agents detected: ghost-1",
            "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
          ],
        },
        "2026-04-02T14:10:00.000Z",
      ),
    ).toEqual({
      followUpPrompt: [
        "RALPH LOOP CYCLE:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- ghost agents detected: ghost-1",
        "- Idle Gecko idle with assigned work (2 inbox, 1 threads)",
        "",
        "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, and repair broker anomalies.",
      ].join("\n"),
      anomalyStatus:
        "RALPH loop (2026-04-02T14:10:00.000Z): ghost agents detected: ghost-1; Idle Gecko idle with assigned work (2 inbox, 1 threads)",
      recoveryStatus: "RALPH loop (2026-04-02T14:10:00.000Z): health recovered",
    });
  });
});

describe("buildRalphLoopFollowUpMessage", () => {
  it("formats actionable anomalies into a broker follow-up prompt", () => {
    expect(
      buildRalphLoopFollowUpMessage(
        {
          ghostAgentIds: ["ghost-1"],
          nudgeAgentIds: ["idle-1"],
          idleDrainAgentIds: ["ready-1"],
          stuckAgentIds: [],
          anomalies: [
            "ghost agents detected: ghost-1",
            "Idle Gecko idle with assigned work (2 inbox, 1 threads)",
            "main checkout is on `feat/not-main`, expected `main`",
          ],
        },
        "2026-04-02T14:10:00.000Z",
      ),
    ).toBe(
      [
        "RALPH LOOP CYCLE:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
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
      buildRalphLoopFollowUpMessage(
        {
          ghostAgentIds: [],
          nudgeAgentIds: [],
          idleDrainAgentIds: [],
          stuckAgentIds: [],
          anomalies: [],
        },
        "2026-04-02T14:10:00.000Z",
      ),
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

  it("generates a worker name when nothing else is available", () => {
    const result = resolveAgentIdentity({});
    expect(typeof result.name).toBe("string");
    expect(result.name.length).toBeGreaterThan(0);
    expect(result.name).toMatch(/^\w+ \w+ \w+$/); // "Adjective Color Animal"
    expect(typeof result.emoji).toBe("string");
  });

  it("generates a broker name when requested", () => {
    const result = resolveAgentIdentity({}, undefined, "/tmp/pi/session-a.json", "broker");
    expect(result.name).toMatch(/^The Broker \w+$/);
    expect(typeof result.emoji).toBe("string");
  });

  it("keeps the same animal and emoji across worker and broker generated names", () => {
    const worker = generateAgentName("/tmp/pi/session-a.json");
    const broker = generateAgentName("/tmp/pi/session-a.json", "broker");
    expect(broker.name).toBe(`The Broker ${worker.name.split(" ").at(-1)}`);
    expect(broker.emoji).toBe(worker.emoji);
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

describe("alignAgentIdentityToRole", () => {
  it("switches generated identities to the broker format", () => {
    const seed = "/tmp/pi/session-a.json";
    const workerIdentity = resolveAgentIdentity({}, undefined, seed, "worker");

    expect(alignAgentIdentityToRole(workerIdentity, {}, undefined, seed, "broker")).toEqual(
      resolveAgentIdentity({}, undefined, seed, "broker"),
    );
  });

  it("preserves custom renamed identities when the role changes", () => {
    const currentIdentity = { name: "Custom Bot", emoji: "🤖" };

    expect(
      alignAgentIdentityToRole(currentIdentity, {}, undefined, "/tmp/pi/session-a.json", "broker"),
    ).toEqual(currentIdentity);
  });
});

describe("resolveRuntimeAgentIdentity", () => {
  it("preserves custom runtime names when no explicit config overrides exist", () => {
    const currentIdentity = { name: "Custom Bot", emoji: "🤖" };

    expect(
      resolveRuntimeAgentIdentity(
        currentIdentity,
        {},
        undefined,
        "/tmp/pi/session-a.json",
        "broker",
      ),
    ).toEqual(currentIdentity);
  });

  it("still honors explicit configured identities", () => {
    expect(
      resolveRuntimeAgentIdentity(
        { name: "Custom Bot", emoji: "🤖" },
        { agentName: "Config Bot", agentEmoji: "🛠️" },
        undefined,
        "/tmp/pi/session-a.json",
        "broker",
      ),
    ).toEqual({ name: "Config Bot", emoji: "🛠️" });
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
          inboxId: 17,
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
    expect(result.inboxMessages[0].brokerInboxId).toBe(17);
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
  it("prefers the resolver result over a stale local channel cache", async () => {
    const resolveThread = vi.fn(async (threadTs: string) => {
      expect(threadTs).toBe("1234.5678");
      return "C999";
    });

    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        resolveThread,
      ),
    ).resolves.toEqual({
      channelId: "C999",
      changed: true,
      threadUpdate: {
        channelId: "C999",
        threadTs: "1234.5678",
        userId: "U1",
        owner: "Bot",
      },
    });
    expect(resolveThread).toHaveBeenCalledWith("1234.5678");
  });

  it("returns the resolver result without a cache update when it matches local state", async () => {
    const resolveThread = vi.fn(async () => "C123");

    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        resolveThread,
      ),
    ).resolves.toEqual({ channelId: "C123", changed: false });
    expect(resolveThread).toHaveBeenCalledWith("1234.5678");
  });

  it("asks the resolver for the channel when there is no local thread cache", async () => {
    const result = await resolveFollowerThreadChannel("1234.5678", undefined, async (threadTs) => {
      expect(threadTs).toBe("1234.5678");
      return "C999";
    });

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

  it("returns null when the resolver cannot find the thread, even if local cache exists", async () => {
    await expect(
      resolveFollowerThreadChannel(
        "1234.5678",
        { channelId: "C123", threadTs: "1234.5678", userId: "U1", owner: "Bot" },
        async () => null,
      ),
    ).resolves.toEqual({
      channelId: null,
      changed: false,
    });
  });

  it("returns null when the resolver throws", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", undefined, async () => {
        throw new Error("broker offline");
      }),
    ).resolves.toEqual({ channelId: null, changed: false });
  });

  it("falls back to the local cache when no resolver is available", async () => {
    await expect(
      resolveFollowerThreadChannel("1234.5678", {
        channelId: "C123",
        threadTs: "1234.5678",
        userId: "U1",
        owner: "Bot",
      }),
    ).resolves.toEqual({
      channelId: "C123",
      changed: false,
    });
  });

  it("returns null when no resolver or local cache is available", async () => {
    await expect(resolveFollowerThreadChannel("1234.5678", undefined)).resolves.toEqual({
      channelId: null,
      changed: false,
    });
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

  it("clears ambiguous pending requests instead of guessing which one a reply belongs to", () => {
    const now = Date.now();
    const state: ThreadConfirmationState = {
      pending: [
        { toolPattern: "bash", action: "first", requestedAt: now - 2_000 },
        { toolPattern: "edit", action: "second", requestedAt: now - 1_000 },
      ],
      approved: [],
      rejected: [],
    };

    expect(normalizeThreadConfirmationState(state, now).pending).toEqual([]);
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

describe("confirmationRequestMatches", () => {
  it("matches only when both tool pattern and action line up", () => {
    const request = {
      toolPattern: "bash",
      action: "run: echo hello",
      requestedAt: Date.now(),
    };

    expect(confirmationRequestMatches(request, "bash", "run: echo hello")).toBe(true);
    expect(confirmationRequestMatches(request, "bash", "run: echo goodbye")).toBe(false);
    expect(confirmationRequestMatches(request, "edit", "run: echo hello")).toBe(false);
  });
});

describe("consumeMatchingConfirmationRequest", () => {
  it("consumes only the exact approved or rejected action", () => {
    const list = [
      { toolPattern: "bash", action: "run: echo hello", requestedAt: Date.now() - 2_000 },
      { toolPattern: "bash", action: "run: echo goodbye", requestedAt: Date.now() - 1_000 },
    ];

    const consumed = consumeMatchingConfirmationRequest(list, "bash", "run: echo goodbye");

    expect(consumed?.action).toBe("run: echo goodbye");
    expect(list.map((request) => request.action)).toEqual(["run: echo hello"]);
    expect(consumeMatchingConfirmationRequest(list, "bash", "run: echo unknown")).toBeNull();
  });
});

describe("registerThreadConfirmationRequest", () => {
  it("creates a new pending request when the thread is clear", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      { pending: [], approved: [], rejected: [] },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("created");
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });

  it("refreshes an identical pending request without duplicating it", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 }],
        approved: [],
        rejected: [],
      },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("refreshed");
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });

  it("rejects a different pending request so a plain yes/no cannot bind to the wrong action", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 }],
        approved: [],
        rejected: [],
      },
      { toolPattern: "edit", action: "edit: README.md", requestedAt: now },
      now,
    );

    expect(result.status).toBe("conflict");
    expect(result.conflict).toEqual({
      toolPattern: "bash",
      action: "run: ls",
      requestedAt: now - 5_000,
    });
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now - 5_000 },
    ]);
  });

  it("drops stale matching approvals when requesting a fresh confirmation for the same action", () => {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      {
        pending: [],
        approved: [{ toolPattern: "bash", action: "run: ls", requestedAt: now - 2_000 }],
        rejected: [{ toolPattern: "bash", action: "run: cat", requestedAt: now - 1_000 }],
      },
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
      now,
    );

    expect(result.status).toBe("created");
    expect(result.state.approved).toEqual([]);
    expect(result.state.rejected).toEqual([
      { toolPattern: "bash", action: "run: cat", requestedAt: now - 1_000 },
    ]);
    expect(result.state.pending).toEqual([
      { toolPattern: "bash", action: "run: ls", requestedAt: now },
    ]);
  });
});

// ─── Follower nudge partition (#102) ──────────────────────

describe("isRalphNudgeEntry", () => {
  it("returns true for entries with ralph_loop_nudge kind", () => {
    const entry: NudgeTestEntry = {
      inboxId: 1,
      message: {
        threadId: "a2a:broker:worker",
        sender: "broker-id",
        body: "RALPH LOOP nudge: you appear idle",
        metadata: { kind: "ralph_loop_nudge", targetAgentId: "worker-id" },
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(true);
  });

  it("returns false for regular messages", () => {
    const entry: NudgeTestEntry = {
      inboxId: 2,
      message: {
        threadId: "t-1",
        sender: "U123",
        body: "hello",
        metadata: { channel: "C456" },
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(false);
  });

  it("returns false for entries with null metadata", () => {
    const entry: NudgeTestEntry = {
      inboxId: 3,
      message: {
        threadId: "t-2",
        sender: "U456",
        body: "test",
        metadata: null,
      },
    };
    expect(isRalphNudgeEntry(entry)).toBe(false);
  });
});

describe("isAgentToAgentEntry", () => {
  it("returns true for a2a thread ids", () => {
    const entry: NudgeTestEntry = {
      inboxId: 1,
      message: {
        threadId: "a2a:broker:worker",
        sender: "broker",
        body: "do work",
        metadata: null,
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(true);
  });

  it("returns true when a2a metadata is set", () => {
    const entry: NudgeTestEntry = {
      inboxId: 2,
      message: {
        threadId: "thread-1",
        sender: "broker",
        body: "do work",
        metadata: { a2a: true },
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(true);
  });

  it("returns false for regular slack threads", () => {
    const entry: NudgeTestEntry = {
      inboxId: 3,
      message: {
        threadId: "1712073599.123456",
        sender: "U123",
        body: "hello",
        metadata: { channel: "C456" },
      },
    };

    expect(isAgentToAgentEntry(entry)).toBe(false);
  });
});

describe("partitionFollowerInboxEntries", () => {
  it("separates nudges, agent messages, and regular slack messages", () => {
    const entries: NudgeTestEntry[] = [
      {
        inboxId: 1,
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker",
          body: "RALPH LOOP nudge",
          metadata: { kind: "ralph_loop_nudge" },
        },
      },
      {
        inboxId: 2,
        message: {
          threadId: "1712073599.123456",
          sender: "U123",
          body: "hello",
          metadata: { channel: "C456" },
        },
      },
      {
        inboxId: 3,
        message: {
          threadId: "a2a:broker:worker",
          sender: "broker",
          body: "please take #175",
          metadata: { a2a: true, senderAgent: "Broker Bunny" },
        },
      },
    ];

    const result = partitionFollowerInboxEntries(entries);
    expect(result.nudges).toHaveLength(1);
    expect(result.agentMessages).toHaveLength(1);
    expect(result.regular).toHaveLength(1);
    expect(result.nudges[0].inboxId).toBe(1);
    expect(result.agentMessages[0].inboxId).toBe(3);
    expect(result.regular[0].inboxId).toBe(2);
  });

  it("returns empty arrays when no entries", () => {
    const result = partitionFollowerInboxEntries([]);
    expect(result.nudges).toEqual([]);
    expect(result.agentMessages).toEqual([]);
    expect(result.regular).toEqual([]);
  });

  it("puts all entries in regular when no nudges or agent messages", () => {
    const entries: NudgeTestEntry[] = [
      {
        inboxId: 1,
        message: {
          threadId: "t-1",
          sender: "U1",
          body: "msg",
          metadata: null,
        },
      },
    ];
    const result = partitionFollowerInboxEntries(entries);
    expect(result.nudges).toEqual([]);
    expect(result.agentMessages).toEqual([]);
    expect(result.regular).toHaveLength(1);
  });
});

// ─── buildAgentDisplayInfo observability fields (#103) ────────

describe("buildAgentDisplayInfo observability fields", () => {
  const now = Date.parse("2026-04-01T00:10:00.000Z");

  it("includes idleSince and formats idle duration", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🦉",
        name: "Idle Owl",
        id: "owl-1",
        status: "idle",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
        idleSince: "2026-04-01T00:05:00.000Z", // 5 min ago
      },
      { now },
    );

    expect(info.idleSince).toBe("2026-04-01T00:05:00.000Z");
    expect(info.idleDuration).toBe("5m ago");
    expect(info.stuck).toBe(false);
  });

  it("includes lastActivity and formats activity age", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🐺",
        name: "Working Wolf",
        id: "wolf-1",
        status: "working",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
        lastActivity: "2026-04-01T00:08:00.000Z", // 2 min ago
      },
      { now },
    );

    expect(info.lastActivity).toBe("2026-04-01T00:08:00.000Z");
    expect(info.lastActivityAge).toBe("2m ago");
    expect(info.stuck).toBe(false);
  });

  it("handles null idleSince and lastActivity", () => {
    const info = buildAgentDisplayInfo(
      {
        emoji: "🐼",
        name: "New Panda",
        id: "panda-1",
        status: "idle",
        lastHeartbeat: "2026-04-01T00:09:55.000Z",
      },
      { now },
    );

    expect(info.idleSince).toBeNull();
    expect(info.lastActivity).toBeNull();
    expect(info.idleDuration).toBeNull();
    expect(info.lastActivityAge).toBeNull();
  });
});
