import type {
  AgentDisplayInfo,
  RalphLoopAgentWorkload,
  RalphLoopEvaluationOptions,
  RalphLoopEvaluationResult,
} from "../helpers.js";
import { buildAgentDisplayInfo, shortenPath } from "../helpers.js";
import {
  buildSlackCanvasCreateRequest,
  buildSlackCanvasEditRequest,
  extractSlackChannelCanvasId,
} from "../canvases.js";
import type { ResolvedTaskAssignment } from "../task-assignments.js";
import type { BrokerMaintenanceResult } from "./maintenance.js";

export type BrokerControlPlaneRecentCycle = {
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  ghostAgentIds: string[];
  stuckAgentIds: string[];
  anomalies: string[];
  followUpDelivered: boolean;
  agentCount: number;
  backlogCount: number;
};

export interface BrokerControlPlaneAgentRow {
  id: string;
  role: string;
  label: string;
  status: string;
  health: string;
  workload: string;
  taskSummary: string;
  heartbeat: string;
  branch: string;
  worktree: string;
}

export interface BrokerControlPlaneDashboardSnapshot {
  cycleStartedAt: string;
  cycleDurationMs: number;
  currentBranch: string | null;
  totalAgents: number;
  liveAgents: number;
  brokerCount: number;
  workerCount: number;
  idleWorkers: number;
  workingWorkers: number;
  ghostAgents: number;
  stuckAgents: number;
  pendingBacklogCount: number;
  nudgesThisCycle: number;
  idleDrainCandidates: number;
  assignedBacklogCount: number;
  reapedAgents: number;
  repairedThreadClaims: number;
  maintenanceAnomalies: string[];
  anomalies: string[];
  taskCounts: {
    assigned: number;
    branchPushed: number;
    openPrs: number;
    mergedPrs: number;
    closedPrs: number;
  };
  activeTasks: string[];
  recentOutcomes: string[];
  roster: BrokerControlPlaneAgentRow[];
  recentCycles: Array<{
    startedAt: string;
    duration: string;
    agentCount: number;
    backlogCount: number;
    ghostCount: number;
    stuckCount: number;
    anomalySummary: string;
    followUpDelivered: boolean;
  }>;
}

export interface BuildBrokerControlPlaneDashboardSnapshotInput {
  workloads: RalphLoopAgentWorkload[];
  evaluation: RalphLoopEvaluationResult;
  evaluationOptions?: RalphLoopEvaluationOptions;
  maintenance: BrokerMaintenanceResult | null;
  assignments: Array<
    Pick<
      ResolvedTaskAssignment,
      "agentId" | "issueNumber" | "branch" | "status" | "prNumber" | "updatedAt" | "issueState"
    >
  >;
  recentCycles: BrokerControlPlaneRecentCycle[];
  cycleStartedAt: string;
  cycleDurationMs: number;
  currentBranch: string | null;
  homedir?: string;
}

export interface RefreshBrokerControlPlaneCanvasInput {
  slack: (
    method: string,
    token: string,
    body?: Record<string, unknown>,
  ) => Promise<{
    [key: string]: unknown;
  }>;
  token: string;
  markdown: string;
  canvasId?: string | null;
  channelId?: string | null;
  title?: string;
}

export interface RefreshBrokerControlPlaneCanvasResult {
  canvasId: string;
  created: boolean;
  reusedExistingChannelCanvas: boolean;
  updated: boolean;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)}m`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed)
    .toISOString()
    .replace("T", " ")
    .replace(".000", "")
    .replace(/:\d\dZ$/, "Z");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br/>");
}

function getAgentRole(agent: Pick<AgentDisplayInfo, "metadata">): string {
  const capabilitiesRole = agent.metadata?.capabilities?.role;
  const metadataRole = agent.metadata?.role;
  return capabilitiesRole ?? metadataRole ?? "worker";
}

function buildWorkloadSummary(
  workload: Pick<RalphLoopAgentWorkload, "pendingInboxCount" | "ownedThreadCount">,
): string {
  const parts = [
    `${workload.pendingInboxCount} inbox`,
    `${workload.ownedThreadCount} thread${workload.ownedThreadCount === 1 ? "" : "s"}`,
  ];
  return parts.join(" / ");
}

function formatTaskStatusShort(
  assignment: Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">,
): string {
  switch (assignment.status) {
    case "pr_open":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} open`;
    case "pr_merged":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} merged`;
    case "pr_closed":
      return `#${assignment.issueNumber} PR #${assignment.prNumber ?? "?"} closed`;
    case "branch_pushed":
      return `#${assignment.issueNumber} pushed ${assignment.branch ?? "branch"}`;
    case "assigned":
    default:
      return `#${assignment.issueNumber} assigned`;
  }
}

