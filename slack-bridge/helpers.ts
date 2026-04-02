import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Settings ────────────────────────────────────────────

export interface SlackBridgeSettings {
  botToken?: string;
  appToken?: string;
  allowedUsers?: string[];
  defaultChannel?: string;
  suggestedPrompts?: { title: string; message: string }[];
  autoConnect?: boolean;
  autoFollow?: boolean;
  agentName?: string;
  agentEmoji?: string;
  security?: {
    readOnly?: boolean;
    requireConfirmation?: string[];
    blockedTools?: string[];
  };
}

export function loadSettings(settingsPath?: string): SlackBridgeSettings {
  const p = settingsPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  try {
    const content = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(content);
    return (parsed["slack-bridge"] as SlackBridgeSettings) ?? {};
  } catch {
    return {};
  }
}

// ─── Allowlist ───────────────────────────────────────────

export function buildAllowlist(settings: SlackBridgeSettings, envVar?: string): Set<string> | null {
  if (settings.allowedUsers && settings.allowedUsers.length > 0) {
    return new Set(settings.allowedUsers);
  }
  if (envVar) {
    return new Set(
      envVar
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
  }
  return null;
}

export function isUserAllowed(allowlist: Set<string> | null, userId: string): boolean {
  return allowlist === null || allowlist.has(userId);
}

// ─── Inbox formatting ────────────────────────────────────

export interface InboxMessage {
  channel: string;
  threadTs: string;
  userId: string;
  text: string;
  timestamp: string;
  isChannelMention?: boolean;
}

export interface SqliteJournalModeResult {
  journal_mode?: string | null;
}

export function getSqliteJournalMode(result?: SqliteJournalModeResult): string {
  const mode = result?.journal_mode?.trim().toLowerCase();
  return mode && mode.length > 0 ? mode : "unknown";
}

export function isSqliteWalEnabled(result?: SqliteJournalModeResult): boolean {
  return getSqliteJournalMode(result) === "wal";
}

export function buildSqliteWalFallbackWarning(
  component: string,
  result?: SqliteJournalModeResult,
): string {
  return `[${component}] SQLite WAL mode not available, using ${getSqliteJournalMode(result)} journal mode fallback`;
}

export function formatInboxMessages(
  messages: InboxMessage[],
  userNames: { get(key: string): string | undefined },
): string {
  const lines = messages.map((m) => {
    const n = userNames.get(m.userId) ?? m.userId;
    if (m.isChannelMention) {
      return `[thread ${m.threadTs}] (channel mention in <#${m.channel}>) ${n}: ${m.text}`;
    }
    return `[thread ${m.threadTs}] ${n}: ${m.text}`;
  });

  return `New Slack messages:\n${lines.join("\n")}\n\nACK briefly, do the work, report blockers immediately, report the outcome when done.`;
}

// ─── Slack API encoding ──────────────────────────────────

export const FORM_METHODS = new Set([
  "auth.test",
  "users.info",
  "conversations.list",
  "conversations.history",
  "conversations.replies",
  "conversations.info",
  "apps.connections.open",
]);

export function buildSlackRequest(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let serialized: string | undefined;
  const needsJson = !FORM_METHODS.has(method);

  if (body) {
    if (needsJson) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      serialized = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      serialized = new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)]),
      ).toString();
    }
  }

  return {
    url: `https://slack.com/api/${method}`,
    init: {
      method: "POST",
      headers,
      ...(serialized ? { body: serialized } : {}),
    },
  };
}

// ─── Mention stripping ───────────────────────────────────

export function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
}

// ─── Channel ID detection ────────────────────────────────

export function isChannelId(nameOrId: string): boolean {
  return /^[CGD][A-Z0-9]+$/.test(nameOrId);
}

// ─── Agent list formatting ───────────────────────────────

export interface AgentCapabilities {
  repo?: string;
  repoRoot?: string;
  branch?: string;
  role?: string;
  tools?: string[];
  tags?: string[];
}

export type AgentHealth = "healthy" | "stale" | "ghost" | "resumable";

export interface AgentDisplayInfo {
  emoji: string;
  name: string;
  id: string;
  pid?: number;
  status: "working" | "idle";
  metadata?: {
    cwd?: string;
    branch?: string;
    host?: string;
    repo?: string;
    role?: string;
    capabilities?: AgentCapabilities | null;
  } | null;
  lastHeartbeat?: string;
  leaseExpiresAt?: string | null;
  heartbeatAgeMs?: number | null;
  heartbeatSummary?: string | null;
  leaseSummary?: string | null;
  health?: AgentHealth;
  ghost?: boolean;
  stuck?: boolean;
  idleSince?: string | null;
  lastActivity?: string | null;
  idleDuration?: string | null;
  lastActivityAge?: string | null;
  capabilityTags?: string[];
  routingScore?: number;
  routingReasons?: string[];
}

export interface AgentVisibilityInput {
  emoji: string;
  name: string;
  id: string;
  pid?: number;
  status: "working" | "idle";
  metadata?: Record<string, unknown> | null;
  lastHeartbeat?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  idleSince?: string | null;
  lastActivity?: string | null;
}

