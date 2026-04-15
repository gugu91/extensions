import * as os from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { probeGitBranch } from "./git-metadata.js";
import {
  type RalphLoopAgentWorkload,
  type RalphLoopEvaluationOptions,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  filterAgentsForMeshVisibility,
  evaluateRalphLoopCycle,
  type SlackBridgeSettings,
} from "./helpers.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import type { BrokerMaintenanceResult } from "./broker/maintenance.js";
import type { TaskAssignmentInfo } from "./broker/types.js";
import {
  buildBrokerControlPlaneDashboardSnapshot,
  refreshBrokerControlPlaneCanvas,
  renderBrokerControlPlaneCanvasMarkdown,
  type BrokerControlPlaneDashboardSnapshot,
  type BrokerControlPlaneRecentCycle,
  type BuildBrokerControlPlaneDashboardSnapshotInput,
  type RefreshBrokerControlPlaneCanvasInput,
} from "./broker/control-plane-canvas.js";
import {
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type ResolvedTaskAssignment,
} from "./task-assignments.js";

export type PinetControlPlaneCanvasAgentRecord = Omit<
  RalphLoopAgentWorkload,
  "pendingInboxCount" | "ownedThreadCount"
>;

export interface PinetControlPlaneCanvasMessageRecord {
  id: number;
  body: string;
}

export interface PinetControlPlaneCanvasBrokerDbPort {
  getAllAgents: () => PinetControlPlaneCanvasAgentRecord[];
  getPendingInboxCount: (agentId: string) => number;
  getOwnedThreadCount: (agentId: string) => number;
  getBacklogCount: (status: "pending") => number;
  listTaskAssignments: () => TaskAssignmentInfo[];
  getMessagesByIds: (ids: number[]) => PinetControlPlaneCanvasMessageRecord[];
  getRecentRalphCycles: (limit: number) => BrokerControlPlaneRecentCycle[];
}

export type PinetControlPlaneCanvasRefreshInput = Omit<
  BuildBrokerControlPlaneDashboardSnapshotInput,
  "homedir"
>;

export interface PinetControlPlaneCanvasDeps {
  getSettings: () => SlackBridgeSettings;
  getBotToken: () => string | undefined;
  slack: RefreshBrokerControlPlaneCanvasInput["slack"];
  resolveChannel: (channelInput: string) => Promise<string | null>;
  persistState: () => void;
  getActiveBrokerDb: () => PinetControlPlaneCanvasBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;
  getLastMaintenance: () => BrokerMaintenanceResult | null;
  isBrokerControlPlaneCanvasEnabled: () => boolean;
  getControlPlaneCanvasRuntimeId: () => string | null;
  getControlPlaneCanvasRuntimeChannelId: () => string | null;
  restoreControlPlaneCanvasRuntimeState: (input: {
    canvasId: string | null;
    channelId: string | null;
  }) => void;
  setLastControlPlaneCanvasRefreshAt: (value: string | null) => void;
  getLastControlPlaneCanvasError: () => string | null;
  setLastControlPlaneCanvasError: (value: string | null) => void;
}

export interface PinetControlPlaneCanvas {
  getExplicitBrokerControlPlaneCanvasId: () => string | null;
  getConfiguredBrokerControlPlaneCanvasId: () => string | null;
  getConfiguredBrokerControlPlaneCanvasChannel: () => string | null;
  getConfiguredBrokerControlPlaneCanvasTitle: () => string;
  buildCurrentBrokerControlPlaneDashboardSnapshot: (
    cycleStartedAt?: string,
  ) => Promise<BrokerControlPlaneDashboardSnapshot | null>;
  refreshBrokerControlPlaneCanvasDashboard: (
    ctx: ExtensionContext,
    input: PinetControlPlaneCanvasRefreshInput,
  ) => Promise<void>;
}

