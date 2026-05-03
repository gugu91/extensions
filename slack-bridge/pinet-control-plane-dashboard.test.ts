import { describe, expect, it } from "vitest";
import { createPinetControlPlaneDashboard } from "./pinet-control-plane-dashboard.js";

function createDb() {
  return {
    getAllAgents: () => [
      {
        id: "broker-1",
        name: "The Broker Otter",
        emoji: "🦦",
        status: "working" as const,
        lastHeartbeat: new Date().toISOString(),
        metadata: { role: "broker", branch: "main", capabilities: { role: "broker" } },
      },
      {
        id: "worker-1",
        name: "Cosmic Crane",
        emoji: "🦩",
        status: "idle" as const,
        lastHeartbeat: new Date().toISOString(),
        metadata: { role: "worker", branch: "fix/remove-control-plane-canvas-691" },
      },
    ],
    getPendingInboxCount: (agentId: string) => (agentId === "worker-1" ? 2 : 0),
    getOwnedThreadCount: (agentId: string) => (agentId === "worker-1" ? 1 : 0),
    getBacklogCount: () => 3,
    listTaskAssignments: () => [],
    listPinetLanes: () => [
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
        state: "active" as const,
        summary: "coordination active",
        metadata: null,
        createdAt: "2026-05-02T18:29:00.000Z",
        updatedAt: "2026-05-02T18:30:00.000Z",
        lastActivityAt: "2026-05-02T18:30:00.000Z",
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
        state: "detached" as const,
        summary: "manual supervision",
        metadata: null,
        createdAt: "2026-05-02T18:28:00.000Z",
        updatedAt: "2026-05-02T18:30:30.000Z",
        lastActivityAt: "2026-05-02T18:30:30.000Z",
        participants: [],
      },
    ],
    getMessagesByIds: () => [],
    getRecentRalphCycles: () => [],
  };
}

describe("createPinetControlPlaneDashboard", () => {
  it("builds a current broker dashboard snapshot without using Slack canvas APIs", async () => {
    const dashboard = createPinetControlPlaneDashboard({
      getActiveBrokerDb: createDb,
      getActiveBrokerSelfId: () => "broker-1",
      heartbeatTimerActive: () => true,
      maintenanceTimerActive: () => true,
      getLastMaintenance: () => ({
        reapedAgentIds: [],
        repairedThreadClaims: 0,
        assignedBacklogCount: 1,
        nudgedAgentIds: [],
        pendingBacklogCount: 3,
        anomalies: [],
      }),
    });

    const snapshot = await dashboard.buildCurrentBrokerControlPlaneDashboardSnapshot(
      "2026-05-02T18:31:00.000Z",
    );

    expect(snapshot).toMatchObject({
      cycleStartedAt: "2026-05-02T18:31:00.000Z",
      liveAgents: 2,
      brokerCount: 1,
      workerCount: 1,
      pendingBacklogCount: 3,
      assignedBacklogCount: 1,
    });
    expect(snapshot?.roster.map((row) => row.id)).toEqual(["broker-1", "worker-1"]);
    expect(snapshot?.activeLanes[0]).toContain("issue-688 [active]");
    expect(snapshot?.detachedLanes[0]).toContain("issue-123 [detached]");
  });

  it("returns null when no broker database is active", async () => {
    const dashboard = createPinetControlPlaneDashboard({
      getActiveBrokerDb: () => null,
      getActiveBrokerSelfId: () => null,
      heartbeatTimerActive: () => false,
      maintenanceTimerActive: () => false,
      getLastMaintenance: () => null,
    });

    await expect(dashboard.buildCurrentBrokerControlPlaneDashboardSnapshot()).resolves.toBeNull();
  });
});
