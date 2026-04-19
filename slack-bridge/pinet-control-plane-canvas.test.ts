import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeGitBranch } from "./git-metadata.js";
import {
  createPinetControlPlaneCanvas,
  type PinetControlPlaneCanvasBrokerDbPort,
  type PinetControlPlaneCanvasDeps,
  type PinetControlPlaneCanvasRefreshInput,
} from "./pinet-control-plane-canvas.js";

vi.mock("./git-metadata.js", () => ({
  probeGitBranch: vi.fn(async () => "main"),
}));

function createContext() {
  const notify = vi.fn();
  const ctx = {
    ui: {
      notify,
    },
  } as unknown as ExtensionContext;

  return { ctx, notify };
}

function createRefreshInput(
  overrides: Partial<PinetControlPlaneCanvasRefreshInput> = {},
): PinetControlPlaneCanvasRefreshInput {
  return {
    workloads: [
      {
        id: "broker-1",
        name: "Broker Otter",
        emoji: "🦦",
        status: "working",
        lastHeartbeat: "2026-04-15T00:00:10.000Z",
        pendingInboxCount: 0,
        ownedThreadCount: 0,
        metadata: {
          role: "broker",
          capabilities: { role: "broker" },
          branch: "main",
          worktreeKind: "main",
        },
      },
      {
        id: "worker-1",
        name: "Worker Crane",
        emoji: "🦩",
        status: "working",
        lastHeartbeat: "2026-04-15T00:00:12.000Z",
        lastActivity: "2026-04-15T00:00:12.000Z",
        pendingInboxCount: 1,
        ownedThreadCount: 2,
        metadata: {
          role: "worker",
          capabilities: { role: "worker" },
          branch: "feat/control-plane-canvas",
          repoRoot: "/Users/alice/src/extensions",
          worktreePath: "/Users/alice/src/extensions/.worktrees/feat-control-plane-canvas",
          worktreeKind: "linked",
        },
      },
    ],
    evaluation: {
      ghostAgentIds: [],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: [],
      anomalies: [],
    },
    evaluationOptions: {
      now: Date.parse("2026-04-15T00:00:15.000Z"),
      heartbeatTimeoutMs: 15_000,
      heartbeatIntervalMs: 5_000,
      brokerAgentId: "broker-1",
      pendingBacklogCount: 3,
      currentBranch: "main",
    },
    maintenance: {
      reapedAgentIds: [],
      repairedThreadClaims: 0,
      assignedBacklogCount: 1,
      nudgedAgentIds: [],
      pendingBacklogCount: 3,
      anomalies: [],
    },
    assignments: [],
    recentCycles: [],
    cycleStartedAt: "2026-04-15T00:00:00.000Z",
    cycleDurationMs: 2500,
    currentBranch: "main",
    ...overrides,
  };
}

