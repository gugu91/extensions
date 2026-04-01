import { beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo, BacklogEntry, ThreadInfo } from "./types.js";
import {
  DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
  OVERLOADED_INBOX_THRESHOLD,
  runBrokerMaintenancePass,
  selectBacklogAssignee,
  type BrokerMaintenanceDB,
} from "./maintenance.js";

class StubMaintenanceDB implements BrokerMaintenanceDB {
  agents: AgentInfo[] = [];
  backlog: BacklogEntry[] = [];
  threads = new Map<string, ThreadInfo>();
  pendingInboxCounts = new Map<string, number>();
  staleAgents: string[] = [];
  repairedThreadClaims = 0;
  repairedAgentIds: string[] = [];
  requeuedAgents: string[] = [];
  methodCalls: string[] = [];

  pruneStaleAgents(_staleAfterMs: number): string[] {
    this.methodCalls.push("prune");
    return [...this.staleAgents];
  }

  purgeDisconnectedAgents(): string[] {
    this.methodCalls.push("purge");
    return [];
  }

  repairThreadOwnership(): { releasedClaimCount: number; releasedAgentIds: string[] } {
    this.methodCalls.push("repair");
    return {
      releasedClaimCount: this.repairedThreadClaims,
      releasedAgentIds: [...this.repairedAgentIds],
    };
  }

  requeueUndeliveredMessages(agentId: string): number {
    this.requeuedAgents.push(agentId);
    return 0;
  }

  getPendingBacklog(limit = 50): BacklogEntry[] {
    return this.backlog.filter((entry) => entry.status === "pending").slice(0, limit);
  }

  getBacklogCount(status: BacklogEntry["status"] = "pending"): number {
    return this.backlog.filter((entry) => entry.status === status).length;
  }

  getAgents(): AgentInfo[] {
    return this.agents;
  }

  getPendingInboxCount(agentId: string): number {
    return this.pendingInboxCounts.get(agentId) ?? 0;
  }

  getThread(threadId: string): ThreadInfo | null {
    return this.threads.get(threadId) ?? null;
  }

  assignBacklogEntry(id: number, agentId: string): BacklogEntry | null {
    const entry = this.backlog.find((backlog) => backlog.id === id) ?? null;
    if (!entry) return null;
    entry.status = "assigned";
    entry.assignedAgentId = agentId;
    entry.attemptCount += 1;
    this.pendingInboxCounts.set(agentId, (this.pendingInboxCounts.get(agentId) ?? 0) + 1);
    return entry;
  }
}

function makeAgent(overrides: Partial<AgentInfo> & { id: string; name: string }): AgentInfo {
  return {
    emoji: "🤖",
    pid: 1000,
    connectedAt: "2026-04-01T00:00:00.000Z",
    lastSeen: "2026-04-01T00:00:00.000Z",
    lastHeartbeat: "2026-04-01T00:00:00.000Z",
    metadata: null,
    status: "idle",
    ...overrides,
  };
}

function makeBacklog(overrides: Partial<BacklogEntry> & { id: number; threadId: string }): BacklogEntry {
  return {
    channel: "C123",
    messageId: overrides.id,
    reason: "no_route",
    status: "pending",
    assignedAgentId: null,
    attemptCount: 0,
    lastAttemptAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectBacklogAssignee", () => {
  it("prefers the least-loaded idle worker", () => {
    const result = selectBacklogAssignee(
      makeBacklog({ id: 1, threadId: "t-1" }),
      [
        { agent: makeAgent({ id: "busy-idle", name: "BusyIdle" }), pendingInboxCount: 2 },
        { agent: makeAgent({ id: "free-idle", name: "FreeIdle" }), pendingInboxCount: 0 },
      ],
      Date.parse("2026-04-01T00:00:10.000Z"),
    );

    expect(result?.id).toBe("free-idle");
  });

  it("only falls back to working workers after the backlog ages out", () => {
    const backlog = makeBacklog({ id: 1, threadId: "t-1", createdAt: "2026-04-01T00:00:00.000Z" });
    const worker = { agent: makeAgent({ id: "working-1", name: "Worker", status: "working" }), pendingInboxCount: 1 };

    expect(
      selectBacklogAssignee(
        backlog,
        [worker],
        Date.parse("2026-04-01T00:00:10.000Z"),
        DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
      ),
    ).toBeNull();

    expect(
      selectBacklogAssignee(
        backlog,
        [worker],
        Date.parse("2026-04-01T00:01:00.000Z"),
        DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
      )?.id,
    ).toBe("working-1");
  });
});

describe("runBrokerMaintenancePass", () => {
  let db: StubMaintenanceDB;

  beforeEach(() => {
    db = new StubMaintenanceDB();
  });

  it("assigns unrouted backlog to an idle worker and records a nudge", () => {
    db.agents = [makeAgent({ id: "broker-1", name: "Broker", metadata: { role: "broker" } }), makeAgent({ id: "worker-1", name: "Worker" })];
    db.backlog = [makeBacklog({ id: 1, threadId: "t-1" })];

    const result = runBrokerMaintenancePass(db, {
      brokerAgentId: "broker-1",
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(1);
    expect(result.nudgedAgentIds).toEqual(["worker-1"]);
    expect(db.backlog[0].status).toBe("assigned");
    expect(db.backlog[0].assignedAgentId).toBe("worker-1");
  });

  it("prefers the live thread owner before other idle workers", () => {
    db.agents = [makeAgent({ id: "worker-1", name: "Owner" }), makeAgent({ id: "worker-2", name: "Other" })];
    db.backlog = [makeBacklog({ id: 1, threadId: "t-owned" })];
    db.threads.set("t-owned", {
      threadId: "t-owned",
      source: "slack",
      channel: "C123",
      ownerAgent: "worker-2",
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(1);
    expect(db.backlog[0].assignedAgentId).toBe("worker-2");
  });

  it("leaves backlog pending and reports an anomaly when no workers are available", () => {
    db.backlog = [makeBacklog({ id: 1, threadId: "t-1" })];

    const result = runBrokerMaintenancePass(db, {
      brokerAgentId: "broker-1",
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(0);
    expect(result.pendingBacklogCount).toBe(1);
    expect(result.anomalies).toContain("pending unrouted backlog has no live workers");
  });

  it("requeues disconnected-agent inbox work after ownership repair", () => {
    db.repairedThreadClaims = 2;
    db.repairedAgentIds = ["ghost-1", "ghost-2"];

    runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(db.requeuedAgents).toEqual(["ghost-1", "ghost-2"]);
  });

  it("purges disconnected ghosts immediately after stale reaping", () => {
    runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(db.methodCalls.slice(0, 3)).toEqual(["prune", "purge", "repair"]);
  });

  it("surfaces stale-agent and orphaned-thread repair activity", () => {
    db.agents = [makeAgent({ id: "worker-1", name: "Worker" })];
    db.staleAgents = ["ghost-1"];
    db.repairedThreadClaims = 2;

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.anomalies).toContain("reaped 1 stale agent");
    expect(result.anomalies).toContain("released 2 orphaned thread claims");
  });

  it("reports overloaded workers", () => {
    db.agents = [makeAgent({ id: "worker-1", name: "Worker" })];
    db.pendingInboxCounts.set("worker-1", OVERLOADED_INBOX_THRESHOLD);

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.anomalies).toContain("overloaded workers: Worker");
  });
});
