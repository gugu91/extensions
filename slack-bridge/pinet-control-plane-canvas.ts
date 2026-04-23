import * as os from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { probeGitBranch } from "./git-metadata.js";
import {
  type RalphLoopAgentWorkload,
  type RalphLoopEvaluationOptions,
  type ResolvedSlackInstallTopology,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  filterAgentsForMeshVisibility,
  evaluateRalphLoopCycle,
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
  getSlackSurfaceInstalls: () => ResolvedSlackInstallTopology[];
  getDefaultSlackInstallId: () => string;
  slack: RefreshBrokerControlPlaneCanvasInput["slack"];
  resolveChannel: (installId: string, channelInput: string) => Promise<string | null>;
  persistState: () => void;
  getActiveBrokerDb: () => PinetControlPlaneCanvasBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;
  getLastMaintenance: () => BrokerMaintenanceResult | null;
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

function getInstallCanvasChannel(install: ResolvedSlackInstallTopology): string | null {
  return (
    normalizeOptionalSetting(install.controlPlaneCanvasChannel) ??
    normalizeOptionalSetting(install.defaultChannel)
  );
}

function getInstallCanvasTitle(install: ResolvedSlackInstallTopology): string {
  return normalizeOptionalSetting(install.controlPlaneCanvasTitle) ?? "Pinet Broker Control Plane";
}

function isInstallCanvasEnabled(install: ResolvedSlackInstallTopology): boolean {
  return install.controlPlaneCanvasEnabled ?? true;
}

export function createPinetControlPlaneCanvas(
  deps: PinetControlPlaneCanvasDeps,
): PinetControlPlaneCanvas {
  function getDefaultInstall(): ResolvedSlackInstallTopology | null {
    const installs = deps.getSlackSurfaceInstalls();
    return (
      installs.find((install) => install.installId === deps.getDefaultSlackInstallId()) ??
      installs[0] ??
      null
    );
  }

  function getExplicitBrokerControlPlaneCanvasId(): string | null {
    return normalizeOptionalSetting(getDefaultInstall()?.controlPlaneCanvasId);
  }

  function getConfiguredBrokerControlPlaneCanvasId(): string | null {
    return getExplicitBrokerControlPlaneCanvasId() ?? deps.getControlPlaneCanvasRuntimeId();
  }

  function getConfiguredBrokerControlPlaneCanvasChannel(): string | null {
    const install = getDefaultInstall();
    return install ? getInstallCanvasChannel(install) : null;
  }

  function getConfiguredBrokerControlPlaneCanvasTitle(): string {
    const install = getDefaultInstall();
    return install ? getInstallCanvasTitle(install) : "Pinet Broker Control Plane";
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
    const installs = deps.getSlackSurfaceInstalls().filter(isInstallCanvasEnabled);
    if (installs.length === 0) {
      deps.setLastControlPlaneCanvasError(null);
      return;
    }

    const defaultInstallId = deps.getDefaultSlackInstallId();
    const snapshot = buildBrokerControlPlaneDashboardSnapshot({
      ...input,
      homedir: os.homedir(),
    });
    const markdown = renderBrokerControlPlaneCanvasMarkdown(snapshot);

    let refreshedInstallCount = 0;
    const errors: string[] = [];
    let defaultInstallMissingDestination = false;

    for (const install of installs) {
      if (!install.botToken) {
        continue;
      }

      const explicitCanvasId = normalizeOptionalSetting(install.controlPlaneCanvasId);
      const channelInput = getInstallCanvasChannel(install);
      if (!explicitCanvasId && !channelInput) {
        if (install.installId === defaultInstallId) {
          defaultInstallMissingDestination = true;
        }
        continue;
      }

      try {
        const channelId =
          explicitCanvasId || !channelInput
            ? null
            : await deps.resolveChannel(install.installId, channelInput);
        if (!explicitCanvasId && channelInput && !channelId) {
          throw new Error(
            `Unable to resolve Slack channel ${JSON.stringify(channelInput)} for install ${install.installId}.`,
          );
        }

        const runtimeCanvasId =
          install.installId === defaultInstallId ? deps.getControlPlaneCanvasRuntimeId() : null;
        const runtimeChannelId =
          install.installId === defaultInstallId
            ? deps.getControlPlaneCanvasRuntimeChannelId()
            : null;
        const reusableRuntimeCanvasId =
          install.installId === defaultInstallId &&
          !explicitCanvasId &&
          runtimeCanvasId &&
          (!channelId || runtimeChannelId === channelId)
            ? runtimeCanvasId
            : null;
        const result = await refreshBrokerControlPlaneCanvas({
          slack: deps.slack,
          token: install.botToken,
          markdown,
          canvasId: explicitCanvasId ?? reusableRuntimeCanvasId,
          channelId,
          title: getInstallCanvasTitle(install),
        });

        if (install.installId === defaultInstallId) {
          if (!explicitCanvasId) {
            deps.restoreControlPlaneCanvasRuntimeState({
              canvasId: result.canvasId,
              channelId,
            });
          }
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

        refreshedInstallCount += 1;
      } catch (error) {
        errors.push(
          `install ${install.installId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (refreshedInstallCount === 0 && defaultInstallMissingDestination) {
      const warning =
        "Pinet broker control plane canvas skipped: set slack-bridge.controlPlaneCanvasChannel, defaultChannel, or controlPlaneCanvasId.";
      if (deps.getLastControlPlaneCanvasError() !== warning) {
        ctx.ui.notify(warning, "warning");
      }
      deps.setLastControlPlaneCanvasError(warning);
      return;
    }

    if (refreshedInstallCount > 0) {
      deps.setLastControlPlaneCanvasRefreshAt(input.cycleStartedAt);
    }

    if (errors.length > 0) {
      const message = `Pinet broker control plane canvas failed: ${errors.join("; ")}`;
      deps.setLastControlPlaneCanvasError(message);
      throw new Error(message);
    }

    deps.setLastControlPlaneCanvasError(null);
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