function summarizeAgentTasks(
  assignments: Array<
    Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">
  >,
): string {
  if (assignments.length === 0) return "—";

  const ordered = [...assignments].sort((left, right) => left.issueNumber - right.issueNumber);
  const visible = ordered.slice(0, 2).map(formatTaskStatusShort);
  if (ordered.length > 2) {
    visible.push(`+${ordered.length - 2} more`);
  }
  return visible.join("; ");
}

function summarizeCycleAnomalies(anomalies: string[]): string {
  if (anomalies.length === 0) return "healthy";
  return truncateText(anomalies.join("; "), 72);
}

function isSlackMethodError(err: unknown, method: string, ...codes: string[]): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return codes.some((code) => err.message.includes(`Slack ${method}: ${code}`));
}

export function buildBrokerControlPlaneDashboardSnapshot(
  input: BuildBrokerControlPlaneDashboardSnapshotInput,
): BrokerControlPlaneDashboardSnapshot {
  const homedir = input.homedir ?? process.env.HOME ?? "";
  const visibleAssignments = input.assignments.filter(
    (assignment) => assignment.issueState !== "CLOSED",
  );
  const assignmentsByAgent = new Map<
    string,
    Array<Pick<ResolvedTaskAssignment, "issueNumber" | "status" | "prNumber" | "branch">>
  >();

  for (const assignment of visibleAssignments) {
    const bucket = assignmentsByAgent.get(assignment.agentId);
    const summaryAssignment = {
      issueNumber: assignment.issueNumber,
      status: assignment.status,
      prNumber: assignment.prNumber,
      branch: assignment.branch,
    };
    if (bucket) {
      bucket.push(summaryAssignment);
    } else {
      assignmentsByAgent.set(assignment.agentId, [summaryAssignment]);
    }
  }

  const displays = input.workloads
    .map((workload) => ({
      workload,
      display: buildAgentDisplayInfo(workload, input.evaluationOptions ?? {}),
    }))
    .sort((left, right) => {
      const leftRole = getAgentRole(left.display);
      const rightRole = getAgentRole(right.display);
      if (leftRole !== rightRole) {
        return leftRole === "broker" ? -1 : 1;
      }
      return left.display.name.localeCompare(right.display.name);
    });

  const brokerCount = displays.filter(({ display }) => getAgentRole(display) === "broker").length;
  const workerDisplays = displays.filter(({ display }) => getAgentRole(display) !== "broker");
  const liveAgents = displays.filter(({ workload }) => !workload.disconnectedAt).length;

  const roster = displays.map(({ workload, display }) => {
    const worktree =
      display.metadata?.worktreeKind === "linked" && display.metadata.worktreePath
        ? shortenPath(display.metadata.worktreePath, homedir)
        : display.metadata?.worktreeKind === "main"
          ? "main checkout"
          : "—";
    const branch = display.metadata?.branch ?? "—";
    const heartbeat = display.heartbeatSummary ?? display.leaseSummary ?? "unknown";
    const health = display.stuck
      ? `${display.health ?? "unknown"} / stuck`
      : (display.health ?? "unknown");
    return {
      id: display.id,
      role: getAgentRole(display),
      label: `${display.emoji} ${display.name}`,
      status: display.status,
      health,
      workload: buildWorkloadSummary(workload),
      taskSummary: summarizeAgentTasks(assignmentsByAgent.get(display.id) ?? []),
      heartbeat,
      branch,
      worktree,
    };
  });

  const sortedAssignments = [...visibleAssignments].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const activeTasks = sortedAssignments
    .filter(
      (assignment) =>
        assignment.status === "assigned" ||
        assignment.status === "branch_pushed" ||
        assignment.status === "pr_open",
    )
    .map((assignment) => formatTaskStatusShort(assignment))
    .slice(0, 8);
  const recentOutcomes = sortedAssignments
    .filter((assignment) => assignment.status === "pr_merged" || assignment.status === "pr_closed")
    .map((assignment) => formatTaskStatusShort(assignment))
    .slice(0, 8);

  return {
    cycleStartedAt: input.cycleStartedAt,
    cycleDurationMs: input.cycleDurationMs,
    currentBranch: input.currentBranch,
    totalAgents: displays.length,
    liveAgents,
    brokerCount,
    workerCount: workerDisplays.length,
    idleWorkers: workerDisplays.filter(({ display }) => display.status === "idle").length,
    workingWorkers: workerDisplays.filter(({ display }) => display.status === "working").length,
    ghostAgents: input.evaluation.ghostAgentIds.length,
    stuckAgents: input.evaluation.stuckAgentIds.length,
    pendingBacklogCount: input.maintenance?.pendingBacklogCount ?? 0,
    nudgesThisCycle: input.evaluation.nudgeAgentIds.length,
    idleDrainCandidates: input.evaluation.idleDrainAgentIds.length,
    assignedBacklogCount: input.maintenance?.assignedBacklogCount ?? 0,
    reapedAgents: input.maintenance?.reapedAgentIds.length ?? 0,
    repairedThreadClaims: input.maintenance?.repairedThreadClaims ?? 0,
    maintenanceAnomalies: input.maintenance?.anomalies ?? [],
    anomalies: input.evaluation.anomalies,
    taskCounts: {
      assigned: visibleAssignments.filter((assignment) => assignment.status === "assigned").length,
      branchPushed: visibleAssignments.filter((assignment) => assignment.status === "branch_pushed")
        .length,
      openPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_open").length,
      mergedPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_merged")
        .length,
      closedPrs: visibleAssignments.filter((assignment) => assignment.status === "pr_closed")
        .length,
    },
    activeTasks,
    recentOutcomes,
    roster,
    recentCycles: input.recentCycles.slice(0, 5).map((cycle) => ({
      startedAt: formatTimestamp(cycle.startedAt),
      duration: formatDuration(cycle.durationMs),
      agentCount: cycle.agentCount,
      backlogCount: cycle.backlogCount,
      ghostCount: cycle.ghostAgentIds.length,
      stuckCount: cycle.stuckAgentIds.length,
      anomalySummary: summarizeCycleAnomalies(cycle.anomalies),
      followUpDelivered: cycle.followUpDelivered,
    })),
  };
}

