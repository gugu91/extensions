import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCompatibilityInstanceScope,
  buildCompatibilityWorkspaceScope,
  buildRuntimeScopeCarrier,
  type RuntimeScopeCarrier,
} from "@gugu910/pi-transport-core";
import type { ReactionCommandSettings } from "./reaction-triggers.js";
import { matchesToolPattern } from "./guardrails.js";

// ─── Settings ────────────────────────────────────────────

export interface SlackBridgeSettings {
  botToken?: string;
  appToken?: string;
  appId?: string;
  appConfigToken?: string;
  allowedUsers?: string[];
  allowAllWorkspaceUsers?: boolean;
  defaultChannel?: string;
  logChannel?: string;
  logLevel?: "errors" | "actions" | "verbose";
  suggestedPrompts?: { title: string; message: string }[];
  reactionCommands?: ReactionCommandSettings;
  runtimeMode?: "off" | "single" | "broker" | "follower";
  autoConnect?: boolean;
  autoFollow?: boolean;
  agentName?: string;
  agentEmoji?: string;
  meshSecret?: string;
  meshSecretPath?: string;
  controlPlaneCanvasEnabled?: boolean;
  controlPlaneCanvasId?: string;
  controlPlaneCanvasChannel?: string;
  controlPlaneCanvasTitle?: string;
  imessage?: {
    enabled?: boolean;
  };
  security?: {
    readOnly?: boolean;
    requireConfirmation?: string[];
    blockedTools?: string[];
  };
}

export interface ResolvedPinetMeshAuthSettings {
  meshSecret: string | null;
  meshSecretPath: string | null;
}

