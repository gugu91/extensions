import { describe, expect, it, vi } from "vitest";
import {
  buildBrokerControlPlaneDashboardSnapshot,
  refreshBrokerControlPlaneCanvas,
  renderBrokerControlPlaneCanvasMarkdown,
  type BrokerControlPlaneRecentCycle,
} from "./control-plane-canvas.js";

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
          updatedAt: "2026-04-02T17:00:05.000Z",
        },
        {
          agentId: "worker-1",
          issueNumber: 202,
          branch: "fix/broker-name-format",
          status: "pr_merged",
          prNumber: 205,
          updatedAt: "2026-04-02T16:59:05.000Z",
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
  });
});

describe("renderBrokerControlPlaneCanvasMarkdown", () => {
  it("renders the dashboard sections as markdown", () => {
    const markdown = renderBrokerControlPlaneCanvasMarkdown({
      cycleStartedAt: "2026-04-02T17:00:00.000Z",
      cycleDurationMs: 2500,
      currentBranch: "main",
      totalAgents: 2,
      liveAgents: 2,
      brokerCount: 1,
      workerCount: 1,
      idleWorkers: 0,
      workingWorkers: 1,
      ghostAgents: 1,
      stuckAgents: 1,
      pendingBacklogCount: 3,
      nudgesThisCycle: 1,
      idleDrainCandidates: 0,
      assignedBacklogCount: 1,
      reapedAgents: 1,
      repairedThreadClaims: 2,
      maintenanceAnomalies: ["released 2 orphaned thread claims"],
      anomalies: ["ghost agents detected: ghost-1"],
      taskCounts: {
        assigned: 0,
        branchPushed: 0,
        openPrs: 1,
        mergedPrs: 1,
        closedPrs: 0,
      },
      activeTasks: ["#217 PR #221 open"],
      recentOutcomes: ["#202 PR #205 merged"],
      roster: [
        {
          id: "broker-1",
          role: "broker",
          label: "🦦 The Broker Otter",
          status: "working",
          health: "healthy",
          workload: "0 inbox / 0 threads",
          taskSummary: "—",
          heartbeat: "2s ago",
          branch: "main",
          worktree: "main checkout",
        },
      ],
      recentCycles: [
        {
          startedAt: "2026-04-02 17:00Z",
          duration: "3.0s",
          agentCount: 2,
          backlogCount: 3,
          ghostCount: 1,
          stuckCount: 1,
          anomalySummary: "ghost agents detected: ghost-1",
          followUpDelivered: true,
        },
      ],
    });

    expect(markdown).toContain("# Pinet Broker Control Plane");
    expect(markdown).toContain("## Mesh summary");
    expect(markdown).toContain("## Agent roster");
    expect(markdown).toContain("## Task / PR status");
    expect(markdown).toContain("## Recent RALPH cycles");
    expect(markdown).toContain("ghost agents detected: ghost-1");
    expect(markdown).toContain("🦦 The Broker Otter");
  });
});

describe("refreshBrokerControlPlaneCanvas", () => {
  it("updates an existing configured canvas", async () => {
    const slack = vi.fn(async () => ({ ok: true }));

    const result = await refreshBrokerControlPlaneCanvas({
      slack,
      token: "xoxb-test",
      canvasId: "F123",
      markdown: "# Dashboard",
    });

    expect(slack).toHaveBeenCalledWith(
      "canvases.edit",
      "xoxb-test",
      expect.objectContaining({ canvas_id: "F123" }),
    );
    expect(result).toEqual({
      canvasId: "F123",
      created: false,
      reusedExistingChannelCanvas: false,
      updated: true,
    });
  });

  it("creates a channel canvas when none exists yet", async () => {
    const slack = vi.fn(async (method: string) => {
      if (method === "conversations.canvases.create") {
        return { ok: true, canvas_id: "F234" };
      }
      return { ok: true };
    });

    const result = await refreshBrokerControlPlaneCanvas({
      slack,
      token: "xoxb-test",
      channelId: "C123",
      title: "Control Plane",
      markdown: "# Dashboard",
    });

    expect(slack).toHaveBeenCalledWith(
      "conversations.canvases.create",
      "xoxb-test",
      expect.objectContaining({ channel_id: "C123", title: "Control Plane" }),
    );
    expect(result).toEqual({
      canvasId: "F234",
      created: true,
      reusedExistingChannelCanvas: false,
      updated: false,
    });
  });

  it("reuses an existing channel canvas when Slack reports one already exists", async () => {
    const slack = vi.fn(async (method: string) => {
      if (method === "conversations.canvases.create") {
        throw new Error("Slack conversations.canvases.create: channel_canvas_already_exists");
      }
      if (method === "conversations.info") {
        return {
          ok: true,
          channel: {
            properties: {
              canvas: { id: "F345" },
            },
          },
        };
      }
      return { ok: true };
    });

    const result = await refreshBrokerControlPlaneCanvas({
      slack,
      token: "xoxb-test",
      channelId: "C123",
      markdown: "# Dashboard",
    });

    expect(slack).toHaveBeenNthCalledWith(2, "conversations.info", "xoxb-test", {
      channel: "C123",
    });
    expect(slack).toHaveBeenNthCalledWith(
      3,
      "canvases.edit",
      "xoxb-test",
      expect.objectContaining({ canvas_id: "F345" }),
    );
    expect(result).toEqual({
      canvasId: "F345",
      created: false,
      reusedExistingChannelCanvas: true,
      updated: true,
    });
  });

  it("falls back to channel recovery when a cached canvas id is stale", async () => {
    const slack = vi.fn(async (method: string) => {
      if (method === "canvases.edit") {
        throw new Error("Slack canvases.edit: canvas_not_found");
      }
      if (method === "conversations.canvases.create") {
        return { ok: true, canvas_id: "F456" };
      }
      return { ok: true };
    });

    const result = await refreshBrokerControlPlaneCanvas({
      slack,
      token: "xoxb-test",
      canvasId: "F-stale",
      channelId: "C123",
      markdown: "# Dashboard",
    });

    expect(slack).toHaveBeenNthCalledWith(
      1,
      "canvases.edit",
      "xoxb-test",
      expect.objectContaining({ canvas_id: "F-stale" }),
    );
    expect(slack).toHaveBeenNthCalledWith(
      2,
      "conversations.canvases.create",
      "xoxb-test",
      expect.objectContaining({ channel_id: "C123" }),
    );
    expect(result).toEqual({
      canvasId: "F456",
      created: true,
      reusedExistingChannelCanvas: false,
      updated: false,
    });
  });

  it("rejects refreshes without a target", async () => {
    await expect(
      refreshBrokerControlPlaneCanvas({
        slack: vi.fn(async () => ({ ok: true })),
        token: "xoxb-test",
        markdown: "# Dashboard",
      }),
    ).rejects.toThrow("Control plane canvas refresh requires either a canvas ID or channel ID.");
  });
});
