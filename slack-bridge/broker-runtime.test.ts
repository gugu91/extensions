import { describe, expect, it, vi } from "vitest";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-canvas.js";
import { createBrokerRuntime, type BrokerRuntimeDeps } from "./broker-runtime.js";
import type { SlackActivityLogger } from "./activity-log.js";

function createDeps(overrides: Partial<BrokerRuntimeDeps> = {}): BrokerRuntimeDeps {
  return {
    getSettings: () => ({}),
    getBotToken: () => "xoxb-test",
    getAppToken: () => "xapp-test",
    getAllowedUsers: () => null,
    shouldAllowAllWorkspaceUsers: () => false,
    getBrokerStableId: () => "broker-stable-id",
    setBrokerStableId: vi.fn(),
    getActiveSkinTheme: () => null,
    setActiveSkinTheme: vi.fn(),
    setAgentOwnerToken: vi.fn(),
    getAgentMetadata: vi.fn(async () => ({})),
    applyLocalAgentIdentity: vi.fn(),
    buildSkinMetadata: vi.fn((metadata) => metadata ?? {}),
    getMeshRoleFromMetadata: vi.fn(
      () => "broker" as ReturnType<BrokerRuntimeDeps["getMeshRoleFromMetadata"]>,
    ) as BrokerRuntimeDeps["getMeshRoleFromMetadata"],
    handleInboundMessage: vi.fn(),
    onAppHomeOpened: vi.fn(),
    pushInboxMessages: vi.fn(),
    updateBadge: vi.fn(),
    maybeDrainInboxIfIdle: vi.fn(() => false),
    requestRemoteControl: vi.fn(() => ({
      accepted: true,
      shouldStartNow: false,
      status: "queued" as const,
      scheduledCommand: "reload" as const,
      ackDisposition: "immediate" as const,
      currentCommand: null,
      queuedCommand: null,
    })),
    deferControlAck: vi.fn(),
    runRemoteControl: vi.fn(),
    applySkinUpdate: vi.fn(),
    formatError: (error: unknown) => String(error),
    deliveryState: {
      pendingInboxIds: new Set<number>(),
    },
    onMaintenanceResult: vi.fn(),
    onMaintenanceError: vi.fn(),
    onScheduledWakeupError: vi.fn(),
    onAgentStatusChange: vi.fn(),
    createActivityLogger: vi.fn(
      () =>
        ({
          clearPending: vi.fn(),
          getRecentEntries: vi.fn(() => []),
          log: vi.fn(),
        }) as unknown as SlackActivityLogger,
    ),
    formatTrackedAgent: vi.fn((agentId: string) => agentId),
    summarizeTrackedAssignmentStatus: vi.fn(() => ({
      summary: "assigned",
      tone: "info" as const,
    })),
    sendMaintenanceMessage: vi.fn(),
    trySendFollowUp: vi.fn(),
    refreshCanvasDashboard: vi.fn(async () => undefined),
    refreshHomeTabs: vi.fn(async () => undefined),
    buildControlPlaneDashboardSnapshot: vi.fn(
      (input) => input as unknown as BrokerControlPlaneDashboardSnapshot,
    ),
    buildCurrentDashboardSnapshot: vi.fn(async () => null),
    ...overrides,
  };
}

describe("broker-runtime", () => {
  it("keeps reusable control-plane canvas ids while clearing transient observability state", async () => {
    const runtime = createBrokerRuntime(createDeps());

    runtime.restoreControlPlaneCanvasRuntimeState({
      canvasId: "F123CANVAS",
      channelId: "C123CHANNEL",
    });
    runtime.setLastControlPlaneCanvasRefreshAt("2026-04-14T18:00:00.000Z");
    runtime.setLastControlPlaneCanvasError("canvas failed once");
    runtime.setLastHomeTabSnapshot({
      roster: [],
    } as unknown as BrokerControlPlaneDashboardSnapshot);
    runtime.setLastHomeTabRefreshAt("2026-04-14T18:01:00.000Z");
    runtime.setLastHomeTabError("home tab failed once");

    await runtime.disconnect();

    expect(runtime.getControlPlaneCanvasRuntimeId()).toBe("F123CANVAS");
    expect(runtime.getControlPlaneCanvasRuntimeChannelId()).toBe("C123CHANNEL");
    expect(runtime.getConfiguredBrokerControlPlaneCanvasId()).toBe("F123CANVAS");
    expect(runtime.getLastControlPlaneCanvasRefreshAt()).toBeNull();
    expect(runtime.getLastControlPlaneCanvasError()).toBeNull();
    expect(runtime.getHomeTabViewerIds()).toEqual([]);
    expect(runtime.getLastHomeTabSnapshot()).toBeNull();
    expect(runtime.getLastHomeTabRefreshAt()).toBeNull();
    expect(runtime.getLastHomeTabError()).toBeNull();
  });

  it("prefers explicit control-plane canvas ids over persisted runtime ids", () => {
    const runtime = createBrokerRuntime(
      createDeps({
        getSettings: () => ({ controlPlaneCanvasId: "FEXPLICIT" }),
      }),
    );

    runtime.restoreControlPlaneCanvasRuntimeState({
      canvasId: "FRUNTIME",
      channelId: "CRUNTIME",
    });

    expect(runtime.getConfiguredBrokerControlPlaneCanvasId()).toBe("FEXPLICIT");
  });
});
