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

export function formatInboxMessages(
  messages: InboxMessage[],
  userNames: Map<string, string>,
): string {
  const lines = messages.map((m) => {
    const n = userNames.get(m.userId) ?? m.userId;
    if (m.isChannelMention) {
      return `[thread ${m.threadTs}] (channel mention in <#${m.channel}>) ${n}: ${m.text}`;
    }
    return `[thread ${m.threadTs}] ${n}: ${m.text}`;
  });

  return `New Slack messages:\n${lines.join("\n")}\n\nRespond to each via slack_send with the correct thread_ts.`;
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
  capabilityTags?: string[];
  routingScore?: number;
  routingReasons?: string[];
}

export interface AgentVisibilityInput {
  emoji: string;
  name: string;
  id: string;
  status: "working" | "idle";
  metadata?: Record<string, unknown> | null;
  lastHeartbeat?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
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

  return {
    emoji: agent.emoji,
    name: agent.name,
    id: agent.id,
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

export function buildBrokerPromptGuidelines(agentEmoji: string, agentName: string): string[] {
  return [
    `You are ${agentEmoji} ${agentName}, the Pinet BROKER. Your role is coordination, not coding.`,
    "WHY: You are the only process routing messages, monitoring agent health, and keeping the mesh alive. If you get stuck in a long coding task, Slack messages stop flowing, dead agents don't get reaped, and the whole multi-agent system stalls. Stay light and fast.",
    "DO NOT pick up coding tasks, bug fixes, or implementation work yourself. Delegate to connected workers instead.",
    "DO NOT use the Agent tool to spawn local subagents. Local subagents have no Slack/Pinet connectivity and can't be monitored. Use `pinet_message` to delegate to connected Pinet agents who can respond in Slack, own threads, and coordinate with humans directly.",
    "Your job is: relay messages between humans and agents, route work to idle followers, file issues, create/merge PRs, run reviews, and monitor agent health.",
    "When a human asks for work to be done, check `pinet_agents` for idle workers and delegate via `pinet_message`. Pick the agent on the right repo/branch when possible.",
    "When delegating, include: the task description, relevant issue/PR numbers, branch to work on, and where to report back (Slack thread_ts).",
    "If no workers are available, tell the human and suggest they spin up a new agent rather than doing the work yourself.",
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
    .filter((thread) => thread.owner === agentName && Boolean(thread.threadTs) && Boolean(thread.channelId))
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
      let line = `${a.emoji} ${a.name} (${a.id}) \u2014 ${a.status}${health}`;

      const meta = a.metadata;
      if (meta && (meta.cwd || meta.branch || meta.host)) {
        const cwd = meta.cwd ? shortenPath(meta.cwd, homedir) : "";
        const branch = meta.branch ? ` (${meta.branch})` : "";
        const host = meta.host ? ` @ ${meta.host}` : "";
        line += `\n   ${cwd}${branch}${host}`;
      }

      const heartbeat = a.heartbeatSummary ?? formatAge(a.heartbeatAgeMs);
      const lease = a.leaseSummary ?? null;
      if (heartbeat || lease) {
        const summary = [heartbeat ? `heartbeat ${heartbeat}` : null, lease].filter(
          (item): item is string => Boolean(item),
        );
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

// ─── Random agent names ──────────────────────────────────

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
  "Super",
  "Electric",
  "Galactic",
  "Sonic",
  "Laser",
  "Rocket",
  "Shadow",
  "Blazing",
  "Frozen",
];

const ANIMALS = [
  "Badger",
  "Penguin",
  "Falcon",
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
  "Osprey",
  "Jaguar",
  "Heron",
  "Bison",
  "Viper",
  "Hawk",
  "Crane",
  "Moose",
  "Owl",
];

const EMOJIS = [
  "🦡",
  "🐧",
  "🦅",
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
  "🦅",
  "🐆",
  "🪿",
  "🦬",
  "🐍",
  "🦅",
  "🦩",
  "🫎",
  "🦉",
];

export function generateAgentName(): { name: string; emoji: string } {
  const ai = Math.floor(Math.random() * ADJECTIVES.length);
  const ni = Math.floor(Math.random() * ANIMALS.length);
  return {
    name: `${ADJECTIVES[ai]} ${ANIMALS[ni]}`,
    emoji: EMOJIS[ni],
  };
}

// ─── Agent identity persistence ─────────────────────────

export function resolveAgentIdentity(
  settings: SlackBridgeSettings,
  envNickname?: string,
): { name: string; emoji: string } {
  // 1. Explicit config (both must be present)
  if (settings.agentName && settings.agentEmoji) {
    return { name: settings.agentName, emoji: settings.agentEmoji };
  }

  // 2. PI_NICKNAME env var (emoji generated)
  if (envNickname) {
    const generated = generateAgentName();
    return { name: envNickname, emoji: generated.emoji };
  }

  // 3. Fully generated
  return generateAgentName();
}
