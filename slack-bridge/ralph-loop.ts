import * as os from "node:os";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type RalphLoopEvaluationOptions,
  evaluateRalphLoopCycle,
  rewriteRalphLoopGhostAnomalies,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopCycleNotifications,
  buildRalphLoopStatusMessage,
  shouldDeliverRalphLoopFollowUp,
  filterAgentsForMeshVisibility,
  DEFAULT_RALPH_LOOP_INTERVAL_MS,
  DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
} from "./helpers.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import {
  getPendingTaskAssignmentReport,
  hasTaskAssignmentStatusChange,
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type ResolvedTaskAssignment,
} from "./task-assignments.js";
import type { ActivityLogEntry, ActivityLogTone } from "./activity-log.js";
import { probeGitBranch } from "./git-metadata.js";
import type { BrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-canvas.js";
import type { BrokerMaintenanceResult } from "./broker/maintenance.js";
import type { BrokerDB } from "./broker/schema.js";
import type { TaskAssignmentInfo } from "./broker/types.js";

// ─── State ───────────────────────────────────────────────

export interface RalphLoopState {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  nudges: Map<string, number>;
  reportedGhosts: Set<string>;
  ghostBaselineHydrated: boolean;
  nonGhostSignature: string;
  hadOutstandingAnomalies: boolean;
  followUpAt: number;
  followUpPending: boolean;
  taskAssignmentReportSignature: string;
  pendingTaskAssignmentReport: { message: string; signature: string } | null;
}

export function createRalphLoopState(): RalphLoopState {
  return {
    timer: null,
    running: false,
    nudges: new Map(),
    reportedGhosts: new Set(),
    ghostBaselineHydrated: false,
    nonGhostSignature: "",
    hadOutstandingAnomalies: false,
    followUpAt: 0,
    followUpPending: false,
    taskAssignmentReportSignature: "",
    pendingTaskAssignmentReport: null,
  };
}

export function resetRalphLoopState(state: RalphLoopState): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.running = false;
  state.nudges.clear();
  state.reportedGhosts.clear();
  state.ghostBaselineHydrated = false;
  state.nonGhostSignature = "";
  state.hadOutstandingAnomalies = false;
  state.followUpAt = 0;
  state.followUpPending = false;
  state.taskAssignmentReportSignature = "";
  state.pendingTaskAssignmentReport = null;
}

// ─── Callbacks ───────────────────────────────────────────

export function hydrateRalphLoopReportedGhosts(
  state: Pick<RalphLoopState, "reportedGhosts" | "ghostBaselineHydrated">,
  recentCycles: Array<{ ghostAgentIds: string[] }>,
): void {
  if (state.ghostBaselineHydrated) {
    return;
  }

  if (state.reportedGhosts.size > 0) {
    state.ghostBaselineHydrated = true;
    return;
  }

  for (const ghostId of recentCycles[0]?.ghostAgentIds ?? []) {
    state.reportedGhosts.add(ghostId);
  }
  state.ghostBaselineHydrated = true;
}

export interface RalphLoopDeps {
  // Broker access
  getBrokerDb: () => BrokerDB | null;
  getBrokerAgentId: () => string | null;
  heartbeatTimerActive: () => boolean;
  maintenanceTimerActive: () => boolean;

  // Callbacks
  runMaintenance: (ctx: ExtensionContext) => void;
  sendMaintenanceMessage: (targetAgentId: string, body: string) => void;
  trySendFollowUp: (body: string, onDelivered: () => void) => void;
  logActivity: (entry: ActivityLogEntry) => void;
  formatTrackedAgent: (agentId: string) => string;
  summarizeTrackedAssignmentStatus: (
    status: string,
    prNumber: number | null,
    branch: string | null,
  ) => { summary: string; tone?: string };
  refreshCanvasDashboard: (ctx: ExtensionContext, input: Record<string, unknown>) => Promise<void>;
  refreshHomeTabs: (
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
  ) => Promise<void>;
  getLastMaintenance: () => BrokerMaintenanceResult | null;

  // Snapshot builder
  buildControlPlaneDashboardSnapshot: (
    input: Record<string, unknown>,
  ) => BrokerControlPlaneDashboardSnapshot;

  // State setters for control plane tracking
  setLastHomeTabSnapshot: (snapshot: BrokerControlPlaneDashboardSnapshot) => void;
  getLastCanvasError: () => string | null;
  setLastCanvasError: (err: string | null) => void;
  getLastHomeTabError: () => string | null;
  setLastHomeTabError: (err: string | null) => void;
}

// ─── Core loop ───────────────────────────────────────────

