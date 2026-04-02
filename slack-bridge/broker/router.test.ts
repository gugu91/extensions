import { describe, it, expect, beforeEach } from "vitest";
import { MessageRouter, findAgentMention } from "./router.js";
import type {
  AgentInfo,
  BrokerDBInterface,
  ChannelAssignment,
  InboundMessage,
  ThreadInfo,
} from "./types.js";

// ─── In-memory BrokerDBInterface stub ─────────────────────────────

class StubBrokerDBInterface implements BrokerDBInterface {
  threads = new Map<string, ThreadInfo>();
  agents: AgentInfo[] = [];
  channelAssignments = new Map<string, ChannelAssignment>();
  allowedUsers: Set<string> | null = null;
  inbox: Array<{ agentId: string; message: InboundMessage }> = [];

  getThread(threadId: string): ThreadInfo | null {
    return this.threads.get(threadId) ?? null;
  }

  getAgentById(agentId: string): AgentInfo | null {
    return this.agents.find((agent) => agent.id === agentId) ?? null;
  }

  getAgents(): AgentInfo[] {
    return this.agents.filter((agent) => !agent.disconnectedAt);
  }

  getChannelAssignment(channel: string): ChannelAssignment | null {
    return this.channelAssignments.get(channel) ?? null;
  }

  getAllowedUsers(): Set<string> | null {
    return this.allowedUsers;
  }

  createThread(thread: ThreadInfo): void {
    this.threads.set(thread.threadId, thread);
  }

