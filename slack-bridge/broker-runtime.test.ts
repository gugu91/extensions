import { describe, expect, it, vi } from "vitest";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-dashboard.js";
import {
  createBrokerRuntime,
  resolveConfiguredBrokerSkinTheme,
  shouldRouteKnownSlackThread,
  type BrokerRuntimeDeps,
} from "./broker-runtime.js";
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
    refreshHomeTabs: vi.fn(async () => undefined),
    buildControlPlaneDashboardSnapshot: vi.fn(
      (input) => input as unknown as BrokerControlPlaneDashboardSnapshot,
    ),
    buildCurrentDashboardSnapshot: vi.fn(async () => null),
    ...overrides,
  };
}

describe("broker-runtime known Slack thread routing", () => {
  it("does not route legacy DM assistant threads without persisted context after cache loss", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "D123",
        metadata: null,
      }),
    ).toBe(false);
  });

  it("routes DM assistant threads once Slack context is persisted", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "D123",
        metadata: {
          slackThreadContext: {
            channelId: "C_TEAM",
            scope: {
              workspace: {
                provider: "slack",
                source: "compatibility",
                compatibilityKey: "default",
                channelId: "C_TEAM",
              },
              instance: { source: "compatibility", compatibilityKey: "default" },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("continues routing non-DM Slack threads without extra context", () => {
    expect(
      shouldRouteKnownSlackThread({
        source: "slack",
        channel: "C123",
        metadata: null,
      }),
    ).toBe(true);
  });
});

describe("broker-runtime", () => {
  it("resolves broker skin strictly from config with default fallback", () => {
    expect(resolveConfiguredBrokerSkinTheme({ skinTheme: "foundation" })).toBe("foundation");
    expect(resolveConfiguredBrokerSkinTheme({ skinTheme: "classic" })).toBe("default");
    expect(resolveConfiguredBrokerSkinTheme({})).toBe("default");
  });

  it("clears transient Home tab observability state on disconnect", async () => {
    const runtime = createBrokerRuntime(createDeps());

    runtime.setLastHomeTabSnapshot({
      roster: [],
    } as unknown as BrokerControlPlaneDashboardSnapshot);
    runtime.setLastHomeTabRefreshAt("2026-04-14T18:01:00.000Z");
    runtime.setLastHomeTabError("home tab failed once");

    await runtime.disconnect();

    expect(runtime.getHomeTabViewerIds()).toEqual([]);
    expect(runtime.getLastHomeTabSnapshot()).toBeNull();
    expect(runtime.getLastHomeTabRefreshAt()).toBeNull();
    expect(runtime.getLastHomeTabError()).toBeNull();
  });
});