export function renderBrokerControlPlaneCanvasMarkdown(
  snapshot: BrokerControlPlaneDashboardSnapshot,
): string {
  const lines = [
    "# Pinet Broker Control Plane",
    "",
    `_Updated ${formatTimestamp(snapshot.cycleStartedAt)} · cycle ${formatDuration(snapshot.cycleDurationMs)}._`,
    "",
    "## Mesh summary",
    `- Main checkout: \`${snapshot.currentBranch ?? "unknown"}\``,
    `- Agents: ${snapshot.liveAgents} live / ${snapshot.totalAgents} total (${snapshot.brokerCount} broker, ${snapshot.workerCount} workers)`,
    `- Workers: ${snapshot.workingWorkers} working, ${snapshot.idleWorkers} idle, ${snapshot.ghostAgents} ghost, ${snapshot.stuckAgents} stuck`,
    `- Backlog: ${snapshot.pendingBacklogCount} pending · nudges ${snapshot.nudgesThisCycle} · idle drains ${snapshot.idleDrainCandidates}`,
    `- Maintenance: assigned ${snapshot.assignedBacklogCount} · reaped ${snapshot.reapedAgents} · repaired claims ${snapshot.repairedThreadClaims}`,
    "",
    "## Active anomalies",
    ...(snapshot.anomalies.length > 0
      ? snapshot.anomalies.map((anomaly) => `- ${anomaly}`)
      : ["- Healthy ✅"]),
    ...(snapshot.maintenanceAnomalies.length > 0
      ? [
          "",
          "### Maintenance anomalies",
          ...snapshot.maintenanceAnomalies.map((anomaly) => `- ${anomaly}`),
        ]
      : []),
    "",
    "## Agent roster",
    "| Agent | Role | Health | Status | Workload | Current task | Heartbeat | Branch | Worktree |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...snapshot.roster.map((row) =>
      [
        row.label,
        row.role,
        row.health,
        row.status,
        row.workload,
        truncateText(row.taskSummary, 72),
        row.heartbeat,
        row.branch,
        row.worktree,
      ]
        .map((cell) => escapeTableCell(cell))
        .join(" | ")
        .replace(/^/, "|")
        .concat(" |"),
    ),
    "",
    "## Task / PR status",
    `- Assigned: ${snapshot.taskCounts.assigned}`,
    `- Branch pushed: ${snapshot.taskCounts.branchPushed}`,
    `- Open PRs: ${snapshot.taskCounts.openPrs}`,
    `- Merged PRs: ${snapshot.taskCounts.mergedPrs}`,
    `- Closed PRs: ${snapshot.taskCounts.closedPrs}`,
    "",
    "### Active tasks",
    ...(snapshot.activeTasks.length > 0
      ? snapshot.activeTasks.map((task) => `- ${task}`)
      : ["- No active tracked tasks."]),
    "",
    "### Recent outcomes",
    ...(snapshot.recentOutcomes.length > 0
      ? snapshot.recentOutcomes.map((task) => `- ${task}`)
      : ["- No merged or closed PR outcomes tracked yet."]),
    "",
    "## Recent RALPH cycles",
    "| Started | Duration | Agents | Backlog | Ghosts | Stuck | Follow-up | Anomalies |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...(snapshot.recentCycles.length > 0
      ? snapshot.recentCycles.map((cycle) =>
          [
            cycle.startedAt,
            cycle.duration,
            String(cycle.agentCount),
            String(cycle.backlogCount),
            String(cycle.ghostCount),
            String(cycle.stuckCount),
            cycle.followUpDelivered ? "yes" : "no",
            cycle.anomalySummary,
          ]
            .map((cell) => escapeTableCell(cell))
            .join(" | ")
            .replace(/^/, "|")
            .concat(" |"),
        )
      : ["| none yet | n/a | 0 | 0 | 0 | 0 | no | awaiting first recorded cycle |"]),
  ];

  return `${lines.join("\n").trim()}\n`;
}