export interface AgentVisibilityOptions {
  now?: number;
  heartbeatTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export interface AgentRoutingHint {
  repo?: string;
  branch?: string;
  role?: string;
  requiredTools?: string[];
  task?: string;
}

const DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS = 5_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.map(asString).filter((item): item is string => Boolean(item));
  return strings.length > 0 ? strings : undefined;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatAge(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatLease(expiresAt: string | null | undefined, nowMs: number): string | null {
  const expiresMs = parseIsoMs(expiresAt);
  if (expiresMs == null) return null;
  const deltaMs = expiresMs - nowMs;
  if (deltaMs >= 0) {
    const seconds = Math.max(0, Math.round(deltaMs / 1000));
    if (seconds < 60) return `lease in ${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `lease in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    return `lease in ${hours}h`;
  }

  const elapsedSeconds = Math.round(Math.abs(deltaMs) / 1000);
  if (elapsedSeconds < 60) return `lease expired ${elapsedSeconds}s ago`;
  const minutes = Math.round(elapsedSeconds / 60);
  if (minutes < 60) return `lease expired ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `lease expired ${hours}h ago`;
}

function normalizeTaskTokens(task: string | undefined): string[] {
  if (!task) return [];
  return task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function compareRouting(left: AgentDisplayInfo, right: AgentDisplayInfo): number {
  if ((left.routingScore ?? 0) !== (right.routingScore ?? 0)) {
    return (right.routingScore ?? 0) - (left.routingScore ?? 0);
  }
  const leftGhost = left.ghost ? 1 : 0;
  const rightGhost = right.ghost ? 1 : 0;
  if (leftGhost !== rightGhost) return leftGhost - rightGhost;
  if (left.status !== right.status) return left.status === "idle" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function shortenPath(p: string, homedir: string): string {
  if (p === homedir) return "~";
  const prefix = homedir.endsWith("/") ? homedir : homedir + "/";
  if (p.startsWith(prefix)) {
    return "~/" + p.slice(prefix.length);
  }
  return p;
}

export function extractAgentCapabilities(
  metadata: Record<string, unknown> | null | undefined,
): AgentCapabilities {
  const record = asRecord(metadata);
  const capabilitiesRecord = asRecord(record?.capabilities);

  return {
    repo: asString(capabilitiesRecord?.repo) ?? asString(record?.repo),
    repoRoot: asString(capabilitiesRecord?.repoRoot) ?? asString(record?.repoRoot),
    branch: asString(capabilitiesRecord?.branch) ?? asString(record?.branch),
    role: asString(capabilitiesRecord?.role) ?? asString(record?.role),
    tools: asStringArray(capabilitiesRecord?.tools),
    tags: asStringArray(capabilitiesRecord?.tags),
  };
}

export function buildAgentCapabilityTags(capabilities: AgentCapabilities): string[] {
  const tags = new Set<string>();

  if (capabilities.role) tags.add(`role:${capabilities.role}`);
  if (capabilities.repo) tags.add(`repo:${capabilities.repo}`);
  if (capabilities.branch) tags.add(`branch:${capabilities.branch}`);
  for (const tool of capabilities.tools ?? []) {
    tags.add(`tool:${tool}`);
  }
  for (const tag of capabilities.tags ?? []) {
    tags.add(tag);
  }

  return [...tags];
}

export function buildAgentDisplayInfo(
  agent: AgentVisibilityInput,
  options: AgentVisibilityOptions = {},
): AgentDisplayInfo {
  const nowMs = options.now ?? Date.now();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_AGENT_HEARTBEAT_TIMEOUT_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_AGENT_HEARTBEAT_INTERVAL_MS;
  const heartbeatMs = parseIsoMs(agent.lastHeartbeat);
  const heartbeatAgeMs = heartbeatMs == null ? null : Math.max(0, nowMs - heartbeatMs);
  const computedLeaseExpiresAt =
    agent.resumableUntil ??
    (heartbeatMs == null ? null : new Date(heartbeatMs + heartbeatTimeoutMs).toISOString());
  const disconnectedAtMs = parseIsoMs(agent.disconnectedAt);
  const resumableUntilMs = parseIsoMs(agent.resumableUntil);
  const staleThresholdMs = Math.max(
    heartbeatIntervalMs * 2,
    heartbeatTimeoutMs - heartbeatIntervalMs,
  );

  let health: AgentHealth = "healthy";
  if (disconnectedAtMs != null && resumableUntilMs != null && resumableUntilMs > nowMs) {
    health = "resumable";
  } else if (
    disconnectedAtMs != null ||
    (heartbeatAgeMs != null && heartbeatAgeMs > heartbeatTimeoutMs)
  ) {
    health = "ghost";
  } else if (heartbeatAgeMs != null && heartbeatAgeMs > staleThresholdMs) {
    health = "stale";
  }

  const metadata = asRecord(agent.metadata);
  const capabilities = extractAgentCapabilities(metadata);
  const capabilityTags = buildAgentCapabilityTags(capabilities);

  const idleSinceMs = parseIsoMs(agent.idleSince);
  const lastActivityMs = parseIsoMs(agent.lastActivity);
  const idleDurationMs = idleSinceMs == null ? null : Math.max(0, nowMs - idleSinceMs);
  const lastActivityAgeMs = lastActivityMs == null ? null : Math.max(0, nowMs - lastActivityMs);

  return {
    emoji: agent.emoji,
    name: agent.name,
    id: agent.id,
    ...(agent.pid != null ? { pid: agent.pid } : {}),
    status: agent.status,
    metadata: metadata
      ? {
          cwd: asString(metadata.cwd),
          branch: asString(metadata.branch),
          host: asString(metadata.host),
          repo: asString(metadata.repo) ?? capabilities.repo,
          role: asString(metadata.role) ?? capabilities.role,
          capabilities,
        }
      : null,
    lastHeartbeat: agent.lastHeartbeat,
    leaseExpiresAt: computedLeaseExpiresAt,
    heartbeatAgeMs,
    heartbeatSummary: formatAge(heartbeatAgeMs),
    leaseSummary: formatLease(computedLeaseExpiresAt, nowMs),
    health,
    ghost: health === "ghost",
    stuck: false,
    idleSince: agent.idleSince ?? null,
    lastActivity: agent.lastActivity ?? null,
    idleDuration: formatAge(idleDurationMs),
    lastActivityAge: formatAge(lastActivityAgeMs),
    capabilityTags,
  };
}

export function rankAgentsForRouting(
  agents: AgentDisplayInfo[],
  hint: AgentRoutingHint,
): AgentDisplayInfo[] {
  const requiredTools = new Set((hint.requiredTools ?? []).map((tool) => tool.toLowerCase()));
  const taskTokens = normalizeTaskTokens(hint.task);

  const ranked = agents.map((agent) => {
    let score = 0;
    const reasons: string[] = [];
    const capabilities = agent.metadata?.capabilities ?? {};
    const capabilityTags = agent.capabilityTags ?? [];
    const searchable = [
      agent.name,
      agent.metadata?.repo,
      capabilities.repo,
      agent.metadata?.branch,
      capabilities.branch,
      agent.metadata?.role,
      capabilities.role,
      ...capabilityTags,
      ...(capabilities.tools ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    if (agent.health === "ghost") {
      score -= 1000;
      reasons.push("ghost");
    } else if (agent.health === "resumable") {
      score -= 200;
      reasons.push("resumable");
    } else if (agent.health === "stale") {
      score -= 20;
      reasons.push("stale heartbeat");
    } else {
      score += 20;
      reasons.push("healthy heartbeat");
    }

    if (agent.status === "idle") {
      score += 10;
      reasons.push("idle");
    } else {
      score += 2;
      reasons.push("working");
    }

    const repo = (capabilities.repo ?? agent.metadata?.repo)?.toLowerCase();
    const branch = (capabilities.branch ?? agent.metadata?.branch)?.toLowerCase();
    const role = (capabilities.role ?? agent.metadata?.role)?.toLowerCase();
    const tools = new Set((capabilities.tools ?? []).map((tool) => tool.toLowerCase()));
    const lowerCapabilityTags = capabilityTags.map((tag) => tag.toLowerCase());

    if (hint.repo && repo === hint.repo.toLowerCase()) {
      score += 40;
      reasons.push(`repo:${hint.repo}`);
    }
    if (hint.branch && branch === hint.branch.toLowerCase()) {
      score += 30;
      reasons.push(`branch:${hint.branch}`);
    }
    if (hint.role && role === hint.role.toLowerCase()) {
      score += 20;
      reasons.push(`role:${hint.role}`);
    }

    if (requiredTools.size > 0) {
      let matchedTools = 0;
      for (const tool of requiredTools) {
        if (tools.has(tool) || lowerCapabilityTags.includes(`tool:${tool}`)) {
          matchedTools += 1;
        }
      }
      if (matchedTools > 0) {
        score += matchedTools * 12;
        reasons.push(`tools:${matchedTools}/${requiredTools.size}`);
      }
      if (matchedTools !== requiredTools.size) {
        score -= (requiredTools.size - matchedTools) * 15;
      }
    }

    if (taskTokens.length > 0) {
      const overlaps = taskTokens.filter((token) =>
        searchable.some((value) => value.includes(token)),
      );
      if (overlaps.length > 0) {
        score += overlaps.length * 3;
        reasons.push(`task:${overlaps.slice(0, 3).join(",")}`);
      }
    }

    return {
      ...agent,
      routingScore: score,
      routingReasons: reasons,
    };
  });

  return ranked.sort(compareRouting);
}

export const DEFAULT_RALPH_LOOP_INTERVAL_MS = 30_000;
export const DEFAULT_RALPH_LOOP_IDLE_WITH_WORK_THRESHOLD_MS = 60_000;
export const DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS = 5 * 60_000;
export const DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS = 60_000;
export const DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS = 5 * 60_000;

export interface RalphLoopAgentWorkload extends AgentVisibilityInput {
  lastSeen?: string;
  pendingInboxCount: number;
  ownedThreadCount: number;
}

export interface RalphLoopEvaluationOptions extends AgentVisibilityOptions {
  idleWithWorkThresholdMs?: number;
  stuckWorkingThresholdMs?: number;
  pendingBacklogCount?: number;
  currentBranch?: string | null;
  expectedMainBranch?: string;
  brokerHeartbeatActive?: boolean;
  brokerMaintenanceActive?: boolean;
}

export interface RalphLoopEvaluationResult {
  ghostAgentIds: string[];
  nudgeAgentIds: string[];
  idleDrainAgentIds: string[];
  stuckAgentIds: string[];
  anomalies: string[];
}

export function evaluateRalphLoopCycle(
  workloads: RalphLoopAgentWorkload[],
  options: RalphLoopEvaluationOptions = {},
): RalphLoopEvaluationResult {
  const nowMs = options.now ?? Date.now();
  const idleWithWorkThresholdMs =
    options.idleWithWorkThresholdMs ?? DEFAULT_RALPH_LOOP_IDLE_WITH_WORK_THRESHOLD_MS;
  const stuckWorkingThresholdMs =
    options.stuckWorkingThresholdMs ?? DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS;
  const pendingBacklogCount = options.pendingBacklogCount ?? 0;
  const expectedMainBranch = options.expectedMainBranch ?? "main";
  const anomalies: string[] = [];
  const ghostAgentIds: string[] = [];
  const nudgeAgentIds: string[] = [];
  const idleDrainAgentIds: string[] = [];
  const stuckAgentIds: string[] = [];

  for (const workload of workloads) {
    const metadata = asRecord(workload.metadata);
    const capabilities = extractAgentCapabilities(metadata);
    const role = (capabilities.role ?? asString(metadata?.role) ?? "worker").toLowerCase();
    if (role === "broker") {
      continue;
    }

    const display = buildAgentDisplayInfo(workload, options);
    if (display.health === "ghost") {
      ghostAgentIds.push(workload.id);
      continue;
    }

    const hasAssignedWork = workload.pendingInboxCount > 0 || workload.ownedThreadCount > 0;
    const lastSeenMs = parseIsoMs(workload.lastSeen) ?? parseIsoMs(workload.lastHeartbeat);
    const idleAgeMs = lastSeenMs == null ? null : Math.max(0, nowMs - lastSeenMs);

    if (
      hasAssignedWork &&
      workload.status === "idle" &&
      display.health !== "resumable" &&
      idleAgeMs != null &&
      idleAgeMs >= idleWithWorkThresholdMs
    ) {
      nudgeAgentIds.push(workload.id);
      anomalies.push(
        `${workload.name} idle with assigned work (${workload.pendingInboxCount} inbox, ${workload.ownedThreadCount} threads)`,
      );
      continue;
    }

    // Stuck detection: agent reports "working" but no activity for > threshold
    if (workload.status === "working" && display.health === "healthy") {
      const lastActivityMs = parseIsoMs(workload.lastActivity);
      const activityAgeMs = lastActivityMs == null ? null : Math.max(0, nowMs - lastActivityMs);
      if (activityAgeMs != null && activityAgeMs >= stuckWorkingThresholdMs) {
        stuckAgentIds.push(workload.id);
        const ageMinutes = Math.round(activityAgeMs / 60_000);
        anomalies.push(
          `${workload.name} appears stuck (working with no activity for ${ageMinutes}m)`,
        );
        continue;
      }
    }

    if (!hasAssignedWork && workload.status === "idle" && display.health === "healthy") {
      idleDrainAgentIds.push(workload.id);
    }
  }

  if (ghostAgentIds.length > 0) {
    anomalies.push(`ghost agents detected: ${ghostAgentIds.join(", ")}`);
  }
  if (pendingBacklogCount > 0 && idleDrainAgentIds.length > 0) {
    anomalies.push(
      `pending backlog (${pendingBacklogCount}) with ${idleDrainAgentIds.length} idle worker${idleDrainAgentIds.length === 1 ? "" : "s"}`,
    );
  }
  if (options.currentBranch && options.currentBranch !== expectedMainBranch) {
    anomalies.push(
      `main checkout is on \`${options.currentBranch}\`, expected \`${expectedMainBranch}\``,
    );
  }
  if (options.brokerHeartbeatActive === false) {
    anomalies.push("broker heartbeat timer is not running");
  }
  if (options.brokerMaintenanceActive === false) {
    anomalies.push("broker maintenance timer is not running");
  }