  updateThread(threadId: string, updates: Partial<ThreadInfo>): void {
    const existing = this.threads.get(threadId);
    if (!existing) {
      // Upsert: create with defaults
      const now = new Date().toISOString();
      this.threads.set(threadId, {
        threadId,
        source: updates.source ?? "slack",
        channel: updates.channel ?? "",
        ownerAgent: updates.ownerAgent !== undefined ? updates.ownerAgent : null,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    this.threads.set(threadId, { ...existing, ...updates });
  }

  claimThread(threadId: string, agentId: string, source = "slack", channel = ""): boolean {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (existing.ownerAgent && existing.ownerAgent !== agentId) {
        return false;
      }
      this.threads.set(threadId, { ...existing, ownerAgent: agentId });
      return true;
    }
    const now = new Date().toISOString();
    this.threads.set(threadId, {
      threadId,
      source,
      channel,
      ownerAgent: agentId,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  queueMessage(agentId: string, message: InboundMessage): void {
    this.inbox.push({ agentId, message });
  }
}

// ─── Test helpers ────────────────────────────────────────

function makeAgent(overrides: Partial<AgentInfo> & { id: string; name: string }): AgentInfo {
  return {
    emoji: "🤖",
    pid: 1000,
    connectedAt: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-01T00:00:00Z",
    lastHeartbeat: "2026-01-01T00:00:00Z",
    metadata: null,
    status: "idle",
    ...overrides,
  };
}

function makeThread(overrides: Partial<ThreadInfo> & { threadId: string }): ThreadInfo {
  return {
    source: "slack",
    channel: "C001",
    ownerAgent: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    source: "slack",
    threadId: "t-100",
    channel: "C001",
    userId: "U001",
    text: "Hello",
    timestamp: "1700000000.000000",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────

describe("findAgentMention", () => {
  const agents = [
    makeAgent({ id: "a1", name: "CodeBot" }),
    makeAgent({ id: "a2", name: "ReviewBot" }),
  ];

  it("finds agent mentioned in text (case-insensitive)", () => {
    expect(findAgentMention("hey codebot, help me", agents)?.id).toBe("a1");
  });

  it("finds agent with @-prefix style", () => {
    expect(findAgentMention("@ReviewBot check this PR", agents)?.id).toBe("a2");
  });

  it("returns null when no agent mentioned", () => {
    expect(findAgentMention("just a regular message", agents)).toBeNull();
  });

  it("does not match partial names", () => {
    expect(findAgentMention("my codebotting is slow", agents)).toBeNull();
  });

  it("handles empty agent list", () => {
    expect(findAgentMention("CodeBot help", [])).toBeNull();
  });
});

describe("MessageRouter — route", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("routes to thread owner when thread has an owner", () => {
    const agent = makeAgent({ id: "a1", name: "Bot1" });
    db.agents = [agent];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("routes to channel assignment when no thread owner", () => {
    const agent = makeAgent({ id: "a2", name: "ChannelBot" });
    db.agents = [agent];
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a2" });

    const decision = router.route(makeMessage({ channel: "C001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a2" });
  });

  it("routes by agent name mention when no thread owner or channel assignment", () => {
    const agent = makeAgent({ id: "a1", name: "CodeBot" });
    db.agents = [agent];

    const decision = router.route(makeMessage({ text: "hey CodeBot, review this" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("returns unrouted when no match", () => {
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];

    const decision = router.route(makeMessage({ text: "generic message" }));

    expect(decision).toEqual({ action: "unrouted" });
  });

  it("rejects when user is not in allowlist", () => {
    db.allowedUsers = new Set(["U999"]);
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];

    const decision = router.route(makeMessage({ userId: "U001" }));

    expect(decision).toEqual({ action: "reject", reason: "User not in allowlist" });
  });

  it("allows all users when allowlist is null", () => {
    db.allowedUsers = null;
    db.agents = [makeAgent({ id: "a1", name: "Bot1" })];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ userId: "U001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("thread ownership takes priority over channel assignment", () => {
    const agent1 = makeAgent({ id: "a1", name: "ThreadOwner" });
    const agent2 = makeAgent({ id: "a2", name: "ChannelBot" });
    db.agents = [agent1, agent2];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1", channel: "C001" }));
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a2" });

    const decision = router.route(makeMessage({ threadId: "t-100", channel: "C001" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("channel assignment takes priority over agent mention", () => {
    const agent1 = makeAgent({ id: "a1", name: "ChannelBot" });
    const agent2 = makeAgent({ id: "a2", name: "MentionBot" });
    db.agents = [agent1, agent2];
    db.channelAssignments.set("C001", { channel: "C001", agentId: "a1" });

    const decision = router.route(makeMessage({ channel: "C001", text: "hey MentionBot, help" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
  });

  it("falls back to unrouted when thread owner is gone", () => {
    // Agent a1 owns the thread but is NOT in the agents list (disconnected)
    db.agents = [];
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100" }));

    // Owner is gone — clears ownership and falls through to unrouted
    expect(decision).toEqual({ action: "unrouted" });
    // Ownership should be cleared
    expect(db.threads.get("t-100")?.ownerAgent).toBeNull();
  });

  it("routes to a disconnected owner only while it is explicitly resumable", () => {
    const agent = makeAgent({
      id: "a1",
      name: "ResumeBot",
      disconnectedAt: "2026-01-01T00:00:00Z",
      resumableUntil: "9999-12-31T23:59:59Z",
    });
    db.agents = [agent];
    db.threads.set("t-resume", makeThread({ threadId: "t-resume", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-resume" }));

    expect(decision).toEqual({ action: "deliver", agentId: "a1" });
    expect(db.threads.get("t-resume")?.ownerAgent).toBe("a1");
  });

  it("clears ownership when the owner is disconnected without a resumable window", () => {
    const agent = makeAgent({
      id: "a1",
      name: "OfflineBot",
      disconnectedAt: "2026-01-01T00:00:00Z",
      resumableUntil: null,
    });
    db.agents = [agent];
    db.threads.set("t-offline", makeThread({ threadId: "t-offline", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-offline" }));

    expect(decision).toEqual({ action: "unrouted" });
    expect(db.threads.get("t-offline")?.ownerAgent).toBeNull();
  });
});

describe("MessageRouter — claimThread", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("claims an unclaimed thread (first-responder-wins)", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    const claimed = router.claimThread("t-100", "a1");

    expect(claimed).toBe(true);
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });

  it("creates a new thread when claiming a nonexistent thread", () => {
    const claimed = router.claimThread("t-new", "a1");

    expect(claimed).toBe(true);
    const thread = db.threads.get("t-new");
    expect(thread).toBeDefined();
    expect(thread?.ownerAgent).toBe("a1");
  });

  it("allows re-claiming by the same agent", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const claimed = router.claimThread("t-100", "a1");

    expect(claimed).toBe(true);
  });

  it("rejects claim when another agent already owns the thread", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const claimed = router.claimThread("t-100", "a2");

    expect(claimed).toBe(false);
    expect(db.threads.get("t-100")?.ownerAgent).toBe("a1");
  });
});

describe("MessageRouter — getThreadOwner", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("returns owner agent id", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    expect(router.getThreadOwner("t-100")).toBe("a1");
  });

  it("returns null for unclaimed thread", () => {
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: null }));

    expect(router.getThreadOwner("t-100")).toBeNull();
  });

  it("returns null for nonexistent thread", () => {
    expect(router.getThreadOwner("t-unknown")).toBeNull();
  });
});

describe("MessageRouter — claimThread with upsert", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("updateThread upserts a non-existent thread", () => {
    db.updateThread("t-new", { ownerAgent: "a1" });

    const thread = db.threads.get("t-new");
    expect(thread).toBeDefined();
    expect(thread?.ownerAgent).toBe("a1");
    expect(thread?.source).toBe("slack");
  });

  it("updateThread upsert preserves provided channel", () => {
    db.updateThread("t-new", { ownerAgent: "a1", channel: "C999" });

    const thread = db.threads.get("t-new");
    expect(thread?.channel).toBe("C999");
  });

  it("claimThread works via updateThread upsert path", () => {
    // Thread doesn't exist — claimThread creates it
    const claimed = router.claimThread("t-fresh", "a1");
    expect(claimed).toBe(true);
    expect(db.threads.get("t-fresh")?.ownerAgent).toBe("a1");
  });
});

describe("MessageRouter — getAvailableAgents", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
  });

  it("returns connected agents", () => {
    db.agents = [makeAgent({ id: "a1", name: "Bot1" }), makeAgent({ id: "a2", name: "Bot2" })];

    const agents = router.getAvailableAgents();

    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("returns empty array when no agents", () => {
    db.agents = [];

    expect(router.getAvailableAgents()).toEqual([]);
  });
});

describe("MessageRouter — multi-agent scenarios", () => {
  let db: StubBrokerDBInterface;
  let router: MessageRouter;

  beforeEach(() => {
    db = new StubBrokerDBInterface();
    router = new MessageRouter(db);
    db.agents = [
      makeAgent({ id: "a1", name: "CodeBot" }),
      makeAgent({ id: "a2", name: "ReviewBot" }),
      makeAgent({ id: "a3", name: "DeployBot" }),
    ];
  });

  it("routes different threads to different owners", () => {
    db.threads.set("t-1", makeThread({ threadId: "t-1", ownerAgent: "a1" }));
    db.threads.set("t-2", makeThread({ threadId: "t-2", ownerAgent: "a2" }));
    db.threads.set("t-3", makeThread({ threadId: "t-3", ownerAgent: "a3" }));

    expect(router.route(makeMessage({ threadId: "t-1" }))).toEqual({
      action: "deliver",
      agentId: "a1",
    });
    expect(router.route(makeMessage({ threadId: "t-2" }))).toEqual({
      action: "deliver",
      agentId: "a2",
    });
    expect(router.route(makeMessage({ threadId: "t-3" }))).toEqual({
      action: "deliver",
      agentId: "a3",
    });
  });

  it("first agent to claim wins, second is rejected", () => {
    db.threads.set("t-race", makeThread({ threadId: "t-race", ownerAgent: null }));

    expect(router.claimThread("t-race", "a1")).toBe(true);
    expect(router.claimThread("t-race", "a2")).toBe(false);
    expect(router.getThreadOwner("t-race")).toBe("a1");
  });

  it("mentions route to the correct agent among many", () => {
    const d1 = router.route(makeMessage({ text: "hey ReviewBot, check this" }));
    expect(d1).toEqual({ action: "deliver", agentId: "a2" });

    const d2 = router.route(makeMessage({ text: "DeployBot deploy to staging" }));
    expect(d2).toEqual({ action: "deliver", agentId: "a3" });
  });

  it("route after agent disconnect — clears ownership and re-routes", () => {
    // a2 owns the thread but is disconnected
    db.threads.set("t-owned", makeThread({ threadId: "t-owned", ownerAgent: "a2" }));
    db.agents = db.agents.filter((a) => a.id !== "a2");

    const decision = router.route(makeMessage({ threadId: "t-owned" }));

    // Owner gone — ownership cleared, falls through to agent mention or unrouted
    expect(db.threads.get("t-owned")?.ownerAgent).toBeNull();
    // a1 is still connected but not mentioned — unrouted
    expect(decision).toEqual({ action: "unrouted" });
  });

  it("allowlist rejection happens before any routing", () => {
    db.allowedUsers = new Set(["U999"]);
    db.threads.set("t-100", makeThread({ threadId: "t-100", ownerAgent: "a1" }));

    const decision = router.route(makeMessage({ threadId: "t-100", userId: "U001" }));

    expect(decision).toEqual({ action: "reject", reason: "User not in allowlist" });
  });
});