function normalizeOptionalSetting(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function createPinetControlPlaneCanvas(
  deps: PinetControlPlaneCanvasDeps,
): PinetControlPlaneCanvas {
  function getExplicitBrokerControlPlaneCanvasId(): string | null {
    return normalizeOptionalSetting(deps.getSettings().controlPlaneCanvasId);
  }

  function getConfiguredBrokerControlPlaneCanvasId(): string | null {
    return getExplicitBrokerControlPlaneCanvasId() ?? deps.getControlPlaneCanvasRuntimeId();
  }

  function getConfiguredBrokerControlPlaneCanvasChannel(): string | null {
    return (
      normalizeOptionalSetting(deps.getSettings().controlPlaneCanvasChannel) ??
      normalizeOptionalSetting(deps.getSettings().defaultChannel)
    );
  }

  function getConfiguredBrokerControlPlaneCanvasTitle(): string {
    return (
      normalizeOptionalSetting(deps.getSettings().controlPlaneCanvasTitle) ??
      "Pinet Broker Control Plane"
    );
  }

  async function buildCurrentBrokerControlPlaneDashboardSnapshot(
    cycleStartedAt: string = new Date().toISOString(),
  ): Promise<BrokerControlPlaneDashboardSnapshot | null> {
    const db = deps.getActiveBrokerDb();
    if (!db) {
      return null;
    }

    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    const nowMs = Date.now();
    const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
    const workloads = filterAgentsForMeshVisibility(db.getAllAgents(), {
      now: nowMs,
      includeGhosts: true,
      recentDisconnectWindowMs: recentGhostWindowMs,
    }).map((agent) => ({
      ...agent,
      pendingInboxCount: db.getPendingInboxCount(agent.id),
      ownedThreadCount: db.getOwnedThreadCount(agent.id),
    }));
    const pendingBacklogCount = db.getBacklogCount("pending");
    const evaluationOptions: RalphLoopEvaluationOptions = {
      now: nowMs,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
      pendingBacklogCount,
      currentBranch,
      brokerHeartbeatActive: deps.heartbeatTimerActive(),
      brokerMaintenanceActive: deps.maintenanceTimerActive(),
      brokerAgentId: deps.getActiveBrokerSelfId() ?? undefined,
    };
    const evaluation = evaluateRalphLoopCycle(workloads, evaluationOptions);

    const rawTrackedAssignments = db.listTaskAssignments();
    const trackedAssignmentSourceIds = [
      ...new Set(
        rawTrackedAssignments
          .map((assignment) => assignment.sourceMessageId)
          .filter((messageId): messageId is number => messageId != null),
      ),
    ];
    const trackedAssignments = normalizeTrackedTaskAssignments(
      rawTrackedAssignments,
      new Map(
        db
          .getMessagesByIds(trackedAssignmentSourceIds)
          .map((message) => [message.id, message.body]),
      ),
    );
    let projectedAssignments: ResolvedTaskAssignment[] = [];
    if (trackedAssignments.length > 0) {
      const resolvedAssignments = await resolveTaskAssignments(trackedAssignments, process.cwd());
      projectedAssignments = resolvedAssignments.map((assignment) => ({
        ...assignment,
        status: assignment.nextStatus,
        prNumber: assignment.nextPrNumber,
      }));
    }

    const recentRalphCycles = db.getRecentRalphCycles(5).map((cycle) => ({
      startedAt: cycle.startedAt,
      completedAt: cycle.completedAt,
      durationMs: cycle.durationMs,
      ghostAgentIds: cycle.ghostAgentIds,
      stuckAgentIds: cycle.stuckAgentIds,
      anomalies: cycle.anomalies,
      followUpDelivered: cycle.followUpDelivered,
      agentCount: cycle.agentCount,
      backlogCount: cycle.backlogCount,
    }));

    return buildBrokerControlPlaneDashboardSnapshot({
      workloads,
      evaluation,
      evaluationOptions,
      maintenance: deps.getLastMaintenance(),
      assignments: projectedAssignments,
      recentCycles: recentRalphCycles,
      cycleStartedAt,
      cycleDurationMs: 0,
      currentBranch,
      homedir: os.homedir(),
    });
  }

  async function refreshBrokerControlPlaneCanvasDashboard(
    ctx: ExtensionContext,
    input: PinetControlPlaneCanvasRefreshInput,
  ): Promise<void> {
    const botToken = deps.getBotToken();
    if (!botToken || !deps.isBrokerControlPlaneCanvasEnabled()) {
      deps.setLastControlPlaneCanvasError(null);
      return;
    }

    const explicitCanvasId = getExplicitBrokerControlPlaneCanvasId();
    const effectiveCanvasId = getConfiguredBrokerControlPlaneCanvasId();
    const channelInput = getConfiguredBrokerControlPlaneCanvasChannel();
    if (!effectiveCanvasId && !channelInput) {
      const warning =
        "Pinet broker control plane canvas skipped: set slack-bridge.controlPlaneCanvasChannel, defaultChannel, or controlPlaneCanvasId.";
      if (deps.getLastControlPlaneCanvasError() !== warning) {
        ctx.ui.notify(warning, "warning");
      }
      deps.setLastControlPlaneCanvasError(warning);
      return;
    }

    const snapshot = buildBrokerControlPlaneDashboardSnapshot({
      ...input,
      homedir: os.homedir(),
    });
    const markdown = renderBrokerControlPlaneCanvasMarkdown(snapshot);
    const channelId =
      explicitCanvasId || !channelInput ? null : await deps.resolveChannel(channelInput);
    const runtimeCanvasId = deps.getControlPlaneCanvasRuntimeId();
    const runtimeChannelId = deps.getControlPlaneCanvasRuntimeChannelId();
    const reusableRuntimeCanvasId =
      !explicitCanvasId && runtimeCanvasId && (!channelId || runtimeChannelId === channelId)
        ? runtimeCanvasId
        : null;
    const result = await refreshBrokerControlPlaneCanvas({
      slack: deps.slack,
      token: botToken,
      markdown,
      canvasId: explicitCanvasId ?? reusableRuntimeCanvasId,
      channelId,
      title: getConfiguredBrokerControlPlaneCanvasTitle(),
    });

    if (!explicitCanvasId) {
      deps.restoreControlPlaneCanvasRuntimeState({
        canvasId: result.canvasId,
        channelId,
      });
    }
    deps.setLastControlPlaneCanvasRefreshAt(input.cycleStartedAt);
    deps.setLastControlPlaneCanvasError(null);

    if (
      !explicitCanvasId &&
      (result.canvasId !== runtimeCanvasId || channelId !== runtimeChannelId)
    ) {
      deps.persistState();
      const destination = channelInput ? ` via ${channelInput}` : "";
      const action = result.created
        ? "created"
        : result.reusedExistingChannelCanvas
          ? "attached"
          : "updated";
      ctx.ui.notify(
        `Pinet broker control plane canvas ${action}: ${result.canvasId}${destination}`,
        "info",
      );
    }
  }

  return {
    getExplicitBrokerControlPlaneCanvasId,
    getConfiguredBrokerControlPlaneCanvasId,
    getConfiguredBrokerControlPlaneCanvasChannel,
    getConfiguredBrokerControlPlaneCanvasTitle,
    buildCurrentBrokerControlPlaneDashboardSnapshot,
    refreshBrokerControlPlaneCanvasDashboard,
  };
}