  if (stuckAgentIds.length > 0 && ghostAgentIds.length === 0) {
    // Only report stuck if not already mixed with ghost anomalies
    // (ghosts are more urgent)
  }

  return {
    ghostAgentIds,
    nudgeAgentIds,
    idleDrainAgentIds,
    stuckAgentIds,
    anomalies,
  };
}

export function buildRalphLoopNudgeMessage(
  pendingInboxCount: number,
  ownedThreadCount: number,
): string {
  const parts = [];
  if (pendingInboxCount > 0) {
    parts.push(`${pendingInboxCount} inbox item${pendingInboxCount === 1 ? "" : "s"}`);
  }
  if (ownedThreadCount > 0) {
    parts.push(`${ownedThreadCount} claimed thread${ownedThreadCount === 1 ? "" : "s"}`);
  }
  const workload = parts.length > 0 ? parts.join(" and ") : "assigned work";
  return `RALPH LOOP nudge: you appear idle but still have ${workload}. Please pick it up, post a status update, or release ownership so the broker can reassign it.`;
}

export function buildRalphLoopAnomalySignature(evaluation: RalphLoopEvaluationResult): string {
  return evaluation.anomalies.join("|");
}

export interface RalphLoopFollowUpDeliveryOptions {
  signature: string;
  lastDeliveredAt?: number;
  now?: number;
  cooldownMs?: number;
  pending?: boolean;
  idle?: boolean;
}