async function createOrRecoverChannelCanvas(
  input: RefreshBrokerControlPlaneCanvasInput,
  channelId: string,
): Promise<RefreshBrokerControlPlaneCanvasResult> {
  const createRequest = buildSlackCanvasCreateRequest({
    kind: "channel",
    channelId,
    title: input.title ?? "Pinet Broker Control Plane",
    markdown: input.markdown,
  });

  try {
    const response = await input.slack(createRequest.method, input.token, createRequest.body);
    const createdCanvasId = asString(response.canvas_id);
    if (!createdCanvasId) {
      throw new Error("Slack did not return a canvas_id for the control plane canvas.");
    }
    return {
      canvasId: createdCanvasId,
      created: true,
      reusedExistingChannelCanvas: false,
      updated: false,
    };
  } catch (err) {
    if (
      !isSlackMethodError(
        err,
        "conversations.canvases.create",
        "channel_canvas_already_exists",
        "free_team_canvas_tab_already_exists",
      )
    ) {
      throw err;
    }

    const info = await input.slack("conversations.info", input.token, { channel: channelId });
    const existingCanvasId = extractSlackChannelCanvasId(info);
    if (!existingCanvasId) {
      throw new Error(
        `Slack reported an existing channel canvas for ${channelId}, but conversations.info did not expose its canvas id.`,
      );
    }

    await input.slack(
      "canvases.edit",
      input.token,
      buildSlackCanvasEditRequest({
        canvasId: existingCanvasId,
        markdown: input.markdown,
        mode: "replace",
      }) as unknown as Record<string, unknown>,
    );

    return {
      canvasId: existingCanvasId,
      created: false,
      reusedExistingChannelCanvas: true,
      updated: true,
    };
  }
}

export async function refreshBrokerControlPlaneCanvas(
  input: RefreshBrokerControlPlaneCanvasInput,
): Promise<RefreshBrokerControlPlaneCanvasResult> {
  const canvasId = asString(input.canvasId);
  const channelId = asString(input.channelId);

  if (canvasId) {
    try {
      await input.slack(
        "canvases.edit",
        input.token,
        buildSlackCanvasEditRequest({
          canvasId,
          markdown: input.markdown,
          mode: "replace",
        }) as unknown as Record<string, unknown>,
      );
      return {
        canvasId,
        created: false,
        reusedExistingChannelCanvas: false,
        updated: true,
      };
    } catch (err) {
      if (
        !channelId ||
        !isSlackMethodError(err, "canvases.edit", "canvas_not_found", "invalid_arguments")
      ) {
        throw err;
      }
    }
  }

  if (!channelId) {
    throw new Error("Control plane canvas refresh requires either a canvas ID or channel ID.");
  }

  return createOrRecoverChannelCanvas(input, channelId);
}