function normalizeOptionalSetting(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function buildSlackCompatibilityScope(
  options: {
    teamId?: string | null;
    channelId?: string | null;
    installId?: string | null;
    instanceId?: string | null;
    instanceName?: string | null;
  } = {},
): RuntimeScopeCarrier {
  return buildRuntimeScopeCarrier({
    workspace: buildCompatibilityWorkspaceScope({
      provider: "slack",
      workspaceId: normalizeOptionalSetting(options.teamId) ?? undefined,
      installId: normalizeOptionalSetting(options.installId) ?? undefined,
      channelId: normalizeOptionalSetting(options.channelId) ?? undefined,
    }),
    instance: buildCompatibilityInstanceScope({
      instanceId: normalizeOptionalSetting(options.instanceId) ?? undefined,
      instanceName: normalizeOptionalSetting(options.instanceName) ?? undefined,
    }),
  })!;
}

export function resolvePinetMeshAuth(
  settings: SlackBridgeSettings,
  env = process.env,
): ResolvedPinetMeshAuthSettings {
  const settingsMeshSecret = normalizeOptionalSetting(settings.meshSecret);
  const settingsMeshSecretPath = normalizeOptionalSetting(settings.meshSecretPath);
  if (settingsMeshSecret || settingsMeshSecretPath) {
    return {
      meshSecret: settingsMeshSecret,
      meshSecretPath: settingsMeshSecret ? null : settingsMeshSecretPath,
    };
  }

  const envMeshSecret = normalizeOptionalSetting(env.PINET_MESH_SECRET);
  const envMeshSecretPath = normalizeOptionalSetting(env.PINET_MESH_SECRET_PATH);

  return {
    meshSecret: envMeshSecret,
    meshSecretPath: envMeshSecret ? null : envMeshSecretPath,
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

function parseBooleanOptIn(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveAllowAllWorkspaceUsers(
  settings: SlackBridgeSettings,
  envVar = process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
): boolean {
  if (typeof settings.allowAllWorkspaceUsers === "boolean") {
    return settings.allowAllWorkspaceUsers;
  }
  return parseBooleanOptIn(envVar);
}

export function buildAllowlist(
  settings: SlackBridgeSettings,
  envVar?: string,
  allowAllEnvVar = process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
): Set<string> | null {
  const configuredUsers = settings.allowedUsers?.map((id) => id.trim()).filter(Boolean) ?? [];
  if (configuredUsers.length > 0) {
    return new Set(configuredUsers);
  }

  const envUsers =
    envVar
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean) ?? [];
  if (envUsers.length > 0) {
    return new Set(envUsers);
  }

  if (resolveAllowAllWorkspaceUsers(settings, allowAllEnvVar)) {
    return null;
  }

  return new Set();
}

export function describeSlackUserAccess(
  allowlist: Set<string> | null,
  options: { allowAllWorkspaceUsers?: boolean } = {},
): string {
  if (allowlist === null) {
    return options.allowAllWorkspaceUsers
      ? "Allowed users: all (explicit allow-all enabled)"
      : "Allowed users: all";
  }

  if (allowlist.size > 0) {
    return `Allowed users: ${[...allowlist].join(", ")}`;
  }

  return "Allowed users: none (default deny; set allowedUsers or allowAllWorkspaceUsers: true)";
}

export function getSlackUserAccessWarning(allowlist: Set<string> | null): string | null {
  if (allowlist === null || allowlist.size > 0) {
    return null;
  }

  return [
    "Slack access is default-deny because no allowedUsers are configured.",
    "Set slack-bridge.allowedUsers or explicit allowAllWorkspaceUsers: true to accept Slack users.",
  ].join(" ");
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
  brokerInboxId?: number;
  metadata?: Record<string, unknown> | null;
  scope?: RuntimeScopeCarrier | null;
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

function extractSlackCanvasIdFromPermalink(permalink: string | undefined): string | undefined {
  if (!permalink) return undefined;

  const match = permalink.match(/\/docs\/[^/]+\/(F[^/?#]+)/i);
  return match?.[1];
}

function extractInboxCanvasReference(metadata: Record<string, unknown> | null | undefined): {
  canvasId: string;
  title?: string;
  permalink?: string;
} | null {
  const slackFiles = Array.isArray(metadata?.slackFiles) ? metadata.slackFiles : [];

  for (const file of slackFiles) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      continue;
    }

    const record = asRecord(file);
    if (!record) {
      continue;
    }

    const title = asString(record.title) ?? asString(record.name);
    const permalink = asString(record.permalink);
    const prettyType = asString(record.prettyType)?.toLowerCase();
    const filetype = asString(record.filetype)?.toLowerCase();
    const mimetype = asString(record.mimetype)?.toLowerCase();
    const canvasId = asString(record.id) ?? extractSlackCanvasIdFromPermalink(permalink);
    const looksCanvas =
      Boolean(permalink && permalink.includes("/docs/")) ||
      prettyType === "canvas" ||
      filetype === "canvas" ||
      Boolean(mimetype?.includes("slack-doc"));

    if (!looksCanvas || !canvasId) {
      continue;
    }

    return {
      canvasId,
      ...(title ? { title } : {}),
      ...(permalink ? { permalink } : {}),
    };
  }

  return null;
}

function formatInboxMetadata(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return "";

  if (metadata.kind === "slack_block_action") {
    return ` | metadata=${JSON.stringify({
      kind: metadata.kind,
      actionId: metadata.actionId ?? null,
      blockId: metadata.blockId ?? null,
      value: metadata.value ?? null,
      parsedValue: metadata.parsedValue ?? null,
    })}`;
  }

  const canvasReference = extractInboxCanvasReference(metadata);
  if (canvasReference) {
    return ` | canvas=${JSON.stringify({
      canvasId: canvasReference.canvasId,
      ...(canvasReference.title ? { title: canvasReference.title } : {}),
      ...(canvasReference.permalink ? { permalink: canvasReference.permalink } : {}),
      toolHint: `slack_canvas_comments_read canvas_id=${canvasReference.canvasId}`,
    })}`;
  }

  return "";
}

export function formatInboxMessages(
  messages: InboxMessage[],
  userNames: { get(key: string): string | undefined },
): string {
  const lines = messages.map((m) => {
    const n = userNames.get(m.userId) ?? m.userId;
    const metadataSuffix = formatInboxMetadata(m.metadata);
    if (m.isChannelMention) {
      return `[thread ${m.threadTs}] (channel mention in <#${m.channel}>) ${n}: ${m.text}${metadataSuffix}`;
    }
    return `[thread ${m.threadTs}] ${n}: ${m.text}${metadataSuffix}`;
  });

  return `New Slack messages:\n${lines.join("\n")}\n\nACK briefly, do the work, report blockers immediately, report the outcome when done.`;
}

function getPinetSenderLabel(message: FollowerInboxEntry["message"]): string {
  const senderId = message.sender?.trim() ?? "";
  const senderAgent =
    typeof message.metadata?.senderAgent === "string" ? message.metadata.senderAgent.trim() : "";

  if (senderId && senderAgent && senderAgent !== senderId) {
    return `${senderId} (${senderAgent})`;
  }

  return senderId || senderAgent || "unknown-agent";
}

const PINET_TERMINAL_STAND_DOWN_PATTERNS = [
  /\bno further repl(?:y|ies) (?:are|is) needed\b/i,
  /\bno further acknowledg(?:ement|ements) (?:are|is) needed\b/i,
  /\bno reply is needed\b/i,
  /\bhard stop on this [^.\n]*thread\b/i,
  /\bno more work is needed\b/i,
  /\bstand down\b/i,
  /\bstay free(?:\/| and )quiet\b/i,
  /\bstay quiet(?:\/| and )free\b/i,
  /\bthread is already satisfied\b/i,
  /\bunless I (?:assign|ask for) (?:a )?(?:genuinely )?new task\b/i,
];

const PINET_ACTIONABLE_TASK_PATTERNS = [
  /\bnew [a-z-]+ lane\b/i,
  /\bissue:\b/i,
  /\btask:\b/i,
  /\bworktree setup:\b/i,
  /\bplease ACK\/work\/ask\/report\b/i,
];

export function isTerminalPinetStandDownMessage(body: string | null | undefined): boolean {
  const normalized = body?.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return false;
  }

  const hasTerminalCue = PINET_TERMINAL_STAND_DOWN_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
  if (!hasTerminalCue) {
    return false;
  }

  return !PINET_ACTIONABLE_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function formatPinetInboxMessages(entries: FollowerInboxEntry[]): string {
  const annotatedEntries = entries.map((entry) => ({
    entry,
    terminalStandDown: isTerminalPinetStandDownMessage(entry.message.body),
  }));

  const lines = annotatedEntries.map(({ entry, terminalStandDown }) => {
    const threadTs = entry.message.threadId ?? "";
    const sender = getPinetSenderLabel(entry.message);
    const standDownSuffix = terminalStandDown ? " [terminal stand-down]" : "";
    return `[thread ${threadTs}] ${sender}${standDownSuffix}: ${entry.message.body ?? ""}`;
  });

  const hasTerminalStandDown = annotatedEntries.some((entry) => entry.terminalStandDown);
  const hasActionableWork = annotatedEntries.some((entry) => !entry.terminalStandDown);

  const guidance = hasTerminalStandDown
    ? hasActionableWork
      ? "Reply via pinet_message for actionable work only. For messages marked [terminal stand-down], do NOT acknowledge or reply unless you have a real blocker or materially new finding. For new tasks, ACK briefly, do the work, report blockers immediately, report the outcome when done."
      : "Reply via pinet_message only if you have a real blocker or materially new finding. Treat messages marked [terminal stand-down] as closed; do NOT send another acknowledgement."
    : "Reply via pinet_message. ACK briefly, do the work, report blockers immediately, report the outcome when done.";

  return `New Pinet messages:\n${lines.join("\n")}\n\n${guidance}`;
}

// ─── Pinet control messages ─────────────────────────────

export type PinetControlCommand = "reload" | "exit";

export interface PinetRemoteControlState {
  currentCommand: PinetControlCommand | null;
  queuedCommand: PinetControlCommand | null;
}

export interface PinetRemoteControlRequestResult extends PinetRemoteControlState {
  accepted: boolean;
  shouldStartNow: boolean;
  status: "start" | "queued" | "covered";
  scheduledCommand: PinetControlCommand;
  ackDisposition: "immediate" | "on_start";
}

export function parsePinetControlCommand(value: unknown): PinetControlCommand | null {
  return value === "reload" || value === "exit" ? value : null;
}

export function queuePinetRemoteControl(
  state: PinetRemoteControlState,
  command: PinetControlCommand,
): PinetRemoteControlRequestResult {
  if (!state.currentCommand) {
    return {
      currentCommand: command,
      queuedCommand: state.queuedCommand,
      accepted: true,
      shouldStartNow: true,
      status: "start",
      scheduledCommand: command,
      ackDisposition: "immediate",
    };
  }

  if (state.currentCommand === "exit") {
    return {
      currentCommand: state.currentCommand,
      queuedCommand: state.queuedCommand,
      accepted: true,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: state.currentCommand,
      ackDisposition: "immediate",
    };
  }

  const queuedCommand =
    state.queuedCommand === "exit" || command === "exit"
      ? "exit"
      : (state.queuedCommand ?? command);

  const status = queuedCommand === state.queuedCommand ? "covered" : "queued";

  return {
    currentCommand: state.currentCommand,
    queuedCommand,
    accepted: true,
    shouldStartNow: false,
    status,
    scheduledCommand: queuedCommand,
    ackDisposition: "on_start",
  };
}

export function finishPinetRemoteControl(
  state: PinetRemoteControlState,
): PinetRemoteControlState & { nextCommand: PinetControlCommand | null } {
  return {
    currentCommand: state.queuedCommand,
    queuedCommand: null,
    nextCommand: state.queuedCommand,
  };
}

export interface PinetRuntimeReloader<State> {
  getCurrentRole: () => "broker" | "follower" | null;
  snapshotState: () => State;
  restoreState: (snapshot: State) => void;
  refreshState: () => void;
  validateRefreshedState: () => void | Promise<void>;
  stopRuntime: () => Promise<void>;
  startRuntime: (role: "broker" | "follower") => Promise<void>;
}

export async function reloadPinetRuntimeSafely<State>(
  reloader: PinetRuntimeReloader<State>,
): Promise<void> {
  const role = reloader.getCurrentRole();
  if (!role) {
    throw new Error("Pinet is not running.");
  }

  const snapshot = reloader.snapshotState();

  try {
    reloader.refreshState();
    await reloader.validateRefreshedState();
  } catch (validationErr) {
    reloader.restoreState(snapshot);
    throw validationErr;
  }

  await reloader.stopRuntime();

  try {
    await reloader.startRuntime(role);
  } catch (reloadErr) {
    reloader.restoreState(snapshot);

    try {
      await reloader.startRuntime(role);
    } catch (rollbackErr) {
      const reloadMessage = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
      const rollbackMessage =
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new Error(
        `Reload failed: ${reloadMessage}. Rollback to the previous runtime also failed: ${rollbackMessage}`,
      );
    }

    const reloadMessage = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
    throw new Error(`Reload failed: ${reloadMessage}. Restored the previous runtime.`);
  }
}

export interface PinetControlEnvelope {
  type: "pinet:control";
  action: PinetControlCommand;
}

function parsePinetControlEnvelope(value: unknown): PinetControlCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== "pinet:control") return null;
  return parsePinetControlCommand(record.action);
}

function parseStructuredPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;

  try {
    return parsePinetControlEnvelope(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function parseLegacyPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  const trimmed = text?.trim();
  if (trimmed === "/reload") return "reload";
  if (trimmed === "/exit") return "exit";
  return null;
}

export function getPinetControlCommandFromText(
  text: string | undefined,
): PinetControlCommand | null {
  return (
    parseStructuredPinetControlCommandFromText(text) ?? parseLegacyPinetControlCommandFromText(text)
  );
}

export function buildPinetControlMetadata(command: PinetControlCommand): PinetControlEnvelope {
  return { type: "pinet:control", action: command };
}

export function buildPinetControlMessage(command: PinetControlCommand): string {
  return JSON.stringify(buildPinetControlMetadata(command));
}

export function normalizeOutgoingPinetControlMessage(
  body: string,
  metadata?: Record<string, unknown>,
): { body: string; metadata: Record<string, unknown> } | null {
  const command = getPinetControlCommandFromText(body);
  if (!command) return null;

  return {
    body: buildPinetControlMessage(command),
    metadata: {
      ...(metadata ?? {}),
      ...buildPinetControlMetadata(command),
    },
  };
}

export interface PinetSkinUpdate {
  theme: string;
  name: string;
  emoji: string;
  personality: string;
}

export function buildPinetSkinMetadata(update: PinetSkinUpdate): Record<string, unknown> {
  return {
    kind: "pinet_skin",
    theme: update.theme,
    name: update.name,
    emoji: update.emoji,
    personality: update.personality,
  };
}

export function extractPinetSkinUpdate(message: {
  threadId?: string;
  body?: string;
  metadata?: Record<string, unknown> | null;
}): PinetSkinUpdate | null {
  const metadata = message.metadata ?? {};
  const isAgentToAgent =
    metadata.a2a === true ||
    (typeof message.threadId === "string" && message.threadId.startsWith("a2a:"));
  if (!isAgentToAgent || metadata.kind !== "pinet_skin") return null;

  const theme = typeof metadata.theme === "string" ? metadata.theme.trim() : "";
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const emoji = typeof metadata.emoji === "string" ? metadata.emoji.trim() : "";
  const personality = typeof metadata.personality === "string" ? metadata.personality.trim() : "";
  if (!theme || !name || !emoji || !personality) return null;

  return { theme, name, emoji, personality };
}

export function extractPinetControlCommand(message: {
  threadId?: string;
  body?: string;
  metadata?: Record<string, unknown> | null;
}): PinetControlCommand | null {
  const metadata = message.metadata ?? {};
  const isAgentToAgent =
    metadata.a2a === true ||
    (typeof message.threadId === "string" && message.threadId.startsWith("a2a:"));
  if (!isAgentToAgent) return null;

  const metadataCommand =
    parsePinetControlEnvelope(metadata) ??
    (metadata.kind === "pinet_control" ? parsePinetControlCommand(metadata.command) : null);
  if (metadataCommand) return metadataCommand;

  // Backward-compatible fallback for structured JSON or exact slash commands sent over a2a flows.
  return getPinetControlCommandFromText(message.body);
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

// ─── Abort / shutdown helpers ────────────────────────────

export interface AbortableOperationTracker {
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  abortAndWait(): Promise<void>;
  isAborting(): boolean;
}

export function createAbortError(message = "Operation aborted"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createAbortableOperationTracker(): AbortableOperationTracker {
  let aborting = false;
  const controllers = new Set<AbortController>();
  const operations = new Set<Promise<unknown>>();

  return {
    async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (aborting) {
        throw createAbortError("Operation rejected: shutdown in progress");
      }

      const controller = new AbortController();
      const tracked = Promise.resolve().then(() => operation(controller.signal));
      controllers.add(controller);
      operations.add(tracked);

      try {
        return await tracked;
      } finally {
        controllers.delete(controller);
        operations.delete(tracked);
      }
    },

    async abortAndWait(): Promise<void> {
      aborting = true;
      for (const controller of controllers) {
        controller.abort();
      }
      if (operations.size === 0) return;
      await Promise.allSettled(Array.from(operations));
    },

    isAborting(): boolean {
      return aborting;
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
  scope?: RuntimeScopeCarrier | null;
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
    worktreePath?: string;
    worktreeKind?: "main" | "linked";
    skinTheme?: string;
    personality?: string;
    capabilities?: AgentCapabilities | null;
    scope?: RuntimeScopeCarrier | null;
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
  outboundCount?: number | null;
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
  lastSeen?: string;
  disconnectedAt?: string | null;
  resumableUntil?: string | null;
  idleSince?: string | null;
  lastActivity?: string | null;
  outboundCount?: number | null;
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

function extractRuntimeScopeCarrier(value: unknown): RuntimeScopeCarrier | null {
  const record = asRecord(value);
  if (!record) return null;

  const workspaceRecord = asRecord(record.workspace);
  const instanceRecord = asRecord(record.instance);
  const scope = buildRuntimeScopeCarrier({
    workspace: workspaceRecord
      ? {
          provider: asString(workspaceRecord.provider) ?? "slack",
          source: asString(workspaceRecord.source) === "explicit" ? "explicit" : "compatibility",
          ...(asString(workspaceRecord.compatibilityKey)
            ? { compatibilityKey: asString(workspaceRecord.compatibilityKey) }
            : {}),
          ...(asString(workspaceRecord.workspaceId)
            ? { workspaceId: asString(workspaceRecord.workspaceId) }
            : {}),
          ...(asString(workspaceRecord.installId)
            ? { installId: asString(workspaceRecord.installId) }
            : {}),
          ...(asString(workspaceRecord.channelId)
            ? { channelId: asString(workspaceRecord.channelId) }
            : {}),
        }
      : null,
    instance: instanceRecord
      ? {
          source: asString(instanceRecord.source) === "explicit" ? "explicit" : "compatibility",
          ...(asString(instanceRecord.compatibilityKey)
            ? { compatibilityKey: asString(instanceRecord.compatibilityKey) }
            : {}),
          ...(asString(instanceRecord.instanceId)
            ? { instanceId: asString(instanceRecord.instanceId) }
            : {}),
          ...(asString(instanceRecord.instanceName)
            ? { instanceName: asString(instanceRecord.instanceName) }
            : {}),
        }
      : null,
  });

  return scope ?? null;
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
    scope: extractRuntimeScopeCarrier(capabilitiesRecord?.scope ?? record?.scope),
  };
}

export function buildAgentCapabilityTags(capabilities: AgentCapabilities): string[] {
  const tags = new Set<string>();

  if (capabilities.role) tags.add(`role:${capabilities.role}`);
  if (capabilities.repo) tags.add(`repo:${capabilities.repo}`);
  if (capabilities.branch) tags.add(`branch:${capabilities.branch}`);
  if (capabilities.scope?.workspace?.provider) {
    tags.add(`scope-provider:${capabilities.scope.workspace.provider}`);
  }
  if (capabilities.scope?.workspace?.compatibilityKey) {
    tags.add(`scope:${capabilities.scope.workspace.compatibilityKey}`);
  }
  if (capabilities.scope?.workspace?.workspaceId) {
    tags.add(`workspace:${capabilities.scope.workspace.workspaceId}`);
  }
  if (capabilities.scope?.instance?.instanceId) {
    tags.add(`instance:${capabilities.scope.instance.instanceId}`);
  }
  if (capabilities.scope?.instance?.instanceName) {
    tags.add(`instance-name:${capabilities.scope.instance.instanceName}`);
  }
  for (const tool of capabilities.tools ?? []) {
    tags.add(`tool:${tool}`);
  }
  for (const tag of capabilities.tags ?? []) {
    tags.add(tag);
  }

  return [...tags];
}

export interface MeshVisibilityOptions {
  includeGhosts?: boolean;
  now?: number;
  recentDisconnectWindowMs: number;
}

export function isAgentVisibleInMesh(
  agent: { disconnectedAt?: string | null },
  options: MeshVisibilityOptions,
): boolean {
  const includeGhosts = options.includeGhosts ?? true;
  if (!includeGhosts) {
    return !agent.disconnectedAt;
  }
  if (!agent.disconnectedAt) {
    return true;
  }

  const nowMs = options.now ?? Date.now();
  const disconnectedMs = Date.parse(agent.disconnectedAt);
  return (
    !Number.isNaN(disconnectedMs) && nowMs - disconnectedMs <= options.recentDisconnectWindowMs
  );
}

export function filterAgentsForMeshVisibility<T extends { disconnectedAt?: string | null }>(
  agents: T[],
  options: MeshVisibilityOptions,
): T[] {
  return agents.filter((agent) => isAgentVisibleInMesh(agent, options));
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
  const lastSeenMs = parseIsoMs(agent.lastSeen);
  const lastSeenAgeMs = lastSeenMs == null ? null : Math.max(0, nowMs - lastSeenMs);
  const computedLeaseExpiresAt =
    agent.resumableUntil ??
    (heartbeatMs == null ? null : new Date(heartbeatMs + heartbeatTimeoutMs).toISOString());
  const disconnectedAtMs = parseIsoMs(agent.disconnectedAt);
  const resumableUntilMs = parseIsoMs(agent.resumableUntil);
  const staleThresholdMs = Math.max(
    heartbeatIntervalMs * 2,
    heartbeatTimeoutMs - heartbeatIntervalMs,
  );
  const connectedButRecentlySeen =
    disconnectedAtMs == null && lastSeenAgeMs != null && lastSeenAgeMs <= heartbeatTimeoutMs;

  let health: AgentHealth = "healthy";
  if (disconnectedAtMs != null && resumableUntilMs != null && resumableUntilMs > nowMs) {
    health = "resumable";
  } else if (
    disconnectedAtMs != null ||
    (heartbeatAgeMs != null && heartbeatAgeMs > heartbeatTimeoutMs && !connectedButRecentlySeen)
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
          skinTheme: asString(metadata.skinTheme),
          personality: asString(metadata.personality),
          ...(capabilities.scope ? { scope: capabilities.scope } : {}),
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
    outboundCount: agent.outboundCount ?? null,
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
  brokerAgentId?: string;
}

export interface RalphLoopEvaluationResult {
  ghostAgentIds: string[];
  nudgeAgentIds: string[];
  idleDrainAgentIds: string[];
  stuckAgentIds: string[];
  anomalies: string[];
}

export interface RalphLoopGhostAnomalyRewriteResult {
  evaluation: RalphLoopEvaluationResult;
  nonGhostAnomalies: string[];
  newGhostIds: string[];
  clearedGhostIds: string[];
  nextReportedGhostIds: string[];
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
  const brokerAgentId = options.brokerAgentId;
  const anomalies: string[] = [];
  const ghostAgentIds: string[] = [];
  const nudgeAgentIds: string[] = [];
  const idleDrainAgentIds: string[] = [];
  const stuckAgentIds: string[] = [];

  for (const workload of workloads) {
    if (brokerAgentId && workload.id === brokerAgentId) {
      continue;
    }

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
    const lastSeenMs = parseIsoMs(workload.lastSeen);
    const lastHeartbeatMs = parseIsoMs(workload.lastHeartbeat);
    const lastContactMs =
      lastSeenMs == null
        ? lastHeartbeatMs
        : lastHeartbeatMs == null
          ? lastSeenMs
          : Math.max(lastSeenMs, lastHeartbeatMs);
    const idleAgeMs = lastContactMs == null ? null : Math.max(0, nowMs - lastContactMs);

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

    // Stuck detection: agent reports "working" and stale activity long past the threshold,
    // but heartbeats alone only prove liveness, not lack of progress. Quiet workers can stay
    // healthy with a claimed thread and fresh heartbeats while doing non-chatty work, so only
    // escalate when there is worker-local pressure (queued inbox work) or heartbeat evidence is
    // missing. Global backlog is too broad to attribute to a specific quiet worker here.
    if (workload.status === "working" && display.health === "healthy") {
      const lastActivityMs = parseIsoMs(workload.lastActivity);
      const activityAgeMs = lastActivityMs == null ? null : Math.max(0, nowMs - lastActivityMs);
      const hasFreshHeartbeat = display.heartbeatAgeMs != null;
      const hasWorkerLocalQueuePressure = workload.pendingInboxCount > 0;
      if (
        activityAgeMs != null &&
        activityAgeMs >= stuckWorkingThresholdMs &&
        (hasWorkerLocalQueuePressure || !hasFreshHeartbeat)
      ) {
        stuckAgentIds.push(workload.id);
        const thresholdMinutes = Math.max(1, Math.round(stuckWorkingThresholdMs / 60_000));
        anomalies.push(
          `${workload.name} appears stuck (working with no activity beyond ${thresholdMinutes}m threshold)`,
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

export interface RalphLoopGhostAnomalyRewriteOptions {
  suppressedGhostIds?: Iterable<string>;
}

export function rewriteRalphLoopGhostAnomalies(
  evaluation: RalphLoopEvaluationResult,
  previousGhostIds: Iterable<string> = [],
  options: RalphLoopGhostAnomalyRewriteOptions = {},
): RalphLoopGhostAnomalyRewriteResult {
  const priorGhostIds = new Set(previousGhostIds);
  const suppressedGhostIds = new Set(options.suppressedGhostIds ?? []);
  const currentGhostIds = new Set(evaluation.ghostAgentIds);
  const visibleGhostIds = evaluation.ghostAgentIds.filter((id) => !suppressedGhostIds.has(id));
  const retainedSuppressedGhostIds = [...priorGhostIds].filter(
    (id) => suppressedGhostIds.has(id) && currentGhostIds.has(id),
  );
  const nextReportedGhostIds = [...new Set([...visibleGhostIds, ...retainedSuppressedGhostIds])];
  const newGhostIds = visibleGhostIds.filter((id) => !priorGhostIds.has(id));
  const currentReportedGhostIds = new Set(nextReportedGhostIds);
  const clearedGhostIds = [...priorGhostIds].filter((id) => !currentReportedGhostIds.has(id));
  const nonGhostAnomalies = evaluation.anomalies.filter(
    (anomaly) => !anomaly.startsWith("ghost agents detected:"),
  );
  const anomalies = [...nonGhostAnomalies];

  if (newGhostIds.length > 0) {
    anomalies.push(`NEW ghost agents detected: ${newGhostIds.join(", ")}`);
  }
  if (clearedGhostIds.length > 0) {
    anomalies.push(`ghost agents cleared from registry: ${clearedGhostIds.join(", ")}`);
  }

  return {
    evaluation: {
      ...evaluation,
      ghostAgentIds: visibleGhostIds,
      anomalies,
    },
    nonGhostAnomalies,
    newGhostIds,
    clearedGhostIds,
    nextReportedGhostIds,
  };
}

export function buildRalphLoopNudgeMessage(
  pendingInboxCount: number,
  ownedThreadCount: number,
  cycleStartedAt?: string,
): string {
  const parts = [];
  if (pendingInboxCount > 0) {
    parts.push(`${pendingInboxCount} inbox item${pendingInboxCount === 1 ? "" : "s"}`);
  }
  if (ownedThreadCount > 0) {
    parts.push(`${ownedThreadCount} claimed thread${ownedThreadCount === 1 ? "" : "s"}`);
  }
  const workload = parts.length > 0 ? parts.join(" and ") : "assigned work";
  const prefix = cycleStartedAt ? `RALPH LOOP nudge (${cycleStartedAt})` : "RALPH LOOP nudge";
  return `${prefix}: you appear idle but still have ${workload}. Please pick it up, post a status update, or release ownership so the broker can reassign it.`;
}

export function buildRalphLoopAnomalySignature(evaluation: RalphLoopEvaluationResult): string {
  return evaluation.anomalies.join("|");
}

export function buildRalphLoopStatusMessage(summary: string, cycleStartedAt: string): string {
  return `RALPH loop (${cycleStartedAt}): ${summary}`;
}

export interface RalphLoopFollowUpDeliveryOptions {
  signature: string;
  lastDeliveredSignature?: string;
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
  if (options.lastDeliveredSignature === options.signature) {
    return false;
  }
  if (lastDeliveredAt > 0 && now - lastDeliveredAt < cooldownMs) {
    return false;
  }
  return true;
}

export function buildRalphLoopFollowUpMessage(
  evaluation: RalphLoopEvaluationResult,
  cycleStartedAt: string,
): string | null {
  if (evaluation.anomalies.length === 0) {
    return null;
  }

  return [
    "RALPH LOOP CYCLE:",
    `Timestamp: ${cycleStartedAt}`,
    ...evaluation.anomalies.map((anomaly) => `- ${anomaly}`),
    "",
    "Take action: reap ghosts, nudge idle workers, reassign stalled work, drain backlog, maintain momentum, and repair broker anomalies.",
  ].join("\n");
}

export interface RalphLoopCycleNotifications {
  followUpPrompt: string | null;
  anomalyStatus: string | null;
  recoveryStatus: string;
}

export function buildRalphLoopCycleNotifications(
  evaluation: RalphLoopEvaluationResult,
  cycleStartedAt: string,
): RalphLoopCycleNotifications {
  return {
    followUpPrompt: buildRalphLoopFollowUpMessage(evaluation, cycleStartedAt),
    anomalyStatus:
      evaluation.anomalies.length > 0
        ? buildRalphLoopStatusMessage(evaluation.anomalies.join("; "), cycleStartedAt)
        : null,
    recoveryStatus: buildRalphLoopStatusMessage("health recovered", cycleStartedAt),
  };
}

export function buildBrokerPromptGuidelines(agentEmoji: string, agentName: string): string[] {
  return [
    `You are ${agentEmoji} ${agentName}, the Pinet BROKER. Your ONLY role is coordination and infrastructure — NEVER implementation.`,
    // ── HARD GUARDRAIL ──────────────────────────────────────────
    "🚫 HARD RULE — NEVER WRITE CODE: You MUST NOT implement features, fix bugs, write tests, edit source files, or do any coding task. This is a non-negotiable constraint, not a preference. Violations stall the entire multi-agent mesh.",
    "WHY THIS RULE EXISTS: You are the ONLY process routing Slack messages, monitoring agent health, and keeping the mesh alive. If you spend even one turn writing code, messages stop flowing, dead agents don't get reaped, backlog piles up, and the whole system stalls. Workers are computation, broker is infrastructure.",
    // ── FORBIDDEN ACTIONS ───────────────────────────────────────
    "FORBIDDEN — Do NOT do any of these, even if explicitly asked: (1) Use the Agent tool to spawn local subagents — they have no Slack/Pinet connectivity and can't be monitored. (2) Use edit or write at all — those tools are hard-blocked for the broker at runtime. (3) Use bash to modify source code or do implementation work. (4) Pick up coding tasks, bug fixes, refactors, or implementation work. (5) Run test suites, linters, or build commands as part of implementation work. (6) Create or modify source files in any worktree.",
    "IF ASKED TO CODE: Refuse politely and immediately delegate. Say: 'I'm the broker — I coordinate, not code. Let me find a worker for this.' Then check pinet_agents and delegate via pinet_message.",
    // ── ALLOWED ACTIONS ─────────────────────────────────────────
    "ALLOWED — These are your responsibilities: (1) Route messages between humans and agents. (2) Check pinet_agents for idle workers and delegate tasks via pinet_message. (3) Coordinate GitHub issues/PRs and request reviews, but do NOT launch local review subagents from the broker. (4) Monitor agent health via the RALPH loop. (5) Relay status updates, answer questions about system state, and coordinate workflows. (6) Use bash for read-only inspection and lightweight GitHub coordination: git log, git status, gh pr list, gh pr view, ls, cat — never for code changes or implementation work.",
    "TRIAGE, THEN DELEGATE: Do only the minimum quick triage needed to route work well — for example, confirm the repo, branch, issue/PR number, current worker availability, and a light GitHub status check. Delegate before any deep repo/source inspection.",
    "DEEP INSPECTION BELONGS TO WORKERS: Do NOT read through multiple source files, trace implementations, perform deep diagnosis, or inspect the codebase in detail before assigning the task. That investigation is worker implementation work, even when you are only trying to be helpful.",
    "When a human asks for work to be done, ALWAYS check `pinet_agents` for idle workers and delegate via `pinet_message`. Pick the agent on the right repo/branch when possible.",
    "If a repo instruction says to use the `code-reviewer` subagent, treat that as work to assign to a connected worker session — never the broker itself.",
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
    "5. When you have finished all assigned work and are waiting for more, call `pinet_free` (or `/pinet-free`) to mark yourself idle/free for the broker.",
    "Always reply where the task came from.",
    "If a Pinet thread explicitly says things like 'no further replies are needed', 'hard stop', or 'stay free/quiet unless a new task appears', treat it as a terminal closeout. Do NOT send another acknowledgement unless you have a real blocker, a materially new finding, or a genuinely new task arrives in that thread.",
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

export function buildPinetSkinPromptGuideline(
  theme: string | null | undefined,
  personality: string | null | undefined,
): string | null {
  if (!theme || !personality) return null;
  return clampPinetSkinText(
    `PINET SKIN (${formatPinetSkinThemeLabel(theme)}): ${clampPinetSkinText(
      personality,
      MAX_PINET_SKIN_PERSONALITY_LENGTH,
    )} Keep it additive: flavor cadence and word choice, never clarity, accuracy, blocker/status discipline, or role boundaries.`,
    MAX_PINET_SKIN_PROMPT_GUIDELINE_LENGTH,
  );
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

export interface AgentPersonalityProfile {
  descriptor?: string;
  animal?: string;
  traits: string[];
}

const DEFAULT_PERSONALITY_TRAITS = ["thoughtful", "steady", "clear"];
const DESCRIPTOR_PERSONALITY_TRAITS: Record<string, string[]> = {};
const ANIMAL_PERSONALITY_TRAITS: Record<string, string[]> = {};

function assignPersonalityTraits(
  target: Record<string, string[]>,
  names: string[],
  traits: string[],
): void {
  for (const name of names) {
    target[name] = traits;
  }
}

assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Rocket", "Turbo", "Hyper", "Ultra", "Mega", "Sonic", "Rapid"],
  ["fast", "playful", "bold"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Silent", "Shadow", "Velvet", "Frozen", "Glacial"],
  ["quiet", "patient", "precise"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Cosmic", "Solar", "Stellar", "Galactic", "Lunar", "Nova", "Aurora", "Nimbus", "Orbit", "Comet"],
  ["far-seeing", "thoughtful", "imaginative"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Quantum", "Pixel", "Cyber", "Atomic", "Binary", "Vector", "Prism", "Ionic", "Laser"],
  ["analytical", "curious", "precise"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Neon", "Electric", "Radiant", "Blazing", "Thunder", "Ember", "Echo"],
  ["energetic", "expressive", "confident"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Crystal", "Mystic", "Jade"],
  ["elegant", "intuitive", "thoughtful"],
);
assignPersonalityTraits(
  DESCRIPTOR_PERSONALITY_TRAITS,
  ["Golden", "Silver", "Scarlet", "Cobalt", "Iron", "Obsidian", "Slate"],
  ["steady", "composed", "direct"],
);

assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  ["Dolphin"],
  ["intelligent", "agile", "friendly"],
);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  ["Crocodile"],
  ["patient", "precise", "formidable"],
);
assignPersonalityTraits(ANIMAL_PERSONALITY_TRAITS, ["Crane"], ["elegant", "observant", "poised"]);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  ["Eagle", "Owl", "Raven", "Parrot", "Goose"],
  ["observant", "articulate", "far-seeing"],
);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  ["Fox", "Wolf", "Lynx", "Jaguar", "Tiger", "Lion", "Cobra", "Shark", "Dragon"],
  ["sharp", "decisive", "confident"],
);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  [
    "Badger",
    "Beaver",
    "Bison",
    "Buffalo",
    "Boar",
    "Bear",
    "Rhino",
    "Elephant",
    "Moose",
    "Horse",
    "Camel",
    "Goat",
  ],
  ["steady", "resilient", "grounded"],
);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  [
    "Otter",
    "Rabbit",
    "Koala",
    "Panda",
    "Monkey",
    "Sloth",
    "Turtle",
    "Whale",
    "Kangaroo",
    "Llama",
    "Deer",
    "Giraffe",
    "Hippo",
    "Zebra",
  ],
  ["warm", "calm", "approachable"],
);
assignPersonalityTraits(
  ANIMAL_PERSONALITY_TRAITS,
  ["Raccoon", "Hedgehog", "Gecko", "Mantis"],
  ["meticulous", "curious", "nimble"],
);

function mergePersonalityTraits(descriptorTraits: string[], animalTraits: string[]): string[] {
  const merged: string[] = [];
  const push = (trait?: string) => {
    if (!trait || merged.includes(trait)) return;
    merged.push(trait);
  };

  const limit = Math.max(descriptorTraits.length, animalTraits.length);
  for (let index = 0; index < limit; index++) {
    push(descriptorTraits[index]);
    push(animalTraits[index]);
  }

  if (merged.length === 0) {
    for (const trait of DEFAULT_PERSONALITY_TRAITS) {
      push(trait);
    }
  }

  return merged.slice(0, 4);
}

export function resolveAgentPersonality(agentName: string): AgentPersonalityProfile {
  const tokens = agentName.trim().split(/\s+/).filter(Boolean);
  const descriptor = tokens[0];
  const animal = tokens.length >= 2 ? tokens.at(-1) : undefined;

  return {
    descriptor,
    animal,
    traits: mergePersonalityTraits(
      descriptor ? (DESCRIPTOR_PERSONALITY_TRAITS[descriptor] ?? []) : [],
      animal ? (ANIMAL_PERSONALITY_TRAITS[animal] ?? []) : [],
    ),
  };
}

export function buildAgentPersonalityGuidelines(agentName: string): string[] {
  const personality = resolveAgentPersonality(agentName);
  return [
    "COMMUNICATION STYLE: Let your wording lightly reflect your agent name so your updates feel like the persona behind the name.",
    `For \`${agentName}\`, aim for a ${personality.traits.join(", ")} tone in Slack and Pinet messages.`,
    "Keep the style subtle: shape cadence, word choice, and flavor — not the underlying facts or recommendations.",
    "PERSONALITY SAFETY RAIL: This must NOT change task execution quality, correctness, honesty, safety, technical rigor, or willingness to surface blockers and test results.",
  ];
}

export function resolvePersistedAgentIdentity(
  settings: SlackBridgeSettings,
  persistedName?: string,
  persistedEmoji?: string,
  envNickname?: string,
  seed?: string,
  role: AgentIdentityRole = "worker",
): { name: string; emoji: string } {
  if (persistedName && persistedEmoji) {
    return { name: persistedName, emoji: persistedEmoji };
  }

  return resolveAgentIdentity(settings, envNickname, seed, role);
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

export function buildBrokerStableId(host = os.hostname(), cwd = process.cwd()): string {
  return `${host}:broker:${path.resolve(cwd)}`;
}

export function resolveBrokerStableId(
  persistedStableId?: string,
  host = os.hostname(),
  cwd = process.cwd(),
): string {
  return persistedStableId || buildBrokerStableId(host, cwd);
}

export interface PinetRegistrationContext {
  sessionHeader?: {
    parentSession?: string;
  } | null;
  sessionFile?: string;
  leafId?: string;
  argv?: string[];
  hasUI?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
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

  if (hasNoSession && (hasPrint || hasHeadlessMode)) {
    return true;
  }

  const sessionFile =
    typeof context.sessionFile === "string" && context.sessionFile.trim().length > 0
      ? context.sessionFile.trim()
      : undefined;
  const leafId =
    typeof context.leafId === "string" && context.leafId.trim().length > 0
      ? context.leafId.trim()
      : undefined;
  // Agent-tool subagents commonly show up as ephemeral leaf sessions: no persisted
  // session file, a generated leaf id, and no attached TTY. Those should never join
  // the mesh even when auto-follow is enabled.
  const hasEphemeralLeafSession = !sessionFile && Boolean(leafId);
  const hasTTY = Boolean(
    (context.stdinIsTTY ?? process.stdin.isTTY) || (context.stdoutIsTTY ?? process.stdout.isTTY),
  );

  return hasEphemeralLeafSession && (hasHeadlessMode || context.hasUI === false || !hasTTY);
}

export interface FollowerThreadState {
  channelId: string;
  threadTs: string;
  userId: string;
  source?: string;
  owner?: string;
}

export interface FollowerInboxEntry {
  inboxId?: number;
  message: {
    threadId?: string;
    source?: string;
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

export interface BrokerInboxControlEntry {
  inboxId: number;
  command: PinetControlCommand;
}

export interface BrokerInboxSkinEntry {
  inboxId: number;
  update: { theme: string; name: string; emoji: string; personality: string };
}

export interface BrokerInboxSyncResult {
  controlEntries: BrokerInboxControlEntry[];
  skinEntries: BrokerInboxSkinEntry[];
  inboxMessages: InboxMessage[];
}

export function isDirectMessageChannel(channel: string): boolean {
  return /^D[A-Z0-9]+$/.test(channel);
}

export function syncFollowerInboxEntries(
  entries: FollowerInboxEntry[],
  existingThreads: ReadonlyMap<string, FollowerThreadState>,
  agentOwner: string,
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
    const scope = extractRuntimeScopeCarrier(meta.scope);

    if (threadTs && channel) {
      const existing = existingThreads.get(threadTs);
      const source =
        typeof entry.message.source === "string" && entry.message.source.trim().length > 0
          ? entry.message.source.trim()
          : existing?.source;
      const nextThread: FollowerThreadState = {
        channelId: channel,
        threadTs,
        userId: existing?.userId || sender,
        owner: existing?.owner ?? agentOwner,
        ...(source ? { source } : {}),
      };

      if (
        !existing ||
        existing.channelId !== nextThread.channelId ||
        existing.userId !== nextThread.userId ||
        existing.owner !== nextThread.owner ||
        existing.source !== nextThread.source
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
      brokerInboxId: entry.inboxId,
      metadata: meta,
      ...(scope ? { scope } : {}),
    };
  });

  return {
    inboxMessages,
    threadUpdates,
    lastDmChannel: nextLastDmChannel,
    changed,
  };
}

export function syncBrokerInboxEntries(entries: FollowerInboxEntry[]): BrokerInboxSyncResult {
  const controlEntries: BrokerInboxControlEntry[] = [];
  const skinEntries: BrokerInboxSkinEntry[] = [];
  const inboxMessages: InboxMessage[] = [];

  for (const entry of entries) {
    const meta = entry.message.metadata ?? {};
    const threadTs = entry.message.threadId ?? "";
    const sender = entry.message.sender ?? "";
    const body = entry.message.body ?? "";
    const createdAt = entry.message.createdAt ?? "";
    const inboxId = entry.inboxId;

    const control = extractPinetControlCommand({
      threadId: threadTs,
      body,
      metadata: meta,
    });
    if (control && inboxId != null) {
      controlEntries.push({ inboxId, command: control });
      continue;
    }

    const skinUpdate = extractPinetSkinUpdate({
      threadId: threadTs,
      body,
      metadata: meta,
    });
    if (skinUpdate && inboxId != null) {
      skinEntries.push({ inboxId, update: skinUpdate });
      continue;
    }

    const scope = extractRuntimeScopeCarrier(meta.scope);
    inboxMessages.push({
      channel: "",
      threadTs,
      userId: sender,
      text: body,
      timestamp: createdAt,
      brokerInboxId: inboxId,
      metadata: meta,
      ...(scope ? { scope } : {}),
    });
  }

  return {
    controlEntries,
    skinEntries,
    inboxMessages,
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
  resolveThread?: (threadTs: string) => Promise<string | null>,
): Promise<FollowerThreadChannelResolution> {
  if (!threadTs) {
    return { channelId: null, changed: false };
  }

  if (!resolveThread) {
    return existingThread?.channelId
      ? { channelId: existingThread.channelId, changed: false }
      : { channelId: null, changed: false };
  }

  try {
    const channelId = await resolveThread(threadTs);
    if (!channelId) {
      return { channelId: null, changed: false };
    }

    if (existingThread?.channelId === channelId) {
      return { channelId, changed: false };
    }

    return {
      channelId,
      changed: true,
      threadUpdate: {
        channelId,
        threadTs,
        userId: existingThread?.userId ?? "",
        ...(existingThread?.source ? { source: existingThread.source } : {}),
        owner: existingThread?.owner,
      },
    };
  } catch {
    return { channelId: null, changed: false };
  }
}

export type FollowerRuntimeDiagnosticKind =
  | "broker_disconnect"
  | "poll_failure"
  | "registration_refresh_failure"
  | "reconnect_stopped";

export type FollowerRuntimeDiagnosticState = "reconnecting" | "degraded" | "error";

export interface FollowerRuntimeDiagnostic {
  kind: FollowerRuntimeDiagnosticKind;
  state: FollowerRuntimeDiagnosticState;
  reason: string;
  nextStep: string;
  detail?: string;
}

export function buildFollowerRuntimeDiagnostic(
  kind: FollowerRuntimeDiagnosticKind,
  options: {
    detail?: string | null;
    connected?: boolean;
  } = {},
): FollowerRuntimeDiagnostic {
  const detail = options.detail?.trim() || undefined;

  if (kind === "broker_disconnect") {
    return {
      kind,
      state: "reconnecting",
      reason: "broker disconnected",
      nextStep: "Wait for automatic reconnect. If it does not recover, run /pinet-follow.",
      ...(detail ? { detail } : {}),
    };
  }

  if (kind === "poll_failure") {
    const connected = options.connected ?? true;
    return {
      kind,
      state: connected ? "degraded" : "reconnecting",
      reason: "inbox polling failed",
      nextStep: connected
        ? "Watch the next poll cycle. If failures continue, inspect the broker and run /pinet-follow."
        : "Wait for automatic reconnect. If it does not recover, run /pinet-follow.",
      ...(detail ? { detail } : {}),
    };
  }

  if (kind === "registration_refresh_failure") {
    return {
      kind,
      state: "degraded",
      reason: "registration refresh failed after reconnect",
      nextStep:
        "Follower kept the last registered identity. If status or ownership looks stale, run /pinet-follow.",
      ...(detail ? { detail } : {}),
    };
  }

  return {
    kind,
    state: "error",
    reason: "automatic reconnect stopped",
    nextStep: "Fix the reported error, then run /pinet-follow to retry.",
    ...(detail ? { detail } : {}),
  };
}

export function formatFollowerRuntimeDiagnosticHealth(
  diagnostic: FollowerRuntimeDiagnostic | null,
): string {
  if (!diagnostic) {
    return "healthy";
  }

  return `${diagnostic.state} — ${diagnostic.reason}${diagnostic.detail ? ` (${diagnostic.detail})` : ""}`;
}

export function formatFollowerRuntimeDiagnosticNextStep(
  diagnostic: FollowerRuntimeDiagnostic | null,
): string {
  return diagnostic?.nextStep ?? "None.";
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

export function agentOwnsThread(
  owner: string | undefined,
  agentName: string,
  agentAliases: Iterable<string> = [],
  ownerToken?: string,
): boolean {
  if (!owner) return false;
  if (ownerToken && owner === ownerToken) return true;
  if (owner === agentName) return true;
  for (const alias of agentAliases) {
    if (owner === alias) return true;
  }
  return false;
}

export function normalizeOwnedThreads(
  threads: Iterable<{ owner?: string }>,
  agentName: string,
  ownerToken: string,
  agentAliases: Iterable<string> = [],
): boolean {
  let changed = false;
  for (const thread of threads) {
    if (!agentOwnsThread(thread.owner, agentName, agentAliases, ownerToken)) continue;
    if (thread.owner === ownerToken) continue;
    thread.owner = ownerToken;
    changed = true;
  }
  return changed;
}

export function getFollowerOwnedThreadClaims(
  threads: ReadonlyMap<
    string,
    Pick<FollowerThreadState, "threadTs" | "channelId" | "source" | "owner">
  >,
  agentName: string,
  agentAliases: Iterable<string> = [],
  ownerToken?: string,
): Array<{ threadTs: string; channelId: string; source?: string }> {
  return [...threads.values()]
    .filter(
      (thread) =>
        agentOwnsThread(thread.owner, agentName, agentAliases, ownerToken) &&
        Boolean(thread.threadTs) &&
        Boolean(thread.channelId),
    )
    .map((thread) => ({
      threadTs: thread.threadTs,
      channelId: thread.channelId,
      ...(thread.source ? { source: thread.source } : {}),
    }));
}

export function getFollowerOwnedThreadReclaims(
  threads: ReadonlyMap<
    string,
    Pick<FollowerThreadState, "threadTs" | "channelId" | "source" | "owner">
  >,
  agentName: string,
  agentAliases: Iterable<string> = [],
  ownerToken?: string,
): Array<{ threadTs: string; channelId: string; source: string }> {
  return getFollowerOwnedThreadClaims(threads, agentName, agentAliases, ownerToken).flatMap(
    (thread) =>
      thread.source
        ? [{ threadTs: thread.threadTs, channelId: thread.channelId, source: thread.source }]
        : [],
  );
}

/**
 * Cache a thread from a broker inbound message in the local threads map.
 * The broker DB remains the source of truth; this is only a read-through
 * cache so Slack tools can resolve channels without hitting the DB every time.
 */
export function trackBrokerInboundThread(
  threads: Map<string, FollowerThreadState>,
  inMsg: { threadId: string; channel: string; userId?: string; source?: string },
  owner?: string,
): void {
  if (!inMsg.threadId || !inMsg.channel) return;

  const existing = threads.get(inMsg.threadId);
  if (!existing) {
    threads.set(inMsg.threadId, {
      channelId: inMsg.channel,
      threadTs: inMsg.threadId,
      userId: inMsg.userId ?? "",
      ...(inMsg.source ? { source: inMsg.source } : {}),
      owner,
    });
    return;
  }

  if (!existing.source && inMsg.source) {
    existing.source = inMsg.source;
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

      if (meta?.skinTheme) {
        line += `\n   skin: ${meta.skinTheme}`;
      }

      if (meta?.personality) {
        const personaPreview =
          meta.personality.length > 96 ? `${meta.personality.slice(0, 93)}...` : meta.personality;
        line += `\n   persona: ${personaPreview}`;
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

      if (a.outboundCount != null) {
        line += `\n   outbound: ${a.outboundCount} this session`;
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

export type AgentIdentityRole = "broker" | "worker";

export function buildPinetOwnerToken(stableId: string): string {
  const primary = hashString(stableId).toString(16).padStart(8, "0");
  const secondary = hashString(`${stableId}:owner`).toString(16).padStart(8, "0");
  return `owner:${primary}${secondary}`;
}

export function generateAgentName(
  seed?: string,
  role: AgentIdentityRole = "worker",
): { name: string; emoji: string } {
  const animalIndex = seed
    ? hashString(`${seed}:animal`) % ANIMALS.length
    : Math.floor(Math.random() * ANIMALS.length);
  const emoji = EMOJIS[animalIndex];

  if (role === "broker") {
    return {
      name: `The Broker ${ANIMALS[animalIndex]}`,
      emoji,
    };
  }
  const adjectiveIndex = seed
    ? hashString(`${seed}:adjective`) % ADJECTIVES.length
    : Math.floor(Math.random() * ADJECTIVES.length);
  const colorIndex = seed
    ? hashString(`${seed}:color`) % COLORS.length
    : Math.floor(Math.random() * COLORS.length);

  return {
    name: `${ADJECTIVES[adjectiveIndex]} ${COLORS[colorIndex]} ${ANIMALS[animalIndex]}`,
    emoji,
  };
}

export type PinetSkinRole = "broker" | "worker";

export interface PinetSkinAssignment {
  theme: string;
  role: PinetSkinRole;
  name: string;
  emoji: string;
  personality: string;
}

export const DEFAULT_PINET_SKIN_THEME = "default";

const MAX_PINET_SKIN_THEME_LABEL_LENGTH = 60;
const MAX_PINET_SKIN_PERSONALITY_LENGTH = 260;
const MAX_PINET_SKIN_PROMPT_GUIDELINE_LENGTH = 460;

const PINET_SKIN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

const PINET_SKIN_LEADER_TITLES = [
  "Commander",
  "Oracle",
  "Navigator",
  "Steward",
  "Marshal",
  "Warden",
  "Architect",
  "Signalmaster",
  "Anchor",
  "Captain",
];

const PINET_SKIN_WORKER_TITLES = [
  "Scout",
  "Ranger",
  "Runner",
  "Cipher",
  "Pilot",
  "Smith",
  "Courier",
  "Weaver",
  "Seeker",
  "Operator",
  "Vanguard",
  "Scribe",
];

const PINET_SKIN_MODIFIERS = [
  "Ash",
  "Chrome",
  "Cinder",
  "Circuit",
  "Copper",
  "Echo",
  "Ember",
  "Ghost",
  "Gilded",
  "Hollow",
  "Ivory",
  "Jade",
  "Lumen",
  "Night",
  "Nova",
  "Onyx",
  "Quartz",
  "Silver",
  "Static",
  "Storm",
  "Velvet",
  "Violet",
];

const PINET_SKIN_BROKER_EMOJIS = ["🧭", "🛡️", "🛰️", "🪄", "👑", "🧠", "🦉", "🌙"];
const PINET_SKIN_WORKER_EMOJIS = ["⚡", "🗡️", "🛠️", "🕶️", "🧪", "🧰", "🧿", "📡", "🔧", "🛰️"];

const PINET_SKIN_DEMEANORS = [
  "calm under pressure",
  "sharp-eyed about details",
  "quietly theatrical",
  "fast with a comeback",
  "ritualistic about checklists",
  "suspicious of sloppy work",
  "protective of teammates",
  "fond of dramatic mission language",
  "precise about timing",
  "improvisational when plans crack",
  "obsessed with clean handoffs",
  "confident without being loud",
];

const PINET_SKIN_ROLE_FOCUS = {
  broker: [
    "Coordinate, delegate, and guard role lines.",
    "Stay in mission control: route cleanly and watch mesh health.",
    "Lead quietly, keep the mesh moving, never blur roles.",
  ],
  worker: [
    "Ship cleanly, show progress, surface blockers fast.",
    "Work autonomously, hand off crisply, keep status visible.",
    "Keep the flair light and the execution exact.",
  ],
} as const;

interface PinetSkinVoiceProfile {
  matchTokens: readonly string[];
  cadences: readonly string[];
  imagery: readonly string[];
  diction: readonly string[];
}

const PINET_SKIN_GENERIC_VOICE_PROFILE: PinetSkinVoiceProfile = {
  matchTokens: [],
  cadences: [
    "distinct but disciplined pacing",
    "measured specialist calm",
    "confident, signal-first rhythm",
  ],
  imagery: [
    "just enough theme-colored detail",
    "a few memorable touches",
    "light scene-setting color",
  ],
  diction: [
    "precise verbs and clean nouns",
    "readable specialist phrasing",
    "tight status language",
  ],
};

const PINET_SKIN_VOICE_PROFILES: readonly PinetSkinVoiceProfile[] = [
  {
    matchTokens: ["cyber", "cyberpunk", "hacker", "hackers", "neon", "chrome", "circuit", "matrix"],
    cadences: [
      "clipped, high-signal tempo",
      "cool operator composure",
      "a fast terminal-room rhythm",
    ],
    imagery: ["neon-and-static touches", "back-alley console imagery", "midnight terminal color"],
    diction: [
      "precise technical verbs",
      "sharp nouns and terse status lines",
      "clean operator shorthand kept readable",
    ],
  },
  {
    matchTokens: [
      "night",
      "watch",
      "fellowship",
      "ring",
      "quest",
      "kingdom",
      "dragon",
      "throne",
      "asoiaf",
      "myth",
    ],
    cadences: [
      "watchful, oath-keeping calm",
      "quest-log steadiness",
      "campfire-veteran confidence",
    ],
    imagery: [
      "watchfire and banner imagery",
      "maps, oaths, and cold-night touches",
      "sentinel-and-hearth color",
    ],
    diction: [
      "plainspoken duty-first wording",
      "measured reports with a hint of legend",
      "mythic color without purple prose",
    ],
  },
  {
    matchTokens: [
      "apollo",
      "mission",
      "control",
      "space",
      "orbit",
      "orbital",
      "rocket",
      "lunar",
      "solar",
      "star",
      "galaxy",
    ],
    cadences: ["mission-control composure", "countdown-ready brevity", "flight-loop precision"],
    imagery: [
      "telemetry and console-room touches",
      "launch-window color",
      "starfield and instrument-panel imagery",
    ],
    diction: [
      "checklist language and clean callouts",
      "status-board phrasing",
      "disciplined technical shorthand",
    ],
  },
  {
    matchTokens: [
      "ghibli",
      "spirit",
      "forest",
      "garden",
      "moss",
      "river",
      "wind",
      "moon",
      "woods",
      "meadow",
      "lantern",
    ],
    cadences: ["quiet, observant calm", "gentle confidence", "an unhurried but alert pace"],
    imagery: [
      "lantern, weather, and small-wonder touches",
      "moss, wind, and water color",
      "natural textures used lightly",
    ],
    diction: [
      "warm precise wording",
      "soft edges around hard facts",
      "calm plain language with a little glow",
    ],
  },
  {
    matchTokens: [
      "deep",
      "sea",
      "ocean",
      "salvage",
      "tide",
      "reef",
      "abyss",
      "harbor",
      "submarine",
      "dive",
      "nautical",
    ],
    cadences: ["steady dive-team calm", "sonar-sweep patience", "weathered deckhand brevity"],
    imagery: [
      "rope, tide, and pressure-gauge touches",
      "salvage-yard detail",
      "deep-water color used sparingly",
    ],
    diction: [
      "measured callouts and sturdy verbs",
      "crew-ready status language",
      "practical field vocabulary",
    ],
  },
];

const PINET_SKIN_PERSONALITY_OPENERS = [
  'Let "{theme}" steer the cadence: {cadence}, {demeanor}.',
  'Take cues from "{theme}": {cadence}, {demeanor}.',
  'Carry "{theme}" as a quiet doctrine: {cadence}, {demeanor}.',
];

const PINET_SKIN_PERSONALITY_STYLE_TEMPLATES = [
  "Favor {diction} with {imagery}; stay scannable.",
  "Use {diction} and {imagery}; keep status crisp.",
  "Keep the wording {diction}, brushed with {imagery}, and quick to read.",
];

function titleCaseSkinToken(token: string): string {
  return token.length === 0 ? token : token[0].toUpperCase() + token.slice(1);
}

function singularizeSkinToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function pickSkinValue<T>(values: readonly T[], seed: string, label: string): T {
  return values[hashString(`${seed}:${label}`) % values.length];
}

function clampPinetSkinText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const sliceLength = Math.max(0, maxLength - 1);
  return `${trimmed.slice(0, sliceLength).trimEnd()}…`;
}

function formatPinetSkinThemeLabel(theme: string): string {
  return clampPinetSkinText(theme, MAX_PINET_SKIN_THEME_LABEL_LENGTH);
}

function getPinetSkinTokens(theme: string): string[] {
  const rawTokens = theme.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const meaningful = rawTokens
    .map((token) => singularizeSkinToken(token))
    .filter((token) => token.length > 1 && !PINET_SKIN_STOP_WORDS.has(token));
  const tokens = (meaningful.length > 0 ? meaningful : rawTokens)
    .map((token) => titleCaseSkinToken(token))
    .filter((token, index, list) => list.indexOf(token) === index);
  return tokens.length > 0 ? tokens : ["Signal"];
}

export function normalizePinetSkinTheme(theme: string | undefined): string | null {
  const trimmed = theme?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase() === DEFAULT_PINET_SKIN_THEME ? DEFAULT_PINET_SKIN_THEME : trimmed;
}

function mergeUniqueSkinValues(...lists: ReadonlyArray<readonly string[]>): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const value of list) {
      if (!merged.includes(value)) {
        merged.push(value);
      }
    }
  }
  return merged;
}

function resolvePinetSkinVoiceProfile(
  theme: string,
): Pick<PinetSkinVoiceProfile, "cadences" | "imagery" | "diction"> {
  const rawTokens: string[] = theme.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const matchedProfiles = PINET_SKIN_VOICE_PROFILES.filter((profile) =>
    profile.matchTokens.some((token) => rawTokens.includes(token)),
  );

  if (matchedProfiles.length === 0) {
    return PINET_SKIN_GENERIC_VOICE_PROFILE;
  }

  return {
    cadences: mergeUniqueSkinValues(...matchedProfiles.map((profile) => profile.cadences)),
    imagery: mergeUniqueSkinValues(...matchedProfiles.map((profile) => profile.imagery)),
    diction: mergeUniqueSkinValues(...matchedProfiles.map((profile) => profile.diction)),
  };
}

function fillPinetSkinTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, value),
    template,
  );
}

export function buildPinetSkinAssignment(options: {
  theme: string;
  role: PinetSkinRole;
  seed: string;
}): PinetSkinAssignment {
  const normalizedTheme = normalizePinetSkinTheme(options.theme) ?? DEFAULT_PINET_SKIN_THEME;

  if (normalizedTheme === DEFAULT_PINET_SKIN_THEME) {
    const generated = generateAgentName(options.seed, options.role);
    const personality =
      options.role === "broker"
        ? "Default whimsical broker skin. Be playful but disciplined, delegate clearly, and keep the mesh coordinated."
        : "Default whimsical worker skin. Be playful but focused, do the work, and report blockers and outcomes clearly.";
    return {
      theme: normalizedTheme,
      role: options.role,
      name: generated.name,
      emoji: generated.emoji,
      personality,
    };
  }

  const themeLabel = formatPinetSkinThemeLabel(normalizedTheme);
  const tokens = getPinetSkinTokens(normalizedTheme);
  const primary = pickSkinValue(tokens, options.seed, "primary-token");
  const alternateTokens = tokens.filter((token) => token !== primary);
  const secondary =
    alternateTokens.length > 0
      ? pickSkinValue(alternateTokens, `${options.seed}:${normalizedTheme}`, "secondary-token")
      : primary;
  const modifier = pickSkinValue(PINET_SKIN_MODIFIERS, options.seed, "modifier");
  const title =
    options.role === "broker"
      ? pickSkinValue(PINET_SKIN_LEADER_TITLES, options.seed, "leader-title")
      : pickSkinValue(PINET_SKIN_WORKER_TITLES, options.seed, "worker-title");
  const emoji =
    options.role === "broker"
      ? pickSkinValue(PINET_SKIN_BROKER_EMOJIS, options.seed, "leader-emoji")
      : pickSkinValue(PINET_SKIN_WORKER_EMOJIS, options.seed, "worker-emoji");
  const demeanor = pickSkinValue(
    PINET_SKIN_DEMEANORS,
    `${options.seed}:${normalizedTheme}`,
    "demeanor",
  );
  const voice = resolvePinetSkinVoiceProfile(normalizedTheme);
  const cadence = pickSkinValue(
    voice.cadences,
    `${options.seed}:${normalizedTheme}`,
    "voice-cadence",
  );
  const imagery = pickSkinValue(
    voice.imagery,
    `${options.seed}:${normalizedTheme}`,
    "voice-imagery",
  );
  const diction = pickSkinValue(
    voice.diction,
    `${options.seed}:${normalizedTheme}`,
    "voice-diction",
  );
  const opener = fillPinetSkinTemplate(
    pickSkinValue(
      PINET_SKIN_PERSONALITY_OPENERS,
      `${options.seed}:${normalizedTheme}`,
      "persona-opener",
    ),
    {
      theme: themeLabel,
      cadence,
      demeanor,
    },
  );
  const style = fillPinetSkinTemplate(
    pickSkinValue(
      PINET_SKIN_PERSONALITY_STYLE_TEMPLATES,
      `${options.seed}:${normalizedTheme}:${options.role}`,
      "persona-style",
    ),
    {
      diction,
      imagery,
    },
  );
  const roleFocus = pickSkinValue(PINET_SKIN_ROLE_FOCUS[options.role], options.seed, "role-focus");
  const workerCore = secondary === modifier ? primary : secondary;
  const name =
    options.role === "broker"
      ? generateAgentName(options.seed, "broker").name
      : `${modifier} ${workerCore} ${title}`;

  return {
    theme: normalizedTheme,
    role: options.role,
    name,
    emoji,
    personality: clampPinetSkinText(
      `${opener} ${style} ${roleFocus}`,
      MAX_PINET_SKIN_PERSONALITY_LENGTH,
    ),
  };
}

// ─── Agent identity persistence ─────────────────────────

export function resolveAgentIdentity(
  settings: SlackBridgeSettings,
  envNickname?: string,
  seed?: string,
  role: AgentIdentityRole = "worker",
): { name: string; emoji: string } {
  // 1. Explicit config (both must be present)
  if (settings.agentName && settings.agentEmoji) {
    return { name: settings.agentName, emoji: settings.agentEmoji };
  }

  // 2. PI_NICKNAME env var (name fixed, emoji deterministic when seeded)
  if (envNickname) {
    const generated = generateAgentName(seed, role);
    return { name: envNickname, emoji: generated.emoji };
  }

  // 3. Fully generated
  return generateAgentName(seed, role);
}

export function alignAgentIdentityToRole(
  currentIdentity: { name: string; emoji: string },
  settings: SlackBridgeSettings,
  envNickname?: string,
  seed?: string,
  role: AgentIdentityRole = "worker",
): { name: string; emoji: string } {
  const workerIdentity = resolveAgentIdentity(settings, envNickname, seed, "worker");
  const brokerIdentity = resolveAgentIdentity(settings, envNickname, seed, "broker");
  const targetIdentity = role === "broker" ? brokerIdentity : workerIdentity;

  if (
    (currentIdentity.name === workerIdentity.name &&
      currentIdentity.emoji === workerIdentity.emoji) ||
    (currentIdentity.name === brokerIdentity.name && currentIdentity.emoji === brokerIdentity.emoji)
  ) {
    return targetIdentity;
  }

  return currentIdentity;
}

export function resolveRuntimeAgentIdentity(
  currentIdentity: { name: string; emoji: string },
  settings: SlackBridgeSettings,
  envNickname?: string,
  seed?: string,
  role: AgentIdentityRole = "worker",
): { name: string; emoji: string } {
  if (settings.agentName && settings.agentEmoji) {
    return { name: settings.agentName, emoji: settings.agentEmoji };
  }

  if (envNickname) {
    const generated = generateAgentName(seed, role);
    return { name: envNickname, emoji: generated.emoji };
  }

  return alignAgentIdentityToRole(currentIdentity, settings, undefined, seed, role);
}

// ─── Confirmation state cleanup ─────────────────────────

export interface ConfirmationRequest {
  toolPattern: string;
  action: string;
  requestedAt: number;
}

export interface ThreadConfirmationState {
  pending: ConfirmationRequest[];
  approved: ConfirmationRequest[];
  rejected: ConfirmationRequest[];
}

export interface RegisterThreadConfirmationRequestResult {
  state: ThreadConfirmationState;
  status: "created" | "refreshed" | "conflict";
  conflict?: ConfirmationRequest;
}

export const DEFAULT_CONFIRMATION_REQUEST_TTL_MS = 5 * 60_000;

export function normalizeThreadConfirmationState(
  state: ThreadConfirmationState,
  now = Date.now(),
  ttlMs = DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
): ThreadConfirmationState {
  const keepFresh = (request: ConfirmationRequest) => now - request.requestedAt < ttlMs;
  const pending = state.pending.filter(keepFresh);

  return {
    pending: pending.length > 1 ? [] : pending,
    approved: state.approved.filter(keepFresh),
    rejected: state.rejected.filter(keepFresh),
  };
}

export function isThreadConfirmationStateEmpty(state: ThreadConfirmationState): boolean {
  return state.pending.length === 0 && state.approved.length === 0 && state.rejected.length === 0;
}

export function confirmationRequestMatches(
  request: ConfirmationRequest,
  toolName: string,
  action: string,
): boolean {
  return matchesToolPattern(toolName, [request.toolPattern]) && request.action === action;
}

export function consumeMatchingConfirmationRequest(
  list: ConfirmationRequest[],
  toolName: string,
  action: string,
): ConfirmationRequest | null {
  const idx = list.findIndex((request) => confirmationRequestMatches(request, toolName, action));
  if (idx === -1) return null;
  const [match] = list.splice(idx, 1);
  return match;
}

export function registerThreadConfirmationRequest(
  state: ThreadConfirmationState,
  request: ConfirmationRequest,
  now = Date.now(),
): RegisterThreadConfirmationRequestResult {
  const normalized = normalizeThreadConfirmationState(state, now);
  const nextState: ThreadConfirmationState = {
    pending: normalized.pending,
    approved: normalized.approved.filter(
      (entry) => !confirmationRequestMatches(entry, request.toolPattern, request.action),
    ),
    rejected: normalized.rejected.filter(
      (entry) => !confirmationRequestMatches(entry, request.toolPattern, request.action),
    ),
  };
  const existingPending = nextState.pending[0];

  if (!existingPending) {
    return {
      state: {
        ...nextState,
        pending: [request],
      },
      status: "created",
    };
  }

  if (
    existingPending.toolPattern === request.toolPattern &&
    existingPending.action === request.action
  ) {
    return {
      state: {
        ...nextState,
        pending: [{ ...existingPending, requestedAt: request.requestedAt }],
      },
      status: "refreshed",
    };
  }

  return {
    state: nextState,
    status: "conflict",
    conflict: existingPending,
  };
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

export interface CallSlackAPIOptions {
  signal?: AbortSignal;
  retryCount?: number;
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
  options: CallSlackAPIOptions = {},
): Promise<SlackResult> {
  const { signal, retryCount = 0 } = options;
  const { url, init } = buildSlackRequest(method, token, body);
  const res = await fetch(url, signal ? { ...init, signal } : init);

  if (res.status === 429) {
    const maxRetries = 3;
    if (retryCount >= maxRetries) {
      throw new Error(`Slack ${method}: rate limited after ${maxRetries} retries`);
    }
    const wait = Number(res.headers.get("retry-after") ?? "3");
    if (signal) {
      await abortableDelay(wait * 1000, signal);
    } else {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    }
    return callSlackAPI(method, token, body, { signal, retryCount: retryCount + 1 });
  }

  const data = (await res.json()) as SlackResult;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  return data;
}

// ─── Follower inbox partitioning (#102, #175) ───────────

export function isRalphNudgeEntry(entry: {
  message: { metadata?: Record<string, unknown> | null };
}): boolean {
  return entry.message.metadata?.kind === "ralph_loop_nudge";
}

export function isAgentToAgentEntry(entry: {
  message: { threadId?: string; metadata?: Record<string, unknown> | null };
}): boolean {
  const threadId = entry.message.threadId ?? "";
  return threadId.startsWith("a2a:") || entry.message.metadata?.a2a === true;
}

export function partitionFollowerInboxEntries<
  T extends { message: { threadId?: string; metadata?: Record<string, unknown> | null } },
>(entries: T[]): { nudges: T[]; agentMessages: T[]; regular: T[] } {
  const nudges: T[] = [];
  const agentMessages: T[] = [];
  const regular: T[] = [];
  for (const entry of entries) {
    if (isRalphNudgeEntry(entry)) {
      nudges.push(entry);
    } else if (isAgentToAgentEntry(entry)) {
      agentMessages.push(entry);
    } else {
      regular.push(entry);
    }
  }
  return { nudges, agentMessages, regular };
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