export function shouldDeliverRalphLoopFollowUp(options: RalphLoopFollowUpDeliveryOptions): boolean {
  const now = options.now ?? Date.now();
  const lastDeliveredAt = options.lastDeliveredAt ?? 0;
  const cooldownMs = options.cooldownMs ?? DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS;
  const pending = options.pending ?? false;
  const idle = options.idle ?? true;

  if (!options.signature) {
    return false;
  }
  if (pending || !idle) {
    return false;
  }
  if (lastDeliveredAt > 0 && now - lastDeliveredAt < cooldownMs) {
    return false;
  }
  return true;
}

export function buildRalphLoopFollowUpMessage(
  evaluation: RalphLoopEvaluationResult,
): string | null {
  if (evaluation.anomalies.length === 0) {
    return null;
  }

  return [
    "RALPH LOOP CYCLE:",
    ...evaluation.anomalies.map((anomaly) => `- ${anomaly}`),
    "",
    "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, and repair broker anomalies.",
  ].join("\n");
}

export function buildBrokerPromptGuidelines(agentEmoji: string, agentName: string): string[] {
  return [
    `You are ${agentEmoji} ${agentName}, the Pinet BROKER. Your ONLY role is coordination and infrastructure — NEVER implementation.`,
    // ── HARD GUARDRAIL ──────────────────────────────────────────
    "🚫 HARD RULE — NEVER WRITE CODE: You MUST NOT implement features, fix bugs, write tests, edit source files, or do any coding task. This is a non-negotiable constraint, not a preference. Violations stall the entire multi-agent mesh.",
    "WHY THIS RULE EXISTS: You are the ONLY process routing Slack messages, monitoring agent health, and keeping the mesh alive. If you spend even one turn writing code, messages stop flowing, dead agents don't get reaped, backlog piles up, and the whole system stalls. Workers are computation, broker is infrastructure.",
    // ── FORBIDDEN ACTIONS ───────────────────────────────────────
    "FORBIDDEN — Do NOT do any of these, even if explicitly asked: (1) Use the Agent tool to spawn local subagents — they have no Slack/Pinet connectivity and can't be monitored. (2) Use edit, write, or bash to modify source code. (3) Pick up coding tasks, bug fixes, refactors, or implementation work. (4) Run test suites, linters, or build commands as part of implementation work. (5) Create or modify source files in any worktree.",
    "IF ASKED TO CODE: Refuse politely and immediately delegate. Say: 'I'm the broker — I coordinate, not code. Let me find a worker for this.' Then check pinet_agents and delegate via pinet_message.",
    // ── ALLOWED ACTIONS ─────────────────────────────────────────
    "ALLOWED — These are your responsibilities: (1) Route messages between humans and agents. (2) Check pinet_agents for idle workers and delegate tasks via pinet_message. (3) File GitHub issues, create/merge PRs, run code reviews via the code-reviewer subagent. (4) Monitor agent health via the RALPH loop. (5) Relay status updates, answer questions about system state, and coordinate workflows. (6) Use bash for read-only inspection: git log, git status, gh pr list, ls, cat — never for code changes.",
    "When a human asks for work to be done, ALWAYS check `pinet_agents` for idle workers and delegate via `pinet_message`. Pick the agent on the right repo/branch when possible.",
    "When delegating, include: the task description, relevant issue/PR numbers, branch to work on, and where to report back (Slack thread_ts).",
    "If no workers are available, tell the human and suggest they spin up a new agent. NEVER do the work yourself as a fallback.",
    "WORKTREE RULE: The main repo checkout must ALWAYS stay on the `main` branch. NEVER run `git checkout <branch>` or `git switch <branch>` in the main checkout.",
    "For feature work, ALWAYS create a git worktree: `git worktree add .worktrees/<name> -b <branch>`. Tell delegated agents to do the same.",
    "When delegating to an agent, include the worktree setup command. Example: `git worktree add .worktrees/fix-foo-123 -b fix/foo-123 && cd .worktrees/fix-foo-123`",
    "Clean up worktrees after PRs merge: `git worktree remove .worktrees/<name>`. Flag orphaned worktrees from dead agents for cleanup.",
    "RALPH LOOP: Run autonomous maintenance every cycle. Don't wait to be asked. Proactively: (1) REAP — ping idle agents, mark non-responders as ghost. (2) NUDGE — check assigned work, poll branches for commits, escalate stalled agents. (3) REASSIGN — if an assigned agent is dead, reassign to next idle agent immediately. (4) DRAIN — find idle agents with no work, assign queued tasks. (5) SELF-REPAIR — verify main is on `main`, check mesh health, report anomalies.",
  ];
}