function createDeps(overrides: Partial<PinetControlPlaneCanvasDeps> = {}) {
  let runtimeCanvasId: string | null = null;
  let runtimeChannelId: string | null = null;
  let lastControlPlaneCanvasRefreshAt: string | null = null;
  let lastControlPlaneCanvasError: string | null = null;

  const db: PinetControlPlaneCanvasBrokerDbPort = {
    getAllAgents: () => {
      const now = new Date().toISOString();
      return [
        {
          id: "broker-1",
          name: "Broker Otter",
          emoji: "🦦",
          status: "working",
          lastHeartbeat: now,
          metadata: {
            role: "broker",
            capabilities: { role: "broker" },
            branch: "main",
            worktreeKind: "main",
          },
        },
        {
          id: "worker-1",
          name: "Worker Crane",
          emoji: "🦩",
          status: "working",
          lastHeartbeat: now,
          lastActivity: now,
          metadata: {
            role: "worker",
            capabilities: { role: "worker" },
            branch: "feat/control-plane-canvas",
            repoRoot: "/Users/alice/src/extensions",
            worktreePath: "/Users/alice/src/extensions/.worktrees/feat-control-plane-canvas",
            worktreeKind: "linked",
          },
        },
      ];
    },
    getPendingInboxCount: (agentId) => (agentId === "worker-1" ? 1 : 0),
    getOwnedThreadCount: (agentId) => (agentId === "worker-1" ? 2 : 0),
    getBacklogCount: () => 3,
    listTaskAssignments: () => [],
    getMessagesByIds: () => [],
    getRecentRalphCycles: () => [
      {
        startedAt: "2026-04-15T00:00:00.000Z",
        completedAt: "2026-04-15T00:00:02.500Z",
        durationMs: 2500,
        ghostAgentIds: [],
        stuckAgentIds: [],
        anomalies: [],
        followUpDelivered: true,
        agentCount: 2,
        backlogCount: 3,
      },
    ],
  };

  const slack = vi.fn(async () => ({ ok: true }));
  const resolveChannel = vi.fn(async () => "C123CANVAS");
  const persistState = vi.fn();

  const deps: PinetControlPlaneCanvasDeps = {
    getSettings: () => ({}),
    getBotToken: () => "xoxb-test",
    slack,
    resolveChannel,
    persistState,
    getActiveBrokerDb: () => db,
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
    isBrokerControlPlaneCanvasEnabled: () => true,
    getControlPlaneCanvasRuntimeId: () => runtimeCanvasId,
    getControlPlaneCanvasRuntimeChannelId: () => runtimeChannelId,
    restoreControlPlaneCanvasRuntimeState: vi.fn((input) => {
      runtimeCanvasId = input.canvasId;
      runtimeChannelId = input.channelId;
    }),
    setLastControlPlaneCanvasRefreshAt: vi.fn((value: string | null) => {
      lastControlPlaneCanvasRefreshAt = value;
    }),
    getLastControlPlaneCanvasError: () => lastControlPlaneCanvasError,
    setLastControlPlaneCanvasError: vi.fn((value: string | null) => {
      lastControlPlaneCanvasError = value;
    }),
    ...overrides,
  };

  return {
    deps,
    db,
    slack: deps.slack,
    resolveChannel: deps.resolveChannel,
    persistState: deps.persistState,
    getRuntimeCanvasId: () => runtimeCanvasId,
    getRuntimeChannelId: () => runtimeChannelId,
    getLastRefreshAt: () => lastControlPlaneCanvasRefreshAt,
    getLastError: () => lastControlPlaneCanvasError,
  };
}

describe("createPinetControlPlaneCanvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(probeGitBranch).mockResolvedValue("main");
  });

  it("normalizes explicit canvas settings and falls back to runtime/default values", () => {
    const { deps } = createDeps({
      getSettings: () => ({
        controlPlaneCanvasId: "  FEXPLICIT  ",
        controlPlaneCanvasChannel: "  ops-control  ",
        controlPlaneCanvasTitle: "  Mesh Control Plane  ",
      }),
      getControlPlaneCanvasRuntimeId: () => "FRUNTIME",
    });
    const canvas = createPinetControlPlaneCanvas(deps);

    expect(canvas.getExplicitBrokerControlPlaneCanvasId()).toBe("FEXPLICIT");
    expect(canvas.getConfiguredBrokerControlPlaneCanvasId()).toBe("FEXPLICIT");
    expect(canvas.getConfiguredBrokerControlPlaneCanvasChannel()).toBe("ops-control");
    expect(canvas.getConfiguredBrokerControlPlaneCanvasTitle()).toBe("Mesh Control Plane");

    const fallback = createPinetControlPlaneCanvas(
      createDeps({
        getSettings: () => ({ defaultChannel: "  broker-ops  " }),
        getControlPlaneCanvasRuntimeId: () => "FRUNTIME",
      }).deps,
    );

    expect(fallback.getExplicitBrokerControlPlaneCanvasId()).toBeNull();
    expect(fallback.getConfiguredBrokerControlPlaneCanvasId()).toBe("FRUNTIME");
    expect(fallback.getConfiguredBrokerControlPlaneCanvasChannel()).toBe("broker-ops");
    expect(fallback.getConfiguredBrokerControlPlaneCanvasTitle()).toBe(
      "Pinet Broker Control Plane",
    );
  });

  it("returns null when no active broker db is available", async () => {
    const { deps } = createDeps({
      getActiveBrokerDb: () => null,
    });
    const canvas = createPinetControlPlaneCanvas(deps);

    await expect(canvas.buildCurrentBrokerControlPlaneDashboardSnapshot()).resolves.toBeNull();
  });

  it("builds the current broker control-plane dashboard snapshot from broker state", async () => {
    const { deps } = createDeps();
    const canvas = createPinetControlPlaneCanvas(deps);

    const snapshot = await canvas.buildCurrentBrokerControlPlaneDashboardSnapshot(
      "2026-04-15T00:00:00.000Z",
    );

    expect(probeGitBranch).toHaveBeenCalledWith(process.cwd());
    expect(snapshot).not.toBeNull();
    expect(snapshot?.currentBranch).toBe("main");
    expect(snapshot?.liveAgents).toBe(2);
    expect(snapshot?.workerCount).toBe(1);
    expect(snapshot?.pendingBacklogCount).toBe(3);
    expect(snapshot?.acceptedTaskReplyGaps).toBe(0);
    expect(snapshot?.roster[0]?.label).toContain("Broker Otter");
    expect(snapshot?.recentCycles).toHaveLength(1);
  });

  it("warns once when no canvas destination is configured", async () => {
    const { deps, getLastError } = createDeps({
      getSettings: () => ({}),
      getControlPlaneCanvasRuntimeId: () => null,
    });
    const canvas = createPinetControlPlaneCanvas(deps);
    const { ctx, notify } = createContext();
    const input = createRefreshInput();

    await canvas.refreshBrokerControlPlaneCanvasDashboard(ctx, input);
    await canvas.refreshBrokerControlPlaneCanvasDashboard(ctx, input);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker control plane canvas skipped: set slack-bridge.controlPlaneCanvasChannel, defaultChannel, or controlPlaneCanvasId.",
      "warning",
    );
    expect(getLastError()).toBe(
      "Pinet broker control plane canvas skipped: set slack-bridge.controlPlaneCanvasChannel, defaultChannel, or controlPlaneCanvasId.",
    );
  });

  it("refreshes the broker control-plane canvas, persists runtime ids, and notifies on creation", async () => {
    const {
      deps,
      slack,
      resolveChannel,
      persistState,
      getRuntimeCanvasId,
      getRuntimeChannelId,
      getLastRefreshAt,
      getLastError,
    } = createDeps({
      getSettings: () => ({
        controlPlaneCanvasChannel: "ops-control",
        controlPlaneCanvasTitle: "Broker Canvas",
      }),
      slack: vi.fn(async (method: string) => {
        if (method === "conversations.canvases.create") {
          return { ok: true, canvas_id: "FNEWCANVAS" };
        }
        return { ok: true };
      }),
    });
    const canvas = createPinetControlPlaneCanvas(deps);
    const { ctx, notify } = createContext();

    await canvas.refreshBrokerControlPlaneCanvasDashboard(ctx, createRefreshInput());

    expect(resolveChannel).toHaveBeenCalledWith("ops-control");
    expect(slack).toHaveBeenCalledWith(
      "conversations.canvases.create",
      "xoxb-test",
      expect.objectContaining({ channel_id: "C123CANVAS", title: "Broker Canvas" }),
    );
    expect(deps.restoreControlPlaneCanvasRuntimeState).toHaveBeenCalledWith({
      canvasId: "FNEWCANVAS",
      channelId: "C123CANVAS",
    });
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(getRuntimeCanvasId()).toBe("FNEWCANVAS");
    expect(getRuntimeChannelId()).toBe("C123CANVAS");
    expect(getLastRefreshAt()).toBe("2026-04-15T00:00:00.000Z");
    expect(getLastError()).toBeNull();
    expect(notify).toHaveBeenCalledWith(
      "Pinet broker control plane canvas created: FNEWCANVAS via ops-control",
      "info",
    );
  });
});
