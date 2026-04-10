import { describe, expect, it, vi } from "vitest";
import {
  buildSlackHomeTabPublishRequest,
  publishSlackHomeTab,
  renderBrokerControlPlaneHomeTabView,
  renderStandalonePinetHomeTabView,
} from "./home-tab.js";

describe("renderBrokerControlPlaneHomeTabView", () => {
  it("renders the broker control plane snapshot as a Home tab view", () => {
    const view = renderBrokerControlPlaneHomeTabView({
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
        branchPushed: 1,
        openPrs: 1,
        mergedPrs: 1,
        closedPrs: 0,
      },
      activeTasks: ["#217 PR #225 open"],
      recentOutcomes: ["#205 PR #205 merged"],
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

    expect(view.type).toBe("home");
    expect(view.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "header",
          text: expect.objectContaining({ text: "Pinet Broker Control Plane" }),
        }),
        expect.objectContaining({
          type: "header",
          text: expect.objectContaining({ text: "Agent roster" }),
        }),
        expect.objectContaining({
          type: "header",
          text: expect.objectContaining({ text: "Recent RALPH cycles" }),
        }),
      ]),
    );

    expect(JSON.stringify(view)).toContain("ghost agents detected: ghost-1");
    expect(JSON.stringify(view)).toContain("🦦 The Broker Otter");
    expect(JSON.stringify(view)).toContain("#217 PR #225 open");
  });
});

describe("renderStandalonePinetHomeTabView", () => {
  it("renders a fallback Home tab for non-broker sessions", () => {
    const view = renderStandalonePinetHomeTabView({
      agentName: "Cosmic Crane",
      agentEmoji: "🦩",
      connected: true,
      mode: "single",
      activeThreads: 3,
      pendingInbox: 1,
      currentBranch: "feat/home-tab",
      defaultChannel: "ops-control",
    });

    expect(view.type).toBe("home");
    expect(JSON.stringify(view)).toContain("Cosmic Crane");
    expect(JSON.stringify(view)).toContain("feat/home-tab");
    expect(JSON.stringify(view)).toContain("full control-plane dashboard");
    expect(JSON.stringify(view)).toContain("single");
  });
});

describe("buildSlackHomeTabPublishRequest", () => {
  it("builds a views.publish request body", () => {
    expect(
      buildSlackHomeTabPublishRequest("U123", {
        type: "home",
        blocks: [],
      }),
    ).toEqual({
      user_id: "U123",
      view: {
        type: "home",
        blocks: [],
      },
    });
  });

  it("rejects missing user ids", () => {
    expect(() =>
      buildSlackHomeTabPublishRequest("", {
        type: "home",
        blocks: [],
      }),
    ).toThrow("Home tab publish requires a user ID.");
  });
});

describe("publishSlackHomeTab", () => {
  it("calls views.publish with the built request", async () => {
    const slack = vi.fn(async () => ({ ok: true }));

    await publishSlackHomeTab({
      slack,
      token: "xoxb-test",
      userId: "U123",
      view: {
        type: "home",
        blocks: [],
      },
    });

    expect(slack).toHaveBeenCalledWith("views.publish", "xoxb-test", {
      user_id: "U123",
      view: {
        type: "home",
        blocks: [],
      },
    });
  });
});