export async function runRalphLoopCycle(
  ctx: ExtensionContext,
  state: RalphLoopState,
  deps: RalphLoopDeps,
): Promise<void> {
  const db = deps.getBrokerDb();
  const selfId = deps.getBrokerAgentId();
  if (!db || !selfId || state.running) return;

  state.running = true;
  const cycleStartedAt = new Date().toISOString();
  const cycleStartMs = Date.now();
  try {
    hydrateRalphLoopReportedGhosts(state, db.getRecentRalphCycles(1));
    deps.runMaintenance(ctx);
    const lastMaintenance = deps.getLastMaintenance();

    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    const now = Date.now();
    const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;

    const workloads = filterAgentsForMeshVisibility(db.getAllAgents(), {
      now,
      includeGhosts: true,
      recentDisconnectWindowMs: recentGhostWindowMs,
    }).map((agent) => ({
      ...agent,
      pendingInboxCount: db.getPendingInboxCount(agent.id),
      ownedThreadCount: db.getOwnedThreadCount(agent.id),
    }));
    const pendingBacklogCount = db.getBacklogCount("pending");
    const evaluationOptions: RalphLoopEvaluationOptions = {
      now,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
      pendingBacklogCount,
      currentBranch,
      brokerHeartbeatActive: deps.heartbeatTimerActive(),
      brokerMaintenanceActive: deps.maintenanceTimerActive(),
      brokerAgentId: selfId,
    };
    const evaluation = evaluateRalphLoopCycle(workloads, evaluationOptions);

    const nudgeAgentIds = new Set(evaluation.nudgeAgentIds);
    for (const workload of workloads) {
      if (!nudgeAgentIds.has(workload.id)) {
        state.nudges.delete(workload.id);
        continue;
      }

      const lastNudgeAt = state.nudges.get(workload.id) ?? 0;
      if (now - lastNudgeAt < DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS) {
        continue;
      }

      deps.sendMaintenanceMessage(
        workload.id,
        buildRalphLoopNudgeMessage(
          workload.pendingInboxCount,
          workload.ownedThreadCount,
          cycleStartedAt,
        ),
      );
      state.nudges.set(workload.id, now);
    }

    const ghostRewrite = rewriteRalphLoopGhostAnomalies(evaluation, state.reportedGhosts, {
      suppressedGhostIds: lastMaintenance?.reapedAgentIds ?? [],
    });
    state.reportedGhosts.clear();
    for (const ghostId of ghostRewrite.nextReportedGhostIds) {
      state.reportedGhosts.add(ghostId);
    }

    const visibleEvaluation = ghostRewrite.evaluation;
    const visibleSignature = buildRalphLoopAnomalySignature(visibleEvaluation);
    const nonGhostSignature = ghostRewrite.nonGhostAnomalies.join("|");
    const hasOutstandingAnomalies =
      visibleEvaluation.ghostAgentIds.length > 0 || visibleEvaluation.anomalies.length > 0;
    const ralphNotifications = buildRalphLoopCycleNotifications(visibleEvaluation, cycleStartedAt);
    const followUpPrompt =
      ghostRewrite.newGhostIds.length === 0 &&
      ghostRewrite.clearedGhostIds.length > 0 &&
      ghostRewrite.nonGhostAnomalies.length === 0
        ? null
        : ralphNotifications.followUpPrompt;

    const agentsById = new Map(
      workloads.map((workload) => [workload.id, { emoji: workload.emoji, name: workload.name }]),
    );
    let projectedAssignments: ResolvedTaskAssignment[] = [];
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
    if (trackedAssignments.length === 0) {
      state.pendingTaskAssignmentReport = null;
      state.taskAssignmentReportSignature = "";
    } else {
      const resolvedAssignments = await resolveTaskAssignments(
        trackedAssignments as TaskAssignmentInfo[],
        process.cwd(),
      );
      const changedAssignments = resolvedAssignments.filter(hasTaskAssignmentStatusChange);
      projectedAssignments = resolvedAssignments.map((assignment) => {
        if (hasTaskAssignmentStatusChange(assignment)) {
          db.updateTaskAssignmentProgress(
            assignment.id,
            assignment.nextStatus,
            assignment.nextPrNumber,
          );
        }
        return { ...assignment, status: assignment.nextStatus, prNumber: assignment.nextPrNumber };
      });

      if (changedAssignments.length > 0) {
        const openedCount = changedAssignments.filter((a) => a.nextStatus === "pr_open").length;
        const mergedCount = changedAssignments.filter((a) => a.nextStatus === "pr_merged").length;
        const closedCount = changedAssignments.filter((a) => a.nextStatus === "pr_closed").length;
        const tone: ActivityLogTone =
          closedCount > 0 ? "warning" : mergedCount > 0 || openedCount > 0 ? "success" : "info";
        const title =
          mergedCount > 0
            ? mergedCount === 1
              ? "Task merged"
              : "Tasks merged"
            : openedCount > 0
              ? openedCount === 1
                ? "Worker completion recorded"
                : "Worker completions recorded"
              : "Task progress updated";
        const summaryParts = [];
        if (openedCount > 0)
          summaryParts.push(
            `${openedCount} worker completion${openedCount === 1 ? "" : "s"} moved to PR open`,
          );
        if (mergedCount > 0)
          summaryParts.push(`${mergedCount} PR${mergedCount === 1 ? "" : "s"} merged`);
        if (closedCount > 0)
          summaryParts.push(`${closedCount} PR${closedCount === 1 ? "" : "s"} closed`);
        if (summaryParts.length === 0) {
          summaryParts.push(
            `${changedAssignments.length} tracked assignment${changedAssignments.length === 1 ? " changed" : "s changed"}`,
          );
        }
        deps.logActivity({
          kind: "task_progress",
          level: "actions",
          title,
          summary: summaryParts.join("; "),
          details: changedAssignments.map((a) => {
            const next = deps.summarizeTrackedAssignmentStatus(
              a.nextStatus,
              a.nextPrNumber,
              a.branch,
            );
            return `${deps.formatTrackedAgent(a.agentId)} — #${a.issueNumber}: ${next.summary}`;
          }),
          fields: [
            { label: "Updated", value: changedAssignments.length },
            { label: "Merged", value: mergedCount },
            { label: "PR open", value: openedCount },
            { label: "Cycle", value: cycleStartedAt },
          ],
          tone,
        });
      }

      state.pendingTaskAssignmentReport = getPendingTaskAssignmentReport(
        projectedAssignments,
        agentsById,
        state.taskAssignmentReportSignature,
        cycleStartedAt,
      );
    }

    const shouldDeliverFollowUp =
      followUpPrompt != null &&
      shouldDeliverRalphLoopFollowUp({
        signature: visibleSignature,
        lastDeliveredAt: state.followUpAt,
        now,
        cooldownMs: DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
        pending: state.followUpPending,
        idle: ctx.isIdle?.() ?? true,
      });
    if (shouldDeliverFollowUp && followUpPrompt) {
      deps.trySendFollowUp(followUpPrompt, () => {
        state.followUpPending = true;
        state.followUpAt = now;
      });
    }
    if (state.pendingTaskAssignmentReport && (ctx.isIdle?.() ?? true)) {
      const reportToDeliver = state.pendingTaskAssignmentReport;
      deps.trySendFollowUp(reportToDeliver.message, () => {
        state.taskAssignmentReportSignature = reportToDeliver.signature;
        state.pendingTaskAssignmentReport = null;
      });
    }

    const shouldWarn =
      ghostRewrite.newGhostIds.length > 0 ||
      (nonGhostSignature.length > 0 && nonGhostSignature !== state.nonGhostSignature);
    const shouldInform =
      ghostRewrite.clearedGhostIds.length > 0 && visibleEvaluation.anomalies.length > 0;
    if (shouldWarn) {
      ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "warning");
    } else if (shouldInform) {
      ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "info");
    } else if (!hasOutstandingAnomalies && state.hadOutstandingAnomalies) {
      ctx.ui.notify(ralphNotifications.recoveryStatus, "info");
    }

    if (shouldWarn || shouldInform) {
      deps.logActivity({
        kind: "ralph_event",
        level: "actions",
        title: shouldWarn ? "RALPH anomaly detected" : "RALPH status updated",
        summary: ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected",
        details: visibleEvaluation.anomalies,
        fields: [
          { label: "Ghosts", value: visibleEvaluation.ghostAgentIds.length },
          { label: "Stuck", value: visibleEvaluation.stuckAgentIds.length },
          { label: "Nudged", value: visibleEvaluation.nudgeAgentIds.length },
          { label: "Backlog", value: pendingBacklogCount },
          { label: "Follow-up", value: shouldDeliverFollowUp },
        ],
        tone: shouldWarn ? "warning" : "info",
      });
    } else if (!hasOutstandingAnomalies && state.hadOutstandingAnomalies) {
      deps.logActivity({
        kind: "ralph_event",
        level: "actions",
        title: "RALPH recovered",
        summary: ralphNotifications.recoveryStatus,
        details: ["Previous ghost/stall/backlog anomalies cleared."],
        fields: [
          { label: "Backlog", value: pendingBacklogCount },
          { label: "Idle workers", value: visibleEvaluation.idleDrainAgentIds.length },
        ],
        tone: "success",
      });
    } else {
      deps.logActivity({
        kind: "ralph_cycle",
        level: "verbose",
        title: "RALPH cycle",
        summary:
          visibleEvaluation.anomalies.length > 0
            ? `${visibleEvaluation.anomalies.length} anomaly entries observed this cycle.`
            : "Broker health steady this cycle.",
        details: visibleEvaluation.anomalies.length > 0 ? visibleEvaluation.anomalies : undefined,
        fields: [
          { label: "Ghosts", value: visibleEvaluation.ghostAgentIds.length },
          { label: "Stuck", value: visibleEvaluation.stuckAgentIds.length },
          { label: "Nudged", value: visibleEvaluation.nudgeAgentIds.length },
          { label: "Idle", value: visibleEvaluation.idleDrainAgentIds.length },
          { label: "Backlog", value: pendingBacklogCount },
        ],
        tone: visibleEvaluation.anomalies.length > 0 ? "warning" : "info",
      });
    }
    state.nonGhostSignature = nonGhostSignature;
    state.hadOutstandingAnomalies = hasOutstandingAnomalies;

    let recentRalphCycles: Array<{
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
      ghostAgentIds: string[];
      stuckAgentIds: string[];
      anomalies: string[];
      followUpDelivered: boolean;
      agentCount: number;
      backlogCount: number;
    }> = [];
    try {
      const cycleCompletedAt = new Date().toISOString();
      db.recordRalphCycle({
        startedAt: cycleStartedAt,
        completedAt: cycleCompletedAt,
        durationMs: Date.now() - cycleStartMs,
        ghostAgentIds: visibleEvaluation.ghostAgentIds,
        nudgeAgentIds: visibleEvaluation.nudgeAgentIds,
        idleDrainAgentIds: visibleEvaluation.idleDrainAgentIds,
        stuckAgentIds: visibleEvaluation.stuckAgentIds,
        anomalies: visibleEvaluation.anomalies,
        anomalySignature: visibleSignature,
        followUpDelivered: shouldDeliverFollowUp,
        agentCount: workloads.filter((w) => !w.disconnectedAt).length,
        backlogCount: pendingBacklogCount,
      });
      recentRalphCycles = db.getRecentRalphCycles(5).map((cycle) => ({
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
    } catch {
      /* best effort */
    }

    const controlPlaneInput = {
      workloads,
      evaluation: visibleEvaluation,
      evaluationOptions,
      maintenance: lastMaintenance,
      assignments: projectedAssignments,
      recentCycles: recentRalphCycles,
      cycleStartedAt,
      cycleDurationMs: Date.now() - cycleStartMs,
      currentBranch,
      homedir: os.homedir(),
    };
    const controlPlaneSnapshot = deps.buildControlPlaneDashboardSnapshot(controlPlaneInput);
    deps.setLastHomeTabSnapshot(controlPlaneSnapshot);

    try {
      await deps.refreshCanvasDashboard(ctx, controlPlaneInput);
    } catch (canvasErr) {
      const canvasMessage = `Pinet broker control plane canvas refresh failed: ${errorMsg(canvasErr)}`;
      if (canvasMessage !== deps.getLastCanvasError()) {
        ctx.ui.notify(canvasMessage, "warning");
      }
      deps.setLastCanvasError(canvasMessage);
    }

    try {
      await deps.refreshHomeTabs(ctx, controlPlaneSnapshot, cycleStartedAt);
    } catch (homeTabErr) {
      const homeTabMessage = `Pinet Home tab publish failed: ${errorMsg(homeTabErr)}`;
      if (homeTabMessage !== deps.getLastHomeTabError()) {
        ctx.ui.notify(homeTabMessage, "warning");
      }
      deps.setLastHomeTabError(homeTabMessage);
    }
  } catch (err) {
    ctx.ui.notify(buildRalphLoopStatusMessage(`failed: ${errorMsg(err)}`, cycleStartedAt), "error");
    deps.logActivity({
      kind: "ralph_error",
      level: "errors",
      title: "RALPH loop failed",
      summary: errorMsg(err),
      fields: [{ label: "Cycle", value: cycleStartedAt }],
      tone: "error",
    });
  } finally {
    state.running = false;
  }
}

// ─── Timer management ────────────────────────────────────

export function startRalphLoop(
  ctx: ExtensionContext,
  state: RalphLoopState,
  deps: RalphLoopDeps,
): void {
  stopRalphLoop(state);
  state.timer = setInterval(() => {
    void runRalphLoopCycle(ctx, state, deps);
  }, DEFAULT_RALPH_LOOP_INTERVAL_MS);
  state.timer.unref?.();
  void runRalphLoopCycle(ctx, state, deps);
}

export function stopRalphLoop(state: RalphLoopState): void {
  resetRalphLoopState(state);
}

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