export function buildWorkerPromptGuidelines(): string[] {
  return [
    "TASK WORKFLOW: When you receive work, follow these steps:",
    "1. ACK briefly so the sender knows you picked it up — then start working immediately. Do not stop after the ACK.",
    "2. Do the work.",
    "3. If you hit a blocker, report it immediately and ask for what you need — blocked work must be visible so it can be unblocked or reassigned.",
    "4. When done, report the outcome (what changed, branch/PR, test results) — the sender needs closure and next steps.",
    "Always reply where the task came from.",
    "",
    "REPLY TOOL RULES:",
    "- If you received a task via `pinet_message`, reply via `pinet_message` to the sender.",
    "- If you received a task in a Slack thread, reply via `slack_send` in that thread.",
    "- Never use `slack_post_channel` with a pinet thread ID (e.g. `a2a:...`) — it will fail. Pinet threads are not Slack channels.",
    "",
    "PINET DELEGATION RULES:",
    "- When you need another connected agent to take work or parallelize, do NOT use the Agent tool to spawn a local subagent for delegation.",
    "- Prefer Pinet delegation: first use `pinet_agents` to find a suitable connected worker, then delegate via `pinet_message`.",
    "- Keep delegation inside the Pinet or Slack thread so ACKs, blockers, status updates, and final results flow back to the original sender.",
    "- When delegating, include the workflow (`ack/work/ask/report`), the task, relevant issue/PR numbers, repo/branch/worktree setup, important files, acceptance criteria, and where to reply.",
  ];
}

