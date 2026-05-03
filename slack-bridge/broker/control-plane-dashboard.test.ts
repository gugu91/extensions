import { describe, expect, it } from "vitest";
import {
  buildBrokerControlPlaneDashboardSnapshot,
  type BrokerControlPlaneRecentCycle,
} from "./control-plane-dashboard.js";

describe("buildBrokerControlPlaneDashboardSnapshot", () => {
  it("summarizes agent, task, and RALPH state for the dashboard", () => {
    const snapshot = buildBrokerControlPlaneDashboardSnapshot({
      workloads: [
        {
          id: "broker-1",
          name: "The Broker Otter",
          emoji: "🦦",
          status: "working",
          lastHeartbeat: "2026-04-02T17:00:08.000Z",
          pendingInboxCount: 0,
          ownedThreadCount: 0,
          metadata: {
            role: "broker",
            branch: "main",
            worktreeKind: "main",
            capabilities: { role: "broker" },
          },
        },
        {
          id: "worker-1",
          name: "Cosmic Crane",
          emoji: "🦩",
          status: "working",
          lastHeartbeat: "2026-04-02T17:00:10.000Z",
          lastActivity: "2026-04-02T17:00:11.000Z",
          pendingInboxCount: 1,
          ownedThreadCount: 2,
          metadata: {
            role: "worker",
            branch: "feat/control-plane-canvas",
            repoRoot: "/Users/alice/src/extensions",
            worktreePath: "/Users/alice/src/extensions/.worktrees/feat-217",
            worktreeKind: "linked",
            capabilities: { role: "worker" },
          },
        },
      ],
      evaluation: {
        ghostAgentIds: ["ghost-1"],
        nudgeAgentIds: ["worker-1"],
        idleDrainAgentIds: [],
        stuckAgentIds: ["worker-1"],
        anomalies: [
          "worker-1 appears stuck (working with no activity for 16m)",
          "ghost agents detected: ghost-1",
        ],
      },
      evaluationOptions: {
        now: Date.parse("2026-04-02T17:00:20.000Z"),
        heartbeatTimeoutMs: 15_000,
        heartbeatIntervalMs: 5_000,
      },
      maintenance: {
        reapedAgentIds: ["ghost-1"],
        repairedThreadClaims: 2,
        assignedBacklogCount: 1,
        nudgedAgentIds: ["worker-1"],
        pendingBacklogCount: 3,
        anomalies: ["released 2 orphaned thread claims"],
      },
      assignments: [
        {
          agentId: "worker-1",
          issueNumber: 217,
          branch: "feat/control-plane-canvas",
          status: "pr_open",
          prNumber: 221,
          issueState: "OPEN",
          updatedAt: "2026-04-02T17:00:05.000Z",
        },
        {
          agentId: "worker-1",
          issueNumber: 202,
          branch: "fix/broker-name-format",
          status: "pr_merged",
          prNumber: 205,
          issueState: "OPEN",
          updatedAt: "2026-04-02T16:59:05.000Z",
        },
      ],
      lanes: [
        {
          laneId: "issue-688",
          name: "PM lane",
          task: null,
          issueNumber: 688,
          prNumber: null,
          threadId: "a2a:broker:pm",
          ownerAgentId: "worker-1",
          implementationLeadAgentId: "worker-1",
          pmMode: true,
          state: "active",
          summary: "coordination active",
          metadata: null,
          createdAt: "2026-04-02T16:58:00.000Z",
          updatedAt: "2026-04-02T17:00:06.000Z",
          lastActivityAt: "2026-04-02T17:00:06.000Z",
          participants: [],
        },
        {
          laneId: "issue-123",
          name: null,
          task: null,
          issueNumber: 123,
          prNumber: null,
          threadId: null,
          ownerAgentId: "worker-2",
          implementationLeadAgentId: null,
          pmMode: false,
          state: "detached",
          summary: "manual supervision",
          metadata: null,
          createdAt: "2026-04-02T16:57:00.000Z",
          updatedAt: "2026-04-02T17:00:07.000Z",
          lastActivityAt: "2026-04-02T17:00:07.000Z",
          participants: [],
        },
      ],
      recentCycles: [
        {
          startedAt: "2026-04-02T17:00:00.000Z",
          completedAt: "2026-04-02T17:00:03.000Z",
          durationMs: 3000,
          ghostAgentIds: ["ghost-1"],
          stuckAgentIds: ["worker-1"],
          anomalies: ["ghost agents detected: ghost-1"],
          followUpDelivered: true,
          agentCount: 2,
          backlogCount: 3,
        } satisfies BrokerControlPlaneRecentCycle,
      ],
      cycleStartedAt: "2026-04-02T17:00:00.000Z",
      cycleDurationMs: 3200,
      currentBranch: "main",
      homedir: "/Users/alice",
    });

    expect(snapshot.liveAgents).toBe(2);
    expect(snapshot.brokerCount).toBe(1);
    expect(snapshot.workerCount).toBe(1);
    expect(snapshot.pendingBacklogCount).toBe(3);
    expect(snapshot.taskCounts.openPrs).toBe(1);
    expect(snapshot.taskCounts.mergedPrs).toBe(1);
    expect(snapshot.roster[0]?.label).toContain("The Broker Otter");
    expect(snapshot.roster[1]?.taskSummary).toContain("#217 PR #221 open");
    expect(snapshot.recentOutcomes).toContain("#202 PR #205 merged");
    expect(snapshot.activeLanes[0]).toContain("issue-688 [active]");
    expect(snapshot.detachedLanes[0]).toContain("issue-123 [detached]");
  });
});