export function buildIdentityReplyGuidelines(
  agentEmoji: string,
  agentName: string,
  location: string,
): [string, string, string] {
  return [
    `First message in a new thread: use exact format — '${agentEmoji} \`${agentName}\` reporting from \`${location}\`\\n\\n<message body>'`,
    `Follow-up messages in the same thread: keep the same full identity prefix — '${agentEmoji} \`${agentName}\` <message>'`,
    "Never use emoji-only prefixes (for example, '🦅 Working now') — always include the full identity prefix above on every post.",
  ];
}

export function resolvePersistedAgentIdentity(
  settings: SlackBridgeSettings,
  persistedName?: string,
  persistedEmoji?: string,
  envNickname?: string,
): { name: string; emoji: string } {
  if (persistedName && persistedEmoji) {
    return { name: persistedName, emoji: persistedEmoji };
  }

  return resolveAgentIdentity(settings, envNickname);
}

export function buildAgentStableId(
  sessionFile?: string,
  host = os.hostname(),
  cwd = process.cwd(),
  leafId?: string,
): string {
  if (sessionFile) {
    return `${host}:session:${path.resolve(sessionFile)}`;
  }
  if (leafId) {
    return `${host}:leaf:${leafId}`;
  }
  return `${host}:cwd:${path.resolve(cwd)}`;
}

export function resolveAgentStableId(
  persistedStableId?: string,
  sessionFile?: string,
  host = os.hostname(),
  cwd = process.cwd(),
  leafId?: string,
): string {
  return persistedStableId || buildAgentStableId(sessionFile, host, cwd, leafId);
}

export interface PinetRegistrationContext {
  sessionHeader?: {
    parentSession?: string;
  } | null;
  argv?: string[];
}

export function isLikelyLocalSubagentContext(context: PinetRegistrationContext = {}): boolean {
  const parentSession = context.sessionHeader?.parentSession;
  if (typeof parentSession === "string" && parentSession.trim().length > 0) {
    return true;
  }

  const argv = context.argv ?? process.argv.slice(2);
  const hasNoSession = argv.includes("--no-session");
  const hasPrint = argv.includes("--print") || argv.includes("-p");
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : undefined;
  const hasHeadlessMode = mode === "json" || mode === "rpc";

  return hasNoSession && (hasPrint || hasHeadlessMode);
}

export interface FollowerThreadState {
  channelId: string;
  threadTs: string;
  userId: string;
  owner?: string;
}

export interface FollowerInboxEntry {
  message: {
    threadId?: string;
    sender?: string;
    body?: string;
    createdAt?: string;
    metadata: Record<string, unknown> | null;
  };
}

export interface FollowerInboxSyncResult {
  inboxMessages: InboxMessage[];
  threadUpdates: FollowerThreadState[];
  lastDmChannel: string | null;
  changed: boolean;
}

export function isDirectMessageChannel(channel: string): boolean {
  return /^D[A-Z0-9]+$/.test(channel);
}

export function syncFollowerInboxEntries(
  entries: FollowerInboxEntry[],
  existingThreads: ReadonlyMap<string, FollowerThreadState>,
  agentName: string,
  lastDmChannel: string | null,
): FollowerInboxSyncResult {
  let nextLastDmChannel = lastDmChannel;
  let changed = false;
  const threadUpdates: FollowerThreadState[] = [];

  const inboxMessages = entries.map((entry) => {
    const meta = entry.message.metadata ?? {};
    const threadTs = entry.message.threadId ?? "";
    const channel = typeof meta.channel === "string" ? meta.channel : "";
    const sender = entry.message.sender ?? "";

    if (threadTs && channel) {
      const existing = existingThreads.get(threadTs);
      const nextThread: FollowerThreadState = {
        channelId: channel,
        threadTs,
        userId: existing?.userId || sender,
        owner: existing?.owner ?? agentName,
      };

      if (
        !existing ||
        existing.channelId !== nextThread.channelId ||
        existing.userId !== nextThread.userId ||
        existing.owner !== nextThread.owner
      ) {
        changed = true;
      }

      threadUpdates.push(nextThread);
    }

    if (isDirectMessageChannel(channel) && nextLastDmChannel !== channel) {
      nextLastDmChannel = channel;
      changed = true;
    }

    return {
      channel,
      threadTs,
      userId: sender,
      text: entry.message.body ?? "",
      timestamp: entry.message.createdAt ?? "",
    };
  });

  return {
    inboxMessages,
    threadUpdates,
    lastDmChannel: nextLastDmChannel,
    changed,
  };
}

export interface FollowerThreadChannelResolution {
  channelId: string | null;
  threadUpdate?: FollowerThreadState;
  changed: boolean;
}

export async function resolveFollowerThreadChannel(
  threadTs: string | undefined,
  existingThread: FollowerThreadState | undefined,
  brokerRole: "broker" | "follower" | null,
  resolveThread?: (threadTs: string) => Promise<string | null>,
): Promise<FollowerThreadChannelResolution> {
  if (!threadTs) {
    return { channelId: null, changed: false };
  }

  if (existingThread?.channelId) {
    return { channelId: existingThread.channelId, changed: false };
  }

  if (brokerRole !== "follower" || !resolveThread) {
    return { channelId: null, changed: false };
  }

  try {
    const channelId = await resolveThread(threadTs);
    if (!channelId) {
      return { channelId: null, changed: false };
    }

    return {
      channelId,
      changed: true,
      threadUpdate: {
        channelId,
        threadTs,
        userId: existingThread?.userId ?? "",
        owner: existingThread?.owner,
      },
    };
  } catch {
    return { channelId: null, changed: false };
  }
}

export interface FollowerReconnectUiUpdate {
  nextWasDisconnected: boolean;
  notify?: {
    level: "warning" | "info";
    message: string;
  };
}

export function getFollowerReconnectUiUpdate(
  event: "disconnect" | "reconnect",
  wasDisconnected: boolean,
): FollowerReconnectUiUpdate {
  if (event === "disconnect") {
    return wasDisconnected
      ? { nextWasDisconnected: true }
      : {
          nextWasDisconnected: true,
          notify: {
            level: "warning",
            message: "Pinet broker disconnected — reconnecting...",
          },
        };
  }

  if (!wasDisconnected) {
    return { nextWasDisconnected: false };
  }

  return {
    nextWasDisconnected: false,
    notify: {
      level: "info",
      message: "Pinet broker reconnected",
    },
  };
}

export function getFollowerOwnedThreadClaims(
  threads: ReadonlyMap<string, Pick<FollowerThreadState, "threadTs" | "channelId" | "owner">>,
  agentName: string,
): Array<{ threadTs: string; channelId: string }> {
  return [...threads.values()]
    .filter(
      (thread) =>
        thread.owner === agentName && Boolean(thread.threadTs) && Boolean(thread.channelId),
    )
    .map((thread) => ({
      threadTs: thread.threadTs,
      channelId: thread.channelId,
    }));
}

/**
 * Track a thread from a broker inbound message in the threads map.
 * Used by the broker onInbound callback so that slack_send can resolve
 * the channel for channel-mention messages.
 */
export function trackBrokerInboundThread(
  threads: Map<string, FollowerThreadState>,
  inMsg: { threadId: string; channel: string; userId?: string },
  owner?: string,
): void {
  if (!inMsg.threadId || !inMsg.channel) return;
  if (!threads.has(inMsg.threadId)) {
    threads.set(inMsg.threadId, {
      channelId: inMsg.channel,
      threadTs: inMsg.threadId,
      userId: inMsg.userId ?? "",
      owner,
    });
  }
}

export function formatAgentList(agents: AgentDisplayInfo[], homedir: string): string {
  if (agents.length === 0) return "(no agents connected)";

  return agents
    .map((a) => {
      const health = a.health ? ` [${a.health}]` : "";
      const stuckTag = a.stuck ? " [stuck]" : "";
      const pid = a.pid != null ? ` pid:${a.pid}` : "";
      let line = `${a.emoji} ${a.name} (${a.id}) \u2014 ${a.status}${health}${stuckTag}${pid}`;

      const meta = a.metadata;
      if (meta && (meta.cwd || meta.branch || meta.host)) {
        const cwd = meta.cwd ? shortenPath(meta.cwd, homedir) : "";
        const branch = meta.branch ? ` (${meta.branch})` : "";
        const host = meta.host ? ` @ ${meta.host}` : "";
        line += `\n   ${cwd}${branch}${host}`;
      }

      const heartbeat = a.heartbeatSummary ?? formatAge(a.heartbeatAgeMs);
      const lease = a.leaseSummary ?? null;
      const idleInfo = a.status === "idle" && a.idleDuration ? `idle ${a.idleDuration}` : null;
      const activityInfo =
        a.status === "working" && a.lastActivityAge ? `activity ${a.lastActivityAge}` : null;
      if (heartbeat || lease || idleInfo || activityInfo) {
        const summary = [
          heartbeat ? `heartbeat ${heartbeat}` : null,
          lease,
          idleInfo,
          activityInfo,
        ].filter((item): item is string => Boolean(item));
        line += `\n   ${summary.join(" · ")}`;
      }

      const tags = (a.capabilityTags ?? []).slice(0, 6);
      if (tags.length > 0) {
        const suffix = (a.capabilityTags?.length ?? 0) > tags.length ? " …" : "";
        line += `\n   caps: ${tags.join(", ")}${suffix}`;
      }

      if (a.routingScore != null) {
        const reasons = (a.routingReasons ?? []).slice(0, 4);
        line += `\n   routing: ${a.routingScore}`;
        if (reasons.length > 0) {
          line += ` (${reasons.join(", ")})`;
        }
      }

      return line;
    })
    .join("\n");
}

// ─── Random / deterministic agent names ──────────────────

const ADJECTIVES = [
  "Cosmic",
  "Turbo",
  "Neon",
  "Solar",
  "Quantum",
  "Pixel",
  "Cyber",
  "Atomic",
  "Stellar",
  "Thunder",
  "Crystal",
  "Mystic",
  "Hyper",
  "Ultra",
  "Mega",
  "Electric",
  "Galactic",
  "Sonic",
  "Laser",
  "Rocket",
  "Shadow",
  "Blazing",
  "Frozen",
  "Lunar",
  "Nova",
  "Aurora",
  "Radiant",
  "Velvet",
  "Iron",
  "Golden",
  "Silver",
  "Scarlet",
  "Cobalt",
  "Slate",
  "Obsidian",
  "Rapid",
  "Silent",
  "Binary",
  "Vector",
  "Prism",
  "Nimbus",
  "Orbit",
  "Comet",
  "Echo",
  "Ember",
  "Glacial",
  "Ionic",
  "Jade",
];

const ANIMALS = [
  "Badger",
  "Penguin",
  "Otter",
  "Raccoon",
  "Fox",
  "Panda",
  "Wolf",
  "Eagle",
  "Dolphin",
  "Lynx",
  "Cobra",
  "Raven",
  "Gecko",
  "Mantis",
  "Jaguar",
  "Goose",
  "Bison",
  "Crane",
  "Moose",
  "Owl",
  "Beaver",
  "Hedgehog",
  "Rabbit",
  "Koala",
  "Tiger",
  "Lion",
  "Zebra",
  "Giraffe",
  "Elephant",
  "Rhino",
  "Hippo",
  "Kangaroo",
  "Camel",
  "Llama",
  "Goat",
  "Deer",
  "Buffalo",
  "Horse",
  "Boar",
  "Bear",
  "Monkey",
  "Sloth",
  "Turtle",
  "Whale",
  "Shark",
  "Crocodile",
  "Dragon",
  "Parrot",
];

const COLORS = [
  "Slate",
  "Azure",
  "Blush",
  "Bronze",
  "Burgundy",
  "Chalk",
  "Coral",
  "Crimson",
  "Ebony",
  "Emerald",
  "Hazel",
  "Indigo",
  "Ivory",
  "Lime",
  "Magenta",
  "Navy",
  "Olive",
  "Pearl",
  "Rose",
  "Rust",
];

const EMOJIS = [
  "🦡",
  "🐧",
  "🦦",
  "🦝",
  "🦊",
  "🐼",
  "🐺",
  "🦅",
  "🐬",
  "🐱",
  "🐍",
  "🐦‍⬛",
  "🦎",
  "🦗",
  "🐆",
  "🪿",
  "🦬",
  "🦩",
  "🫎",
  "🦉",
  "🦫",
  "🦔",
  "🐇",
  "🐨",
  "🐯",
  "🦁",
  "🦓",
  "🦒",
  "🐘",
  "🦏",
  "🦛",
  "🦘",
  "🐫",
  "🦙",
  "🐐",
  "🦌",
  "🐃",
  "🐎",
  "🐗",
  "🐻",
  "🐒",
  "🦥",
  "🐢",
  "🐋",
  "🦈",
  "🐊",
  "🐉",
  "🦜",
];

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function generateAgentName(seed?: string): { name: string; emoji: string } {
  const adjectiveIndex = seed
    ? hashString(`${seed}:adjective`) % ADJECTIVES.length
    : Math.floor(Math.random() * ADJECTIVES.length);
  const colorIndex = seed
    ? hashString(`${seed}:color`) % COLORS.length
    : Math.floor(Math.random() * COLORS.length);
  const animalIndex = seed
    ? hashString(`${seed}:animal`) % ANIMALS.length
    : Math.floor(Math.random() * ANIMALS.length);

  return {
    name: `${ADJECTIVES[adjectiveIndex]} ${COLORS[colorIndex]} ${ANIMALS[animalIndex]}`,
    emoji: EMOJIS[animalIndex],
  };
}

// ─── Agent identity persistence ─────────────────────────

export function resolveAgentIdentity(
  settings: SlackBridgeSettings,
  envNickname?: string,
  seed?: string,
): { name: string; emoji: string } {
  // 1. Explicit config (both must be present)
  if (settings.agentName && settings.agentEmoji) {
    return { name: settings.agentName, emoji: settings.agentEmoji };
  }

  // 2. PI_NICKNAME env var (name fixed, emoji deterministic when seeded)
  if (envNickname) {
    const generated = generateAgentName(seed);
    return { name: envNickname, emoji: generated.emoji };
  }

  // 3. Fully generated
  return generateAgentName(seed);
}

// ─── Slack API client (unified) ──────────────────────────

/**
 * Standard Slack API response shape.
 */
export interface SlackResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/**
 * Call Slack API with bounded retry logic (max 3 retries on rate limit).
 * Handles 429 rate-limit responses by waiting retry-after duration and retrying.
 * Throws error if retries are exhausted or API returns error.
 */
export async function callSlackAPI(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  _retryCount = 0,
): Promise<SlackResult> {
  const { url, init } = buildSlackRequest(method, token, body);
  const res = await fetch(url, init);

  if (res.status === 429) {
    const maxRetries = 3;
    if (_retryCount >= maxRetries) {
      throw new Error(`Slack ${method}: rate limited after ${maxRetries} retries`);
    }
    const wait = Number(res.headers.get("retry-after") ?? "3");
    await new Promise((r) => setTimeout(r, wait * 1000));
    return callSlackAPI(method, token, body, _retryCount + 1);
  }

  const data = (await res.json()) as SlackResult;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  return data;
}

// ─── Follower nudge detection (#102) ─────────────────────

export function isRalphNudgeEntry(entry: {
  message: { metadata?: Record<string, unknown> | null };
}): boolean {
  return entry.message.metadata?.kind === "ralph_loop_nudge";
}

export function partitionFollowerInboxEntries<
  T extends { message: { metadata?: Record<string, unknown> | null } },
>(entries: T[]): { nudges: T[]; regular: T[] } {
  const nudges: T[] = [];
  const regular: T[] = [];
  for (const entry of entries) {
    if (isRalphNudgeEntry(entry)) {
      nudges.push(entry);
    } else {
      regular.push(entry);
    }
  }
  return { nudges, regular };
}

// ─── Ralph cycle records (#103) ──────────────────────────

export interface RalphCycleRecord {
  id?: number;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  ghostAgentIds: string[];
  nudgeAgentIds: string[];
  idleDrainAgentIds: string[];
  stuckAgentIds: string[];
  anomalies: string[];
  anomalySignature: string;
  followUpDelivered: boolean;
  agentCount: number;
  backlogCount: number;
}
