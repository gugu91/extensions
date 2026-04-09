import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createGitContextCache, probeGitBranch, probeGitContext } from "./git-metadata.js";
import {
  type InboxMessage,
  type AgentDisplayInfo,
  type ConfirmationRequest,
  type ThreadConfirmationState,
  type RalphLoopAgentWorkload,
  type RalphLoopEvaluationResult,
  type RalphLoopEvaluationOptions,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  isUserAllowed as checkUserAllowed,
  formatInboxMessages,
  formatPinetInboxMessages,
  buildPinetSkinAssignment,
  buildPinetSkinMetadata,
  buildPinetSkinPromptGuideline,
  extractPinetControlCommand,
  extractPinetSkinUpdate,
  normalizeOutgoingPinetControlMessage,
  queuePinetRemoteControl,
  finishPinetRemoteControl,
  reloadPinetRuntimeSafely,
  type PinetControlCommand,
  type PinetRemoteControlState,
  formatAgentList,
  stripBotMention,
  isChannelId,
  callSlackAPI,
  createAbortableOperationTracker,
  isAbortError,
  buildAgentDisplayInfo,
  rankAgentsForRouting,
  evaluateRalphLoopCycle,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  partitionFollowerInboxEntries,
  agentOwnsThread,
  buildPinetOwnerToken,
  resolveAgentIdentity,
  resolvePersistedAgentIdentity,
  resolveRuntimeAgentIdentity,
  shortenPath,
  buildIdentityReplyGuidelines,
  buildAgentPersonalityGuidelines,
  buildBrokerPromptGuidelines,
  buildWorkerPromptGuidelines,
  DEFAULT_PINET_SKIN_THEME,
  normalizePinetSkinTheme,
  resolveAgentStableId,
  isLikelyLocalSubagentContext,
  resolvePinetMeshAuth,
  syncFollowerInboxEntries,
  syncBrokerInboxEntries,
  resolveFollowerThreadChannel,
  getFollowerReconnectUiUpdate,
  getFollowerOwnedThreadClaims,
  normalizeThreadConfirmationState,
  normalizeOwnedThreads,
  isThreadConfirmationStateEmpty,
  confirmationRequestMatches,
  consumeMatchingConfirmationRequest,
  registerThreadConfirmationRequest,
  trackBrokerInboundThread,
} from "./helpers.js";
import {
  buildSecurityPrompt,
  isConfirmationApproval,
  isConfirmationRejection,
  isToolBlocked,
  toolNeedsConfirmation,
  isBrokerForbiddenTool,
  buildBrokerToolGuardrailsPrompt,
  type SecurityGuardrails,
} from "./guardrails.js";
import { evaluateSlackOriginCoreToolPolicy } from "./core-tool-guardrails.js";
import {
  consumePendingSlackToolPolicyTurn,
  deliverTrackedSlackFollowUpMessage,
  type PendingSlackToolPolicyTurn,
} from "./slack-turn-guardrails.js";
import { buildSlackInboundMessageText } from "./slack-message-context.js";
import { TtlCache, TtlSet } from "./ttl-cache.js";
import {
  buildReactionPromptGuidelines,
  buildReactionTriggerMessage,
  normalizeReactionName,
  resolveReactionCommands,
} from "./reaction-triggers.js";
import { startBroker, type Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { MessageRouter, extractPiAgentThreadOwnerHint } from "./broker/router.js";
import {
  DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS,
  DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
  runBrokerMaintenancePass,
  type BrokerMaintenanceResult,
} from "./broker/maintenance.js";
import { BrokerClient, DEFAULT_SOCKET_PATH, HEARTBEAT_INTERVAL_MS } from "./broker/client.js";
import {
  dispatchBroadcastAgentMessage,
  dispatchDirectAgentMessage,
  isBroadcastChannelTarget,
} from "./broker/agent-messaging.js";
import { registerSlackTools } from "./slack-tools.js";
import { registerPinetCommands } from "./pinet-commands.js";
import {
  type RalphLoopDeps,
  createRalphLoopState,
  resetRalphLoopState,
  startRalphLoop,
  stopRalphLoop,
} from "./ralph-loop.js";
import {
  extractSlackInteractivePayloadFromEnvelope,
  normalizeSlackBlockActionPayload,
  normalizeSlackViewSubmissionPayload,
} from "./slack-block-kit.js";
import {
  extractSlackSocketDedupKey,
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "./slack-socket-dedup.js";
import {
  createFollowerDeliveryState,
  drainFollowerAckBatches,
  hasDeliveredFollowerInboxIds,
  isFollowerInboxIdTracked,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
  resetFollowerDeliveryState,
} from "./follower-delivery.js";
import {
  extractTaskAssignmentsFromMessage,
  normalizeTrackedTaskAssignments,
  resolveTaskAssignments,
  type ResolvedTaskAssignment,
} from "./task-assignments.js";
import {
  SlackActivityLogger,
  type ActivityLogEntry,
  type ActivityLogTone,
} from "./activity-log.js";
import { resolveScheduledWakeupFireAt } from "./scheduled-wakeups.js";
import {
  createBrokerDeliveryState,
  getBrokerInboxIds,
  isBrokerInboxIdTracked,
  markBrokerInboxIdsHandled,
  queueBrokerInboxIds,
  resetBrokerDeliveryState,
} from "./broker-delivery.js";
import {
  buildBrokerControlPlaneDashboardSnapshot,
  refreshBrokerControlPlaneCanvas,
  renderBrokerControlPlaneCanvasMarkdown,
  type BrokerControlPlaneDashboardSnapshot,
} from "./broker/control-plane-canvas.js";
import {
  publishSlackHomeTab,
  renderBrokerControlPlaneHomeTabView,
  renderStandalonePinetHomeTabView,
} from "./home-tab.js";

// Settings and helpers imported from ./helpers.js

/**
 * Reference to the broker client with polling interval management.
 */
type BrokerClientRef = {
  client: BrokerClient;
  pollInterval: ReturnType<typeof setInterval> | null;
};

type PinetRuntimeControlContext = ExtensionContext & {
  abort?: () => void;
  shutdown?: () => void;
};

export default function (pi: ExtensionAPI) {
  let settings = loadSettingsFromFile();

  let botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
  let appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) return;

  let slackRequests = createAbortableOperationTracker();

  function resetTopLevelSlackRequests(): void {
    slackRequests = createAbortableOperationTracker();
  }

  async function slack(method: string, token: string, body?: Record<string, unknown>) {
    return slackRequests.run((signal) => callSlackAPI(method, token, body, { signal }));
  }

  // allowedUsers: settings.json takes priority, env var as fallback
  let allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);
  let reactionCommands = resolveReactionCommands(settings.reactionCommands);

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(allowedUsers, userId);
  }

  const initialIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, process.cwd());
  let agentName = initialIdentity.name;
  let agentEmoji = initialIdentity.emoji;
  let agentStableId = resolveAgentStableId(undefined, undefined, os.hostname(), process.cwd());
  let agentOwnerToken = buildPinetOwnerToken(agentStableId);
  let activeSkinTheme: string | null = null;
  let agentPersonality: string | null = null;
  const agentAliases = new Set<string>();
  const PINET_SKIN_SETTING_KEY = "pinet.skinTheme";

  // Security guardrails
  let guardrails: SecurityGuardrails = settings.security ?? {};
  let securityPrompt = buildSecurityPrompt(guardrails);

  function normalizeOptionalSetting(value?: string | null): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }

  let brokerControlPlaneCanvasRuntimeId: string | null = null;
  let brokerControlPlaneCanvasRuntimeChannelId: string | null = null;
  let lastBrokerControlPlaneCanvasRefreshAt: string | null = null;
  let lastBrokerControlPlaneCanvasError: string | null = null;
  const brokerControlPlaneHomeTabViewers = new TtlCache<string, { openedAt: string }>({
    maxSize: 100,
    ttlMs: 12 * 60 * 60 * 1000,
  });
  let lastBrokerControlPlaneHomeTabSnapshot: BrokerControlPlaneDashboardSnapshot | null = null;
  let lastBrokerControlPlaneHomeTabRefreshAt: string | null = null;
  let lastBrokerControlPlaneHomeTabError: string | null = null;

  function isBrokerControlPlaneCanvasEnabled(): boolean {
    return settings.controlPlaneCanvasEnabled ?? true;
  }

  function getExplicitBrokerControlPlaneCanvasId(): string | null {
    return normalizeOptionalSetting(settings.controlPlaneCanvasId);
  }

  function getConfiguredBrokerControlPlaneCanvasId(): string | null {
    return getExplicitBrokerControlPlaneCanvasId() ?? brokerControlPlaneCanvasRuntimeId;
  }

  function getConfiguredBrokerControlPlaneCanvasChannel(): string | null {
    return (
      normalizeOptionalSetting(settings.controlPlaneCanvasChannel) ??
      normalizeOptionalSetting(settings.defaultChannel)
    );
  }

  function getConfiguredBrokerControlPlaneCanvasTitle(): string {
    return (
      normalizeOptionalSetting(settings.controlPlaneCanvasTitle) ?? "Pinet Broker Control Plane"
    );
  }

  interface ReloadableRuntimeSnapshot {
    settings: typeof settings;
    botToken: string | undefined;
    appToken: string | undefined;
    allowedUsers: Set<string> | null;
    guardrails: SecurityGuardrails;
    reactionCommands: Map<string, { action: string; prompt: string }>;
    securityPrompt: string;
    agentName: string;
    agentEmoji: string;
    activeSkinTheme: string | null;
    agentPersonality: string | null;
    agentAliases: string[];
  }

  function getSkinSeed(preferredSeed?: string): string {
    return preferredSeed?.trim() || agentStableId;
  }

  function rememberAgentAlias(name: string | undefined): void {
    const trimmed = name?.trim();
    if (!trimmed || trimmed === agentName) return;
    agentAliases.add(trimmed);
    while (agentAliases.size > 24) {
      const oldest = agentAliases.values().next().value;
      if (!oldest) break;
      agentAliases.delete(oldest);
    }
  }

  function resolveSkinAssignment(
    role: "broker" | "worker",
    seed = getSkinSeed(),
  ): { name: string; emoji: string; personality: string } | null {
    if (!activeSkinTheme) return null;
    const assignment = buildPinetSkinAssignment({ theme: activeSkinTheme, role, seed });
    return {
      name: assignment.name,
      emoji: assignment.emoji,
      personality: assignment.personality,
    };
  }

  function applyLocalAgentIdentity(
    nextName: string,
    nextEmoji: string,
    nextPersonality: string | null,
  ): void {
    const previousName = agentName;
    if (
      agentName === nextName &&
      agentEmoji === nextEmoji &&
      (agentPersonality ?? null) === (nextPersonality ?? null)
    ) {
      return;
    }

    agentName = nextName;
    agentEmoji = nextEmoji;
    agentPersonality = nextPersonality ?? null;
    rememberAgentAlias(previousName);
    normalizeOwnedThreads(threads.values(), agentName, agentOwnerToken, agentAliases);
    persistState();
    updateBadge();
  }

  function refreshSettings(): void {
    settings = loadSettingsFromFile();
    botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
    appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;
    allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);
    guardrails = settings.security ?? {};
    reactionCommands = resolveReactionCommands(settings.reactionCommands);
    securityPrompt = buildSecurityPrompt(guardrails);
    const identitySeed = extCtx?.sessionManager.getSessionFile() ?? agentStableId;
    const role = brokerRole === "broker" ? "broker" : "worker";
    const skinIdentity = resolveSkinAssignment(role, identitySeed);
    if (skinIdentity) {
      agentName = skinIdentity.name;
      agentEmoji = skinIdentity.emoji;
      agentPersonality = skinIdentity.personality;
      return;
    }
    const refreshedIdentity = resolveRuntimeAgentIdentity(
      { name: agentName, emoji: agentEmoji },
      settings,
      process.env.PI_NICKNAME,
      identitySeed,
      role,
    );
    agentName = refreshedIdentity.name;
    agentEmoji = refreshedIdentity.emoji;
    agentPersonality = null;
  }

  function snapshotReloadableRuntime(): ReloadableRuntimeSnapshot {
    return {
      settings: structuredClone(settings),
      botToken,
      appToken,
      allowedUsers: allowedUsers ? new Set(allowedUsers) : null,
      guardrails: structuredClone(guardrails),
      reactionCommands: new Map(reactionCommands),
      securityPrompt,
      agentName,
      agentEmoji,
      activeSkinTheme,
      agentPersonality,
      agentAliases: [...agentAliases],
    };
  }

  function restoreReloadableRuntime(snapshot: ReloadableRuntimeSnapshot): void {
    settings = structuredClone(snapshot.settings);
    botToken = snapshot.botToken;
    appToken = snapshot.appToken;
    allowedUsers = snapshot.allowedUsers ? new Set(snapshot.allowedUsers) : null;
    guardrails = structuredClone(snapshot.guardrails);
    reactionCommands = new Map(snapshot.reactionCommands);
    securityPrompt = snapshot.securityPrompt;
    agentName = snapshot.agentName;
    agentEmoji = snapshot.agentEmoji;
    activeSkinTheme = snapshot.activeSkinTheme;
    agentPersonality = snapshot.agentPersonality;
    agentOwnerToken = buildPinetOwnerToken(agentStableId);
    agentAliases.clear();
    for (const alias of snapshot.agentAliases) {
      if (alias && alias !== agentName) {
        agentAliases.add(alias);
      }
    }
  }

  function detectProjectTools(repoRoot: string, cwd: string): string[] {
    const tools = new Set<string>();

    for (const candidate of [path.join(cwd, "package.json"), path.join(repoRoot, "package.json")]) {
      try {
        if (!fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        const scripts = parsed.scripts ?? {};
        if (scripts.test) tools.add("test");
        if (scripts.lint) tools.add("lint");
        if (scripts.typecheck) tools.add("typecheck");
        if (scripts.build) tools.add("build");
      } catch {
        // Ignore unreadable package.json files.
      }
    }

    tools.add("git");
    return [...tools].sort();
  }

  const gitContextCache = createGitContextCache(() => probeGitContext(process.cwd()));

  async function getAgentMetadata(
    role: "broker" | "worker" = "worker",
  ): Promise<Record<string, unknown>> {
    const gitContext = await gitContextCache.get();
    const { cwd, repo, repoRoot, branch } = gitContext;
    const resolvedRepoRoot = repoRoot ?? cwd;
    const tools = detectProjectTools(resolvedRepoRoot, cwd);
    const tags = [
      `role:${role}`,
      `repo:${repo}`,
      ...(branch ? [`branch:${branch}`] : []),
      ...tools.map((tool) => `tool:${tool}`),
    ];

    return {
      cwd,
      branch,
      host: os.hostname(),
      role,
      repo,
      repoRoot,
      ...(activeSkinTheme ? { skinTheme: activeSkinTheme } : {}),
      ...(agentPersonality ? { personality: agentPersonality } : {}),
      capabilities: {
        repo,
        repoRoot,
        branch,
        role,
        tools,
        tags,
      },
    };
  }

  function asStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  function getMeshRoleFromMetadata(
    metadata: Record<string, unknown> | undefined,
    fallback: "broker" | "worker" = "worker",
  ): "broker" | "worker" {
    return asStringValue(metadata?.role) === "broker" ? "broker" : fallback;
  }

  function buildSkinMetadata(
    metadata: Record<string, unknown> | undefined,
    personality: string,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      ...(activeSkinTheme ? { skinTheme: activeSkinTheme } : {}),
      personality,
    };
  }

  const selfLocation = `${shortenPath(process.cwd(), os.homedir())}@${os.hostname()}`;

  function getIdentityGuidelines(): [string, string, string] {
    return buildIdentityReplyGuidelines(agentEmoji, agentName, selfLocation);
  }

  function applyRegistrationIdentity(registration: {
    name: string;
    emoji: string;
    metadata?: Record<string, unknown> | null;
  }): void {
    activeSkinTheme = asStringValue(registration.metadata?.skinTheme) ?? null;
    applyLocalAgentIdentity(
      registration.name,
      registration.emoji,
      asStringValue(registration.metadata?.personality) ?? null,
    );
  }

  interface ThreadInfo {
    channelId: string;
    threadTs: string;
    userId: string;
    context?: { channelId: string; teamId: string };
    owner?: string; // agent name that claimed this thread (first-responder-wins)
  }

  let botUserId: string | null = null;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let shuttingDown = false;

  const threads = new Map<string, ThreadInfo>();
  const thinking = new Set<string>();
  const pendingEyes = new Map<string, { channel: string; messageTs: string }[]>(); // thread_ts → message ts list // thread_ts values showing "is thinking…"
  const userNames = new TtlCache<string, string>({ maxSize: 2000, ttlMs: 60 * 60 * 1000 });
  let lastDmChannel: string | null = null;
  const channelCache = new TtlCache<string, string>({ maxSize: 500, ttlMs: 30 * 60 * 1000 });
  const unclaimedThreads = new TtlSet<string>({ maxSize: 5000, ttlMs: 5 * 60 * 1000 });
  const processedSlackSocketDeliveries = new TtlSet<string>({
    maxSize: SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
    ttlMs: SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  });

  const threadConfirmationStates = new Map<string, ThreadConfirmationState>();

  function storeThreadConfirmationState(
    threadTs: string,
    state: ThreadConfirmationState,
    now = Date.now(),
  ): ThreadConfirmationState | null {
    const normalized = normalizeThreadConfirmationState(
      state,
      now,
      DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
    );

    if (isThreadConfirmationStateEmpty(normalized)) {
      threadConfirmationStates.delete(threadTs);
      return null;
    }

    threadConfirmationStates.set(threadTs, normalized);
    return normalized;
  }

  function sweepThreadConfirmationStates(now = Date.now()): void {
    for (const [threadTs, state] of threadConfirmationStates) {
      storeThreadConfirmationState(threadTs, state, now);
    }
  }

  function getThreadConfirmationState(threadTs: string): ThreadConfirmationState {
    sweepThreadConfirmationStates();

    let state = threadConfirmationStates.get(threadTs);
    if (!state) {
      state = { pending: [], approved: [], rejected: [] };
      threadConfirmationStates.set(threadTs, state);
    }
    return state;
  }

  function cleanupThreadConfirmationState(threadTs: string): void {
    const state = threadConfirmationStates.get(threadTs);
    if (!state) return;
    storeThreadConfirmationState(threadTs, state);
  }

  // ─── State persistence ──────────────────────────────

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  function persistStateNow(): void {
    persistTimer = null;
    try {
      pi.appendEntry("slack-bridge-state", {
        threads: Array.from(threads.entries()),
        lastDmChannel,
        userNames: Array.from(userNames.entries()),
        agentName,
        agentEmoji,
        agentStableId,
        activeSkinTheme,
        agentPersonality,
        agentAliases: [...agentAliases],
        brokerControlPlaneCanvasId: brokerControlPlaneCanvasRuntimeId,
        brokerControlPlaneCanvasChannelId: brokerControlPlaneCanvasRuntimeChannelId,
      });
    } catch (err) {
      console.error(`[slack-bridge] persistState failed: ${msg(err)}`);
    }
  }

  function persistState(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistStateNow, 1_000);
  }

  function flushPersist(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistStateNow();
    }
  }

  // ─── Inbox queue ────────────────────────────────────

  const inbox: InboxMessage[] = [];
  const brokerDeliveryState = createBrokerDeliveryState();
  const AUTO_DRAIN_INTERRUPT_SUPPRESSION_MS = 1_500;
  let suppressAutoDrainUntil = 0;
  let terminalInputUnsubscribe: (() => void) | null = null;
  let extCtx: ExtensionContext | null = null; // cached for badge updates
  let lastActivityLogFailureAt = 0;
  const pendingSlackToolPolicyTurns: PendingSlackToolPolicyTurn[] = [];
  let nextSlackToolPolicyTurn: PendingSlackToolPolicyTurn | null = null;
  let activeSlackToolPolicyTurn: PendingSlackToolPolicyTurn | null = null;

  function updateBadge(): void {
    if (!extCtx?.hasUI) return;
    const t = extCtx.ui.theme;
    const n = inbox.length;
    const label =
      n > 0
        ? t.fg("accent", `${agentEmoji} ${agentName} ✦ ${n}`)
        : t.fg("accent", `${agentEmoji} ${agentName} ✦`);
    extCtx.ui.setStatus("slack-bridge", label);
  }

  function notePotentialInterruptInput(data: string): void {
    if (data !== "\u001b") {
      return;
    }

    suppressAutoDrainUntil = Math.max(
      suppressAutoDrainUntil,
      Date.now() + AUTO_DRAIN_INTERRUPT_SUPPRESSION_MS,
    );
  }

  function shouldSuppressAutomaticInboxDrain(now = Date.now()): boolean {
    if (suppressAutoDrainUntil === 0) {
      return false;
    }
    if (now >= suppressAutoDrainUntil) {
      suppressAutoDrainUntil = 0;
      return false;
    }
    return true;
  }

  function maybeDrainInboxIfIdle(ctx?: ExtensionContext): boolean {
    if (!(ctx?.isIdle?.() ?? false)) {
      return false;
    }
    if (shouldSuppressAutomaticInboxDrain()) {
      return false;
    }
    drainInbox();
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────

  async function addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await slack("reactions.add", botToken!, { channel, timestamp: ts, name: emoji });
    } catch {
      /* already_reacted or non-critical */
    }
  }

  async function removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await slack("reactions.remove", botToken!, { channel, timestamp: ts, name: emoji });
    } catch {
      /* not_reacted or non-critical */
    }
  }

  async function resolveUser(userId: string): Promise<string> {
    const cached = userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await slack("users.info", botToken!, { user: userId });
      if (shuttingDown) return userId;
      const u = res.user as { real_name?: string; name?: string };
      const name = u.real_name ?? u.name ?? userId;
      userNames.set(userId, name);
      persistState();
      return name;
    } catch {
      return userId;
    }
  }

  async function resolveChannel(nameOrId: string): Promise<string> {
    if (isChannelId(nameOrId)) return nameOrId;
    const name = nameOrId.replace(/^#/, "");
    const cached = channelCache.get(name);
    if (cached) return cached;

    let cursor: string | undefined;
    do {
      const body: Record<string, unknown> = {
        types: "public_channel,private_channel",
        limit: 200,
      };
      if (cursor) body.cursor = cursor;
      const res = await slack("conversations.list", botToken!, body);
      const channels = res.channels as { id: string; name: string }[];
      for (const ch of channels) {
        channelCache.set(ch.name, ch.id);
      }
      if (channelCache.has(name)) return channelCache.get(name)!;
      cursor = (res.response_metadata as { next_cursor?: string })?.next_cursor || undefined;
    } while (cursor);

    throw new Error(`Channel "${name}" not found.`);
  }

  const activityLogger = new SlackActivityLogger({
    getBotToken: () => botToken,
    getLogChannel: () => settings.logChannel,
    getLogLevel: () => settings.logLevel,
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    resolveChannel,
    slack,
    onError: (error) => {
      console.error(`[slack-bridge] activity log failed: ${msg(error)}`);
      const now = Date.now();
      if (!extCtx?.hasUI || now - lastActivityLogFailureAt < 60_000) {
        return;
      }
      lastActivityLogFailureAt = now;
      extCtx.ui.notify(`Pinet activity log failed: ${msg(error)}`, "warning");
    },
  });

  function logBrokerActivity(entry: ActivityLogEntry): void {
    if (!settings.logChannel) {
      return;
    }
    if (brokerRole !== "broker" && activeBroker == null) {
      return;
    }
    activityLogger.log(entry);
  }

  function formatTrackedAgent(agentId: string): string {
    const agent = activeBroker?.db.getAgentById(agentId);
    if (!agent) {
      return agentId;
    }
    return `${agent.emoji} ${agent.name}`.trim();
  }

  function summarizeTrackedAssignmentStatus(
    status: "assigned" | "branch_pushed" | "pr_open" | "pr_merged" | "pr_closed",
    prNumber: number | null,
    branch: string | null,
  ): { summary: string; tone: ActivityLogTone } {
    switch (status) {
      case "pr_merged":
        return {
          summary: `PR #${prNumber ?? "?"} merged`,
          tone: "success",
        };
      case "pr_open":
        return {
          summary: `PR #${prNumber ?? "?"} opened for review`,
          tone: "success",
        };
      case "pr_closed":
        return {
          summary: `PR #${prNumber ?? "?"} closed without merge`,
          tone: "warning",
        };
      case "branch_pushed":
        return {
          summary: `commits pushed on ${branch ?? "tracked branch"}`,
          tone: "info",
        };
      case "assigned":
      default:
        return {
          summary: "assigned",
          tone: "info",
        };
    }
  }

  async function resolveFollowerReplyChannel(threadTs: string | undefined): Promise<string | null> {
    if (!threadTs) return null;

    const existingThread = threads.get(threadTs);
    const brokerRef = brokerRole === "broker" ? activeBroker : null;
    const followerClient = brokerRole === "follower" ? brokerClient?.client : null;
    const resolveThread = brokerRef
      ? async (nextThreadTs: string) => brokerRef.db.getThread(nextThreadTs)?.channel ?? null
      : followerClient
        ? (nextThreadTs: string) => followerClient.resolveThread(nextThreadTs)
        : undefined;
    const resolved = await resolveFollowerThreadChannel(threadTs, existingThread, resolveThread);

    if (resolved.threadUpdate && resolved.changed) {
      threads.set(threadTs, {
        ...(existingThread ?? {}),
        ...resolved.threadUpdate,
      });
      persistState();
    }

    return resolved.channelId;
  }

  async function clearThreadStatus(channelId: string, threadTs: string): Promise<void> {
    try {
      await slack("assistant.threads.setStatus", botToken!, {
        channel_id: channelId,
        thread_ts: threadTs,
        status: "",
      });
    } catch {
      /* non-critical */
    }
  }

  async function setSuggestedPrompts(channelId: string, threadTs: string): Promise<void> {
    const prompts = settings.suggestedPrompts ?? [
      { title: "Status", message: `Hey ${agentName}, what are you working on right now?` },
      { title: "Help", message: `${agentName}, I need help with something in the codebase` },
      { title: "Review", message: `${agentName}, summarise the recent changes` },
    ];
    try {
      await slack("assistant.threads.setSuggestedPrompts", botToken!, {
        channel_id: channelId,
        thread_ts: threadTs,
        prompts,
      });
    } catch {
      /* non-critical */
    }
  }

  function formatConfirmationAction(action: string): string {
    return JSON.stringify(action);
  }

  function registerConfirmationRequest(
    threadTs: string,
    tool: string,
    action: string,
  ): { status: "created" | "refreshed" | "conflict"; conflict?: ConfirmationRequest } {
    const now = Date.now();
    const result = registerThreadConfirmationRequest(
      getThreadConfirmationState(threadTs),
      {
        toolPattern: tool,
        action,
        requestedAt: now,
      },
      now,
    );
    storeThreadConfirmationState(threadTs, result.state, now);
    return {
      status: result.status,
      conflict: result.conflict,
    };
  }

  function consumeConfirmationReply(threadTs: string, text: string): { approved: boolean } | null {
    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    if (!state || state.pending.length === 0) return null;

    const trimmed = text.trim();
    const isApproval = isConfirmationApproval(trimmed);
    const isRejection = isConfirmationRejection(trimmed);
    if (!isApproval && !isRejection) return null;

    const request = state.pending.shift();
    if (!request) return null;

    if (isApproval) {
      state.approved.push(request);
      cleanupThreadConfirmationState(threadTs);
      return { approved: true };
    }

    state.rejected.push(request);
    cleanupThreadConfirmationState(threadTs);
    return { approved: false };
  }

  function getConfirmationDecision(
    threadTs: string,
    toolName: string,
    action: string,
  ): boolean | null {
    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    if (!state) return null;

    const approved = consumeMatchingConfirmationRequest(state.approved, toolName, action);
    if (approved) {
      cleanupThreadConfirmationState(threadTs);
      return true;
    }

    const rejected = consumeMatchingConfirmationRequest(state.rejected, toolName, action);
    if (rejected) {
      cleanupThreadConfirmationState(threadTs);
      return false;
    }

    return null;
  }

  function requireToolPolicy(toolName: string, threadTs: string | undefined, action: string): void {
    if (isToolBlocked(toolName, guardrails)) {
      throw new Error(`Tool "${toolName}" is blocked by Slack security guardrails.`);
    }

    if (!toolNeedsConfirmation(toolName, guardrails)) {
      return;
    }

    const quotedAction = formatConfirmationAction(action);
    if (!threadTs) {
      throw new Error(
        `Tool "${toolName}" requires confirmation for action ${quotedAction}. Include a thread_ts and call slack_confirm_action before executing this tool.`,
      );
    }

    const decision = getConfirmationDecision(threadTs, toolName, action);
    if (decision === true) return;
    if (decision === false) {
      throw new Error(
        `Tool "${toolName}" was denied by Slack user confirmation for action ${quotedAction}.`,
      );
    }

    sweepThreadConfirmationStates();
    const state = threadConfirmationStates.get(threadTs);
    const pendingMatch =
      state?.pending.find((request) => confirmationRequestMatches(request, toolName, action)) ??
      null;
    if (pendingMatch) {
      throw new Error(
        `Tool "${toolName}" requires confirmation for action ${quotedAction}. A matching confirmation request is already pending in thread ${threadTs}; wait for the user's approval first.`,
      );
    }

    const pendingConflict = state?.pending[0];
    if (pendingConflict) {
      throw new Error(
        `Thread ${threadTs} already has a pending confirmation for tool "${pendingConflict.toolPattern}" and action ${formatConfirmationAction(pendingConflict.action)}. Wait for a reply or expiry before requesting another action in the same thread.`,
      );
    }

    throw new Error(
      `Tool "${toolName}" requires confirmation for action ${quotedAction}. Call slack_confirm_action in thread ${threadTs} with tool "${toolName}" and action ${quotedAction}, then wait for the user's approval first.`,
    );
  }

  // ─── Thread ownership ────────────────────────────────
  //
  // Follows a "first responder wins" model. When an agent sends its
  // first reply to a thread via slack_send, it embeds its identity in
  // Slack message metadata, claiming the thread. Before queuing an
  // incoming message, we call conversations.replies to look for bot
  // messages with agent metadata. If another agent has already replied,
  // we skip the message.
  //
  // Race condition: there is a small window between the ownership check
  // and the actual reply where two agents could both see zero bot
  // replies and both decide to respond. The first reply to land
  // effectively claims the thread; the losing agent backs off on the
  // next incoming message once it sees the winner's metadata.

  async function resolveThreadOwner(channel: string, threadTs: string): Promise<string | null> {
    try {
      const res = await slack("conversations.replies", botToken!, {
        channel,
        ts: threadTs,
        limit: 50,
        include_all_metadata: true,
      });
      const msgs = (res.messages as Record<string, unknown>[]) ?? [];
      for (const m of msgs) {
        if (!m.bot_id) continue;
        const meta = m.metadata as
          | {
              event_type?: string;
              event_payload?: { agent?: string; agent_owner?: string };
            }
          | undefined;
        if (meta?.event_type !== "pi_agent_msg") continue;
        if (typeof meta.event_payload?.agent_owner === "string" && meta.event_payload.agent_owner) {
          return meta.event_payload.agent_owner;
        }
        if (meta.event_payload?.agent) {
          return meta.event_payload.agent;
        }
      }
    } catch {
      // If we can't check, allow the message through rather than blocking
    }
    return null;
  }

  // ─── Socket Mode (native WebSocket) ─────────────────

  async function connectSocketMode(ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    try {
      const res = await slack("apps.connections.open", appToken!);
      ws = new WebSocket(res.url as string);

      ws.addEventListener("open", () => setExtStatus(ctx, "ok"));

      ws.addEventListener("message", (event) => {
        void handleFrame(String(event.data), ctx);
      });

      ws.addEventListener("close", () => {
        if (!shuttingDown) scheduleReconnect(ctx);
      });

      ws.addEventListener("error", () => {
        /* close fires after */
      });
    } catch (err) {
      if (!isAbortError(err)) {
        console.error(`[slack-bridge] Socket Mode: ${msg(err)}`);
      }
      scheduleReconnect(ctx);
    }
  }

  async function handleFrame(raw: string, ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    let dedupKey: string | null = null;

    try {
      const data = JSON.parse(raw) as Record<string, unknown>;

      // ack every envelope
      if (data.envelope_id) {
        ws?.send(JSON.stringify({ envelope_id: data.envelope_id }));
      }

      dedupKey = extractSlackSocketDedupKey(data);
      if (dedupKey) {
        if (processedSlackSocketDeliveries.has(dedupKey)) {
          return;
        }
        processedSlackSocketDeliveries.add(dedupKey);
      }

      if (data.type === "disconnect") {
        scheduleReconnect(ctx);
        return;
      }

      const interactivePayload = extractSlackInteractivePayloadFromEnvelope(data);
      if (interactivePayload) {
        if (interactivePayload.type === "block_actions") {
          await onBlockActions(interactivePayload, ctx);
        } else if (interactivePayload.type === "view_submission") {
          await onViewSubmission(interactivePayload, ctx);
        }
        return;
      }

      if (data.type !== "events_api") return;

      const evt = (data.payload as { event: Record<string, unknown> }).event;

      switch (evt.type) {
        case "assistant_thread_started":
          await onThreadStarted(evt);
          break;
        case "assistant_thread_context_changed":
          onContextChanged(evt);
          break;
        case "app_home_opened":
          await onAppHomeOpened(evt, ctx);
          break;
        case "message":
          if (!evt.subtype && !evt.bot_id) await onMessage(evt, ctx);
          break;
        case "reaction_added":
          await onReactionAdded(evt, ctx);
          break;
        case "member_joined_channel":
          if ((evt.user as string) === botUserId) {
            const ch = evt.channel as string;
            ctx.ui.notify(`Pinet added to channel ${ch}`, "info");
            inbox.push({
              channel: ch,
              threadTs: "",
              userId: "system",
              text: `Pinet was added to channel <#${ch}>. You can now post messages there.`,
              timestamp: String(Date.now() / 1000),
            });
            updateBadge();
            maybeDrainInboxIfIdle(ctx);
          }
          break;
      }
    } catch {
      if (dedupKey) {
        processedSlackSocketDeliveries.delete(dedupKey);
      }
      /* malformed frame */
    }
  }

  // ─── Assistant events ───────────────────────────────

  async function onThreadStarted(evt: Record<string, unknown>): Promise<void> {
    if (shuttingDown) return;

    const t = evt.assistant_thread as Record<string, unknown>;
    if (!t) return;

    const info: ThreadInfo = {
      channelId: t.channel_id as string,
      threadTs: t.thread_ts as string,
      userId: t.user_id as string,
    };

    const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
    if (ctx?.channel_id) {
      info.context = { channelId: ctx.channel_id, teamId: ctx.team_id ?? "" };
    }

    threads.set(info.threadTs, info);
    lastDmChannel = info.channelId;
    persistState();

    await setSuggestedPrompts(info.channelId, info.threadTs);
  }

  function onContextChanged(evt: Record<string, unknown>): void {
    if (shuttingDown) return;

    const t = evt.assistant_thread as Record<string, unknown>;
    if (!t) return;

    const existing = threads.get(t.thread_ts as string);
    if (!existing) return;

    const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
    if (ctx?.channel_id) {
      existing.context = { channelId: ctx.channel_id, teamId: ctx.team_id ?? "" };
      persistState();
    }
  }

  async function onAppHomeOpened(
    evt: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (shuttingDown) return;

    const userId = typeof evt.user === "string" && evt.user.length > 0 ? evt.user : null;
    const tab = typeof evt.tab === "string" && evt.tab.length > 0 ? evt.tab : "home";
    if (!userId || tab !== "home") {
      return;
    }

    await publishCurrentPinetHomeTabSafely(userId, ctx);
  }

  async function fetchSlackMessageByTs(
    channel: string,
    messageTs: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await slack("conversations.history", botToken!, {
        channel,
        oldest: messageTs,
        latest: messageTs,
        inclusive: true,
        limit: 1,
      });
      const messages = (response.messages as Record<string, unknown>[]) ?? [];
      return messages.find((message) => message.ts === messageTs) ?? messages[0] ?? null;
    } catch {
      return null;
    }
  }

  async function onReactionAdded(
    evt: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (shuttingDown) return;

    const item = evt.item as { type?: string; channel?: string; ts?: string } | undefined;
    const user = evt.user as string | undefined;
    const rawReactionName = evt.reaction as string | undefined;
    if (
      !item ||
      item.type !== "message" ||
      !item.channel ||
      !item.ts ||
      !user ||
      !rawReactionName
    ) {
      return;
    }

    if (user === botUserId) {
      return;
    }

    let reactionName: string;
    try {
      reactionName = normalizeReactionName(rawReactionName);
    } catch {
      return;
    }

    const command = reactionCommands.get(reactionName);
    if (!command || !isUserAllowed(user)) {
      return;
    }

    try {
      const reactedMessage = await fetchSlackMessageByTs(item.channel, item.ts);
      if (!reactedMessage) {
        throw new Error(`Unable to fetch reacted message ${item.ts} in channel ${item.channel}`);
      }

      const threadTs =
        (reactedMessage.thread_ts as string | undefined) ??
        (reactedMessage.ts as string | undefined) ??
        item.ts;

      if (!threads.has(threadTs)) {
        threads.set(threadTs, {
          channelId: item.channel,
          threadTs,
          userId: (reactedMessage.user as string | undefined) ?? user,
        });
      }

      const localOwner = threads.get(threadTs)?.owner;
      if (localOwner && !agentOwnsThread(localOwner, agentName, agentAliases, agentOwnerToken)) {
        return;
      }
      if (localOwner) {
        const thread = threads.get(threadTs);
        if (thread) {
          normalizeOwnedThreads([thread], agentName, agentOwnerToken, agentAliases);
        }
      }

      if (!localOwner && !unclaimedThreads.has(threadTs)) {
        const remoteOwner = await resolveThreadOwner(item.channel, threadTs);
        if (shuttingDown) return;
        if (
          remoteOwner &&
          !agentOwnsThread(remoteOwner, agentName, agentAliases, agentOwnerToken)
        ) {
          const thread = threads.get(threadTs);
          if (thread) thread.owner = remoteOwner;
          return;
        }
        if (agentOwnsThread(remoteOwner ?? undefined, agentName, agentAliases, agentOwnerToken)) {
          const thread = threads.get(threadTs);
          if (thread) thread.owner = agentOwnerToken;
        }
        if (!remoteOwner) {
          unclaimedThreads.add(threadTs);
        }
      }

      const reactorName = await resolveUser(user);
      if (shuttingDown) return;
      const reactedMessageAuthorId =
        (reactedMessage.user as string | undefined) ?? (evt.item_user as string | undefined);
      const reactedMessageAuthor = reactedMessageAuthorId
        ? await resolveUser(reactedMessageAuthorId)
        : (reactedMessage.bot_id as string | undefined)
          ? "bot"
          : "unknown";
      if (shuttingDown) return;

      const reactedMessageText =
        typeof reactedMessage.text === "string" && reactedMessage.text.trim().length > 0
          ? reactedMessage.text
          : "(no text)";
      const reactionMessage = buildReactionTriggerMessage({
        reactionName,
        command,
        reactorName,
        channel: item.channel,
        threadTs,
        messageTs: item.ts,
        reactedMessageText,
        reactedMessageAuthor,
      });

      ctx.ui.notify(`${reactorName} reacted with :${reactionName}:`, "info");
      inbox.push({
        channel: item.channel,
        threadTs,
        userId: user,
        text: reactionMessage,
        timestamp: (evt.event_ts as string) ?? item.ts,
      });
      persistState();
      updateBadge();
      await addReaction(item.channel, item.ts, "white_check_mark");

      maybeDrainInboxIfIdle(ctx);
    } catch (err) {
      console.error(`[slack-bridge] reaction trigger failed: ${msg(err)}`);
      await addReaction(item.channel, item.ts, "x");
    }
  }

  async function onMessage(evt: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    const text = (evt.text as string) ?? "";
    const user = evt.user as string;
    const threadTs = evt.thread_ts as string | undefined;
    const channel = evt.channel as string;
    const channelType = evt.channel_type as string | undefined;

    const isTracked = !!threadTs && threads.has(threadTs);
    const isDM = channelType === "im";
    const isMention = botUserId != null && text.includes(`<@${botUserId}>`);

    if (!isTracked && !isDM && !isMention) return;

    const effectiveTs = threadTs ?? (evt.ts as string);

    // track if new (needed for ownership check below)
    if (!threads.has(effectiveTs)) {
      threads.set(effectiveTs, { channelId: channel, threadTs: effectiveTs, userId: user });
    }

    // ── Thread ownership check (before allowlist so only the owning agent rejects) ──
    const localOwner = threads.get(effectiveTs)?.owner;
    if (localOwner && !agentOwnsThread(localOwner, agentName, agentAliases, agentOwnerToken)) {
      return;
    }
    if (localOwner) {
      const thread = threads.get(effectiveTs);
      if (thread) {
        normalizeOwnedThreads([thread], agentName, agentOwnerToken, agentAliases);
      }
    }

    if (!localOwner && !unclaimedThreads.has(effectiveTs)) {
      const remoteOwner = await resolveThreadOwner(channel, effectiveTs);
      if (shuttingDown) return;
      if (remoteOwner && !agentOwnsThread(remoteOwner, agentName, agentAliases, agentOwnerToken)) {
        const t = threads.get(effectiveTs);
        if (t) t.owner = remoteOwner; // cache so we skip instantly next time
        return;
      }
      if (agentOwnsThread(remoteOwner ?? undefined, agentName, agentAliases, agentOwnerToken)) {
        const t = threads.get(effectiveTs);
        if (t) t.owner = agentOwnerToken;
      }
      if (!remoteOwner) {
        unclaimedThreads.add(effectiveTs); // negative cache: no owner found yet
      }
    }

    // ── User allowlist check ──
    if (!isUserAllowed(user)) {
      await slack("chat.postMessage", botToken!, {
        channel,
        thread_ts: effectiveTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    if (isDM) lastDmChannel = channel;
    persistState();

    // Determine if this is a new channel mention (not DM, not already tracked)
    const isChannelMention = isMention && !isDM && !isTracked;

    // Strip <@BOT_ID> from text for channel mentions
    const cleanText = isChannelMention ? stripBotMention(text, botUserId!) : text;
    const enrichedText = buildSlackInboundMessageText(cleanText, evt);
    const confirmationResult = consumeConfirmationReply(effectiveTs, cleanText);
    const messageText =
      confirmationResult === null
        ? enrichedText
        : confirmationResult.approved
          ? `${enrichedText}\n\n✅ User approved security confirmation request in this thread.`
          : `${enrichedText}\n\n❌ User denied security confirmation request in this thread.`;

    const name = await resolveUser(user);
    if (shuttingDown) return;
    ctx.ui.notify(`${name}: ${cleanText.slice(0, 100)}`, "info");

    // React with 👀 to acknowledge (no chat lock)
    const messageTs = (evt.ts as string) ?? effectiveTs;
    void addReaction(channel, messageTs, "eyes");
    const pending = pendingEyes.get(effectiveTs) ?? [];
    pending.push({ channel, messageTs });
    pendingEyes.set(effectiveTs, pending);

    // Queue in inbox
    inbox.push({
      channel,
      threadTs: effectiveTs,
      userId: user,
      text: messageText,
      timestamp: (evt.ts as string) ?? effectiveTs,
      ...(isChannelMention && { isChannelMention: true }),
    });
    updateBadge();

    // If agent is idle, trigger immediately — otherwise agent_end drains it
    maybeDrainInboxIfIdle(ctx);
  }

  async function queueInteractiveInboxEvent(
    normalized: {
      channel: string;
      threadTs: string;
      userId: string;
      text: string;
      timestamp: string;
      metadata: Record<string, unknown>;
    },
    ctx: ExtensionContext,
  ): Promise<void> {
    if (!threads.has(normalized.threadTs)) {
      threads.set(normalized.threadTs, {
        channelId: normalized.channel,
        threadTs: normalized.threadTs,
        userId: normalized.userId,
      });
    }

    const localOwner = threads.get(normalized.threadTs)?.owner;
    if (localOwner && !agentOwnsThread(localOwner, agentName, agentAliases, agentOwnerToken)) {
      return;
    }
    if (localOwner) {
      const thread = threads.get(normalized.threadTs);
      if (thread) {
        normalizeOwnedThreads([thread], agentName, agentOwnerToken, agentAliases);
      }
    }

    if (!localOwner && !unclaimedThreads.has(normalized.threadTs)) {
      const remoteOwner = await resolveThreadOwner(normalized.channel, normalized.threadTs);
      if (shuttingDown) return;
      if (remoteOwner && !agentOwnsThread(remoteOwner, agentName, agentAliases, agentOwnerToken)) {
        const thread = threads.get(normalized.threadTs);
        if (thread) thread.owner = remoteOwner;
        return;
      }
      if (agentOwnsThread(remoteOwner ?? undefined, agentName, agentAliases, agentOwnerToken)) {
        const thread = threads.get(normalized.threadTs);
        if (thread) thread.owner = agentOwnerToken;
      }
      if (!remoteOwner) {
        unclaimedThreads.add(normalized.threadTs);
      }
    }

    if (!isUserAllowed(normalized.userId)) {
      await slack("chat.postMessage", botToken!, {
        channel: normalized.channel,
        thread_ts: normalized.threadTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    if (normalized.channel.startsWith("D")) {
      lastDmChannel = normalized.channel;
    }
    persistState();

    const name = await resolveUser(normalized.userId);
    if (shuttingDown) return;
    ctx.ui.notify(`${name}: ${normalized.text.slice(0, 100)}`, "info");

    inbox.push({
      channel: normalized.channel,
      threadTs: normalized.threadTs,
      userId: normalized.userId,
      text: normalized.text,
      timestamp: normalized.timestamp,
      metadata: normalized.metadata,
    });
    updateBadge();

    maybeDrainInboxIfIdle(ctx);
  }

  async function onBlockActions(
    payload: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (shuttingDown) return;

    const normalized = normalizeSlackBlockActionPayload(payload);
    if (!normalized) return;
    await queueInteractiveInboxEvent(normalized, ctx);
  }

  async function onViewSubmission(
    payload: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (shuttingDown) return;

    const normalized = normalizeSlackViewSubmissionPayload(payload);
    if (!normalized) return;
    await queueInteractiveInboxEvent(normalized, ctx);
  }

  // ─── Reconnect / status ─────────────────────────────

  function scheduleReconnect(ctx: ExtensionContext): void {
    if (shuttingDown || reconnectTimer) return;
    setExtStatus(ctx, "reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectSocketMode(ctx);
    }, 5000);
  }

  async function disconnect(): Promise<void> {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    await slackRequests.abortAndWait();
  }

  function setExtStatus(
    ctx: ExtensionContext,
    state: "ok" | "reconnecting" | "error" | "off",
  ): void {
    if (!ctx.hasUI) return;
    extCtx = ctx;
    const t = ctx.ui.theme;
    if (state === "ok") {
      // delegate to updateBadge so unread count is shown
      updateBadge();
      return;
    }
    const text =
      state === "reconnecting"
        ? t.fg("warning", `${agentEmoji} ${agentName} ⟳`)
        : state === "error"
          ? t.fg("error", `${agentEmoji} ${agentName} ✗`)
          : "";
    ctx.ui.setStatus("slack-bridge", text);
  }

  // ─── Tools ──────────────────────────────────────────

  registerSlackTools(pi, {
    getBotToken: () => {
      if (!botToken) {
        throw new Error("Slack bot token is not configured.");
      }
      return botToken;
    },
    getDefaultChannel: () => settings.defaultChannel,
    getSecurityPrompt: () => securityPrompt,
    inbox,
    slack,
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    getAgentOwnerToken: () => agentOwnerToken,
    getLastDmChannel: () => lastDmChannel,
    updateBadge,
    resolveUser,
    resolveFollowerReplyChannel,
    resolveChannel,
    rememberChannel: (name, channelId) => {
      channelCache.set(name, channelId);
    },
    requireToolPolicy,
    trackOutboundThread: (threadTs, channelId) => {
      if (!threads.has(threadTs)) {
        threads.set(threadTs, {
          channelId,
          threadTs,
          userId: "",
          owner: agentOwnerToken,
        });
      } else {
        const thread = threads.get(threadTs)!;
        if (!thread.owner) thread.owner = agentOwnerToken;
      }
      unclaimedThreads.delete(threadTs);
      persistState();
    },
    getBotUserId: () => botUserId,
    claimThreadOwnership: (threadTs, channelId) => {
      if (brokerRole === "broker" && activeRouter && activeSelfId) {
        activeRouter.claimThread(threadTs, activeSelfId);
      } else if (brokerRole === "follower" && brokerClient?.client) {
        void brokerClient.client.claimThread(threadTs, channelId).catch(() => {
          /* broker gone, best effort */
        });
      }
    },
    clearPendingEyes: (threadTs) => {
      const pending = pendingEyes.get(threadTs);
      if (!pending) return;
      for (const entry of pending) {
        void removeReaction(entry.channel, entry.messageTs, "eyes");
      }
      pendingEyes.delete(threadTs);
    },
    registerConfirmationRequest,
  });

  // ─── Agent-to-agent messaging tools ──────────────────

  // These are registered unconditionally but only work when pinet is active.
  // The variables they reference (pinetEnabled, brokerRole, activeBroker,
  // brokerClient) are declared in the Commands section just below.

  // Forward-declared — assigned in the Commands section below.
  let pinetEnabled = false;
  let brokerRole: "broker" | "follower" | null = null;
  let pinetRegistrationBlocked = false;
  let activeBroker: Broker | null = null;
  let brokerClient: BrokerClientRef | null = null;
  const followerDeliveryState = createFollowerDeliveryState();
  let followerAckPromise: Promise<void> | null = null;
  let activeRouter: MessageRouter | null = null;
  let activeSelfId: string | null = null;
  let brokerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const ralphLoopState = createRalphLoopState();
  let brokerScheduledWakeupTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceRunning = false;
  let brokerScheduledWakeupRunning = false;
  let lastBrokerMaintenance: BrokerMaintenanceResult | null = null;
  let lastBrokerMaintenanceSignature = "";

  function getPinetRegistrationBlockReason(): string {
    return "Pinet is disabled in local subagent sessions to avoid polluting the agent mesh.";
  }

  function syncBrokerDbInbox(agentId: string, db: BrokerDB, ctx: ExtensionContext): void {
    // Broker-targeted messages can fall back into pending backlog outside startup
    // recovery (for example during disconnect/requeue paths). Rebind them before
    // mirroring the durable inbox into memory so fresh zero-attempt residue does
    // not wait for a separate maintenance rebound.
    db.recoverPendingTargetedBacklog(agentId);

    const pending = db
      .getInbox(agentId)
      .filter((item) => !isBrokerInboxIdTracked(brokerDeliveryState, item.entry.id));
    if (pending.length === 0) {
      return;
    }

    const synced = syncBrokerInboxEntries(
      pending.map((item) => ({
        inboxId: item.entry.id,
        message: {
          threadId: item.message.threadId,
          sender:
            typeof item.message.metadata?.senderAgent === "string"
              ? item.message.metadata.senderAgent
              : item.message.sender,
          body: item.message.body,
          createdAt: item.message.createdAt,
          metadata: item.message.metadata,
        },
      })),
    );

    const handledInboxIds = new Set<number>();
    const commandsToStart: PinetControlCommand[] = [];
    for (const entry of synced.controlEntries) {
      try {
        const queued = requestRemoteControl(entry.command, ctx);
        if (queued.ackDisposition === "immediate") {
          handledInboxIds.add(entry.inboxId);
        } else {
          deferBrokerControlAck(queued.scheduledCommand, entry.inboxId);
        }
        if (queued.shouldStartNow) {
          commandsToStart.push(entry.command);
        }
      } catch (err) {
        ctx.ui.notify(`Pinet remote control failed: ${msg(err)}`, "error");
      }
    }

    for (const entry of synced.skinEntries) {
      activeSkinTheme = entry.update.theme;
      applyLocalAgentIdentity(entry.update.name, entry.update.emoji, entry.update.personality);
      handledInboxIds.add(entry.inboxId);
    }

    if (handledInboxIds.size > 0) {
      db.markDelivered([...handledInboxIds], agentId);
    }

    for (const command of commandsToStart) {
      runRemoteControl(command, ctx);
    }

    if (synced.inboxMessages.length === 0) {
      return;
    }

    queueBrokerInboxIds(
      brokerDeliveryState,
      synced.inboxMessages.flatMap((message) =>
        message.brokerInboxId != null ? [message.brokerInboxId] : [],
      ),
    );

    inbox.push(...synced.inboxMessages);

    updateBadge();
    maybeDrainInboxIfIdle(ctx);
  }

  function startBrokerHeartbeat(): void {
    stopBrokerHeartbeat();
    if (!activeBroker || !activeSelfId) return;
    const broker = activeBroker;
    const selfId = activeSelfId;
    brokerHeartbeatTimer = setInterval(() => {
      try {
        broker.db.heartbeatAgent(selfId);
      } catch {
        /* best effort */
      }
    }, HEARTBEAT_INTERVAL_MS);
    brokerHeartbeatTimer.unref?.();
  }

  function stopBrokerHeartbeat(): void {
    if (!brokerHeartbeatTimer) return;
    clearInterval(brokerHeartbeatTimer);
    brokerHeartbeatTimer = null;
  }

  function runBrokerMaintenance(ctx: ExtensionContext): void {
    if (!activeBroker || !activeSelfId || brokerMaintenanceRunning) return;

    brokerMaintenanceRunning = true;
    try {
      const result = runBrokerMaintenancePass(activeBroker.db, {
        brokerAgentId: activeSelfId,
        staleAfterMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        busyAssignmentAgeMs: DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
      });
      syncBrokerDbInbox(activeSelfId, activeBroker.db as BrokerDB, ctx);
      lastBrokerMaintenance = result;

      const signature = result.anomalies.join("|");
      const previousSignature = lastBrokerMaintenanceSignature;
      if (signature && signature !== previousSignature) {
        ctx.ui.notify(`Pinet broker: ${result.anomalies.join("; ")}`, "warning");
      } else if (!signature && previousSignature) {
        ctx.ui.notify("Pinet broker health recovered", "info");
      }

      const maintenanceDetails: string[] = [];
      if (result.assignedBacklogCount > 0) {
        maintenanceDetails.push(
          `assigned ${result.assignedBacklogCount} backlog item${result.assignedBacklogCount === 1 ? "" : "s"}`,
        );
      }
      if (result.reapedAgentIds.length > 0) {
        maintenanceDetails.push(
          `reaped stale agents: ${result.reapedAgentIds.map((agentId) => formatTrackedAgent(agentId)).join(", ")}`,
        );
      }
      if (result.repairedThreadClaims > 0) {
        maintenanceDetails.push(
          `released ${result.repairedThreadClaims} orphaned thread claim${result.repairedThreadClaims === 1 ? "" : "s"}`,
        );
      }
      maintenanceDetails.push(...result.anomalies);

      const hasMaintenanceActions =
        result.assignedBacklogCount > 0 ||
        result.reapedAgentIds.length > 0 ||
        result.repairedThreadClaims > 0;
      const shouldLogMaintenance = hasMaintenanceActions || previousSignature !== signature;
      if (shouldLogMaintenance) {
        logBrokerActivity({
          kind: "broker_maintenance",
          level: hasMaintenanceActions ? "actions" : "verbose",
          title: signature ? "Broker maintenance anomaly" : "Broker maintenance recovery",
          summary: signature
            ? `Broker maintenance recorded ${maintenanceDetails.length} noteworthy event${maintenanceDetails.length === 1 ? "" : "s"}.`
            : "Broker maintenance is healthy again.",
          details:
            signature && maintenanceDetails.length > 0
              ? maintenanceDetails
              : previousSignature
                ? ["Previous anomalies cleared."]
                : undefined,
          fields: [
            { label: "Backlog", value: result.pendingBacklogCount },
            { label: "Assigned", value: result.assignedBacklogCount },
            { label: "Reaped", value: result.reapedAgentIds.length },
            { label: "Repaired", value: result.repairedThreadClaims },
          ],
          tone: signature ? "warning" : "success",
        });
      }

      lastBrokerMaintenanceSignature = signature;
    } catch (err) {
      ctx.ui.notify(`Pinet maintenance failed: ${msg(err)}`, "error");
      logBrokerActivity({
        kind: "broker_maintenance_error",
        level: "errors",
        title: "Broker maintenance failed",
        summary: msg(err),
        tone: "error",
      });
    } finally {
      brokerMaintenanceRunning = false;
    }
  }

  function startBrokerMaintenance(ctx: ExtensionContext): void {
    stopBrokerMaintenance();
    brokerMaintenanceTimer = setInterval(() => {
      runBrokerMaintenance(ctx);
    }, DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS);
    brokerMaintenanceTimer.unref?.();
    runBrokerMaintenance(ctx);
  }

  function stopBrokerMaintenance(): void {
    if (!brokerMaintenanceTimer) return;
    clearInterval(brokerMaintenanceTimer);
    brokerMaintenanceTimer = null;
  }

  function runBrokerScheduledWakeups(ctx: ExtensionContext): void {
    if (!activeBroker || brokerScheduledWakeupRunning) return;

    brokerScheduledWakeupRunning = true;
    try {
      const deliveries = (activeBroker.db as BrokerDB).deliverDueScheduledWakeups();
      if (deliveries.length > 0 && activeSelfId) {
        syncBrokerDbInbox(activeSelfId, activeBroker.db as BrokerDB, ctx);
      }
    } catch (err) {
      ctx.ui.notify(`Pinet scheduled wake-ups failed: ${msg(err)}`, "error");
      logBrokerActivity({
        kind: "scheduled_wakeup_error",
        level: "errors",
        title: "Scheduled wake-up delivery failed",
        summary: msg(err),
        tone: "error",
      });
    } finally {
      brokerScheduledWakeupRunning = false;
    }
  }

  function startBrokerScheduledWakeups(ctx: ExtensionContext): void {
    stopBrokerScheduledWakeups();
    brokerScheduledWakeupTimer = setInterval(() => {
      runBrokerScheduledWakeups(ctx);
    }, 1000);
    brokerScheduledWakeupTimer.unref?.();
    runBrokerScheduledWakeups(ctx);
  }

  function stopBrokerScheduledWakeups(): void {
    brokerScheduledWakeupRunning = false;
    if (!brokerScheduledWakeupTimer) return;
    clearInterval(brokerScheduledWakeupTimer);
    brokerScheduledWakeupTimer = null;
  }

  function sendBrokerMaintenanceMessage(targetAgentId: string, body: string): void {
    if (!activeBroker || !activeSelfId) return;
    const db = activeBroker.db;
    const target = db.getAgentById(targetAgentId);
    if (!target) return;

    const threadId = `a2a:${activeSelfId}:${target.id}`;
    if (!db.getThread(threadId)) {
      db.createThread(threadId, "agent", "", activeSelfId);
    }

    db.insertMessage(threadId, "agent", "outbound", activeSelfId, body, [target.id], {
      kind: "ralph_loop_nudge",
      targetAgentId,
    });
  }

  function trySendBrokerFollowUp(body: string, onDelivered: () => void): void {
    try {
      pi.sendUserMessage(body, { deliverAs: "followUp" });
      onDelivered();
      return;
    } catch {
      try {
        pi.sendUserMessage(body);
        onDelivered();
      } catch {
        /* best effort */
      }
    }
  }

  function getBrokerControlPlaneHomeTabViewerIds(): string[] {
    return [...brokerControlPlaneHomeTabViewers.entries()].map(([userId]) => userId);
  }

  async function buildCurrentBrokerControlPlaneDashboardSnapshot(
    cycleStartedAt: string = new Date().toISOString(),
  ): Promise<BrokerControlPlaneDashboardSnapshot | null> {
    if (!activeBroker) {
      return null;
    }

    const db = activeBroker.db;
    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    const workloads = db.getAllAgents().map((agent) => ({
      ...agent,
      pendingInboxCount: db.getPendingInboxCount(agent.id),
      ownedThreadCount: db.getOwnedThreadCount(agent.id),
    }));
    const pendingBacklogCount = db.getBacklogCount("pending");
    const evaluationOptions: RalphLoopEvaluationOptions = {
      now: Date.now(),
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
      pendingBacklogCount,
      currentBranch,
      brokerHeartbeatActive: brokerHeartbeatTimer != null,
      brokerMaintenanceActive: brokerMaintenanceTimer != null,
      brokerAgentId: activeSelfId ?? undefined,
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
      maintenance: lastBrokerMaintenance,
      assignments: projectedAssignments,
      recentCycles: recentRalphCycles,
      cycleStartedAt,
      cycleDurationMs: 0,
      currentBranch,
      homedir: os.homedir(),
    });
  }

  async function refreshBrokerControlPlaneHomeTabs(
    ctx: ExtensionContext,
    snapshot: BrokerControlPlaneDashboardSnapshot,
    refreshedAt: string,
    userIds: string[] = getBrokerControlPlaneHomeTabViewerIds(),
  ): Promise<void> {
    if (!botToken || userIds.length === 0) {
      return;
    }

    lastBrokerControlPlaneHomeTabSnapshot = snapshot;
    let hadError = false;

    for (const userId of userIds) {
      try {
        await publishSlackHomeTab({
          slack,
          token: botToken,
          userId,
          view: renderBrokerControlPlaneHomeTabView(snapshot),
        });
      } catch (err) {
        hadError = true;
        const homeTabMessage = `Pinet Home tab publish failed: ${msg(err)}`;
        if (homeTabMessage !== lastBrokerControlPlaneHomeTabError) {
          ctx.ui.notify(homeTabMessage, "warning");
        }
        lastBrokerControlPlaneHomeTabError = homeTabMessage;
      }
    }

    if (!hadError) {
      lastBrokerControlPlaneHomeTabError = null;
    }
    lastBrokerControlPlaneHomeTabRefreshAt = refreshedAt;
  }

  function reportHomeTabPublishFailure(ctx: ExtensionContext, err: unknown): void {
    const homeTabMessage = `Pinet Home tab publish failed: ${msg(err)}`;
    if (homeTabMessage !== lastBrokerControlPlaneHomeTabError) {
      ctx.ui.notify(homeTabMessage, "warning");
    }
    lastBrokerControlPlaneHomeTabError = homeTabMessage;
  }

  async function publishCurrentPinetHomeTab(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
  ): Promise<void> {
    if (!botToken) {
      return;
    }

    if (activeBroker && brokerRole === "broker") {
      brokerControlPlaneHomeTabViewers.set(userId, { openedAt });
      const snapshot =
        (await buildCurrentBrokerControlPlaneDashboardSnapshot(openedAt)) ??
        lastBrokerControlPlaneHomeTabSnapshot;
      if (snapshot) {
        await refreshBrokerControlPlaneHomeTabs(ctx, snapshot, openedAt, [userId]);
        return;
      }
    }

    const currentBranch = (await probeGitBranch(process.cwd())) ?? null;
    await publishSlackHomeTab({
      slack,
      token: botToken,
      userId,
      view: renderStandalonePinetHomeTabView({
        agentName,
        agentEmoji,
        connected: activeBroker != null || ws?.readyState === WebSocket.OPEN,
        mode:
          brokerRole === "broker" ? "broker" : brokerRole === "follower" ? "worker" : "standalone",
        activeThreads: threads.size,
        pendingInbox: inbox.length,
        currentBranch,
        defaultChannel: settings.defaultChannel ?? null,
      }),
    });
    lastBrokerControlPlaneHomeTabError = null;
  }

  async function publishCurrentPinetHomeTabSafely(
    userId: string,
    ctx: ExtensionContext,
    openedAt: string = new Date().toISOString(),
  ): Promise<void> {
    try {
      await publishCurrentPinetHomeTab(userId, ctx, openedAt);
    } catch (err) {
      reportHomeTabPublishFailure(ctx, err);
    }
  }

  async function refreshBrokerControlPlaneCanvasDashboard(
    ctx: ExtensionContext,
    input: {
      workloads: RalphLoopAgentWorkload[];
      evaluation: RalphLoopEvaluationResult;
      evaluationOptions: RalphLoopEvaluationOptions;
      maintenance: BrokerMaintenanceResult | null;
      assignments: ResolvedTaskAssignment[];
      recentCycles: Array<{
        startedAt: string;
        completedAt: string | null;
        durationMs: number | null;
        ghostAgentIds: string[];
        stuckAgentIds: string[];
        anomalies: string[];
        followUpDelivered: boolean;
        agentCount: number;
        backlogCount: number;
      }>;
      cycleStartedAt: string;
      cycleDurationMs: number;
      currentBranch: string | null;
    },
  ): Promise<void> {
    if (!botToken || !isBrokerControlPlaneCanvasEnabled()) {
      lastBrokerControlPlaneCanvasError = null;
      return;
    }

    const explicitCanvasId = getExplicitBrokerControlPlaneCanvasId();
    const effectiveCanvasId = getConfiguredBrokerControlPlaneCanvasId();
    const channelInput = getConfiguredBrokerControlPlaneCanvasChannel();
    if (!effectiveCanvasId && !channelInput) {
      const warning =
        "Pinet broker control plane canvas skipped: set slack-bridge.controlPlaneCanvasChannel, defaultChannel, or controlPlaneCanvasId.";
      if (lastBrokerControlPlaneCanvasError !== warning) {
        ctx.ui.notify(warning, "warning");
      }
      lastBrokerControlPlaneCanvasError = warning;
      return;
    }

    const snapshot = buildBrokerControlPlaneDashboardSnapshot({
      workloads: input.workloads,
      evaluation: input.evaluation,
      evaluationOptions: input.evaluationOptions,
      maintenance: input.maintenance,
      assignments: input.assignments,
      recentCycles: input.recentCycles,
      cycleStartedAt: input.cycleStartedAt,
      cycleDurationMs: input.cycleDurationMs,
      currentBranch: input.currentBranch,
      homedir: os.homedir(),
    });
    const markdown = renderBrokerControlPlaneCanvasMarkdown(snapshot);
    const channelId = explicitCanvasId || !channelInput ? null : await resolveChannel(channelInput);
    const reusableRuntimeCanvasId =
      !explicitCanvasId &&
      brokerControlPlaneCanvasRuntimeId &&
      (!channelId || brokerControlPlaneCanvasRuntimeChannelId === channelId)
        ? brokerControlPlaneCanvasRuntimeId
        : null;
    const previousRuntimeId = brokerControlPlaneCanvasRuntimeId;
    const previousRuntimeChannelId = brokerControlPlaneCanvasRuntimeChannelId;
    const result = await refreshBrokerControlPlaneCanvas({
      slack,
      token: botToken,
      markdown,
      canvasId: explicitCanvasId ?? reusableRuntimeCanvasId,
      channelId,
      title: getConfiguredBrokerControlPlaneCanvasTitle(),
    });

    if (!explicitCanvasId) {
      brokerControlPlaneCanvasRuntimeId = result.canvasId;
      brokerControlPlaneCanvasRuntimeChannelId = channelId;
    }
    lastBrokerControlPlaneCanvasRefreshAt = input.cycleStartedAt;
    lastBrokerControlPlaneCanvasError = null;

    if (
      !explicitCanvasId &&
      (result.canvasId !== previousRuntimeId || channelId !== previousRuntimeChannelId)
    ) {
      persistState();
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

  function getRalphLoopDeps(): RalphLoopDeps {
    return {
      getBrokerDb: () => (activeBroker?.db as BrokerDB) ?? null,
      getBrokerAgentId: () => activeSelfId,
      heartbeatTimerActive: () => brokerHeartbeatTimer != null,
      maintenanceTimerActive: () => brokerMaintenanceTimer != null,
      runMaintenance: (c) => runBrokerMaintenance(c),
      sendMaintenanceMessage: (id, body) => sendBrokerMaintenanceMessage(id, body),
      trySendFollowUp: (body, onDelivered) => trySendBrokerFollowUp(body, onDelivered),
      logActivity: (entry) => logBrokerActivity(entry),
      formatTrackedAgent,
      summarizeTrackedAssignmentStatus: (status, prNumber, branch) =>
        summarizeTrackedAssignmentStatus(
          status as Parameters<typeof summarizeTrackedAssignmentStatus>[0],
          prNumber,
          branch,
        ),
      refreshCanvasDashboard: (c, input) =>
        refreshBrokerControlPlaneCanvasDashboard(
          c,
          input as Parameters<typeof refreshBrokerControlPlaneCanvasDashboard>[1],
        ),
      refreshHomeTabs: (c, snapshot, at) => refreshBrokerControlPlaneHomeTabs(c, snapshot, at),
      getLastMaintenance: () => lastBrokerMaintenance,
      buildControlPlaneDashboardSnapshot: (input) =>
        buildBrokerControlPlaneDashboardSnapshot(
          input as unknown as Parameters<typeof buildBrokerControlPlaneDashboardSnapshot>[0],
        ),
      setLastHomeTabSnapshot: (s) => {
        lastBrokerControlPlaneHomeTabSnapshot = s;
      },
      getLastCanvasError: () => lastBrokerControlPlaneCanvasError,
      setLastCanvasError: (e) => {
        lastBrokerControlPlaneCanvasError = e;
      },
      getLastHomeTabError: () => lastBrokerControlPlaneHomeTabError,
      setLastHomeTabError: (e) => {
        lastBrokerControlPlaneHomeTabError = e;
      },
    };
  }

  function startBrokerRalphLoop(ctx: ExtensionContext): void {
    startRalphLoop(ctx, ralphLoopState, getRalphLoopDeps());
  }

  function stopBrokerRalphLoop(): void {
    stopRalphLoop(ralphLoopState);
    lastBrokerControlPlaneHomeTabSnapshot = null;
  }

  function prepareOutgoingPinetAgentMessage(
    body: string,
    metadata?: Record<string, unknown>,
  ): { body: string; metadata?: Record<string, unknown> } {
    const control = normalizeOutgoingPinetControlMessage(body, metadata);
    if (control) {
      return {
        body: control.body,
        metadata: control.metadata,
      };
    }

    return { body, metadata };
  }

  async function sendPinetAgentMessage(
    targetRef: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ messageId: number; target: string }> {
    if (!pinetEnabled) {
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
    }

    if (isBroadcastChannelTarget(targetRef)) {
      throw new Error(
        "Broadcast channels are broker-only. Send the request to the broker instead.",
      );
    }

    const outgoing = prepareOutgoingPinetAgentMessage(body, metadata);
    const finalBody = outgoing.body;
    const finalMetadata = outgoing.metadata;

    if (brokerRole === "broker" && activeBroker) {
      const db = activeBroker.db;
      const selfId = activeSelfId;
      if (!selfId) {
        throw new Error("Broker agent identity is unavailable.");
      }

      const result = dispatchDirectAgentMessage(db, {
        senderAgentId: selfId,
        senderAgentName: agentName,
        target: targetRef,
        body: finalBody,
        metadata: finalMetadata,
      });

      const recordedAssignments = [] as Array<{ issueNumber: number; branch: string | null }>;
      for (const assignment of extractTaskAssignmentsFromMessage(body)) {
        const tracked = db.recordTaskAssignment(
          result.target.id,
          assignment.issueNumber,
          assignment.branch,
          result.threadId,
          result.messageId,
        );
        recordedAssignments.push({ issueNumber: tracked.issueNumber, branch: tracked.branch });
      }

      if (recordedAssignments.length > 0) {
        logBrokerActivity({
          kind: "task_assignment",
          level: "actions",
          title: recordedAssignments.length === 1 ? "Task assigned" : "Tasks assigned",
          summary: `Assigned ${recordedAssignments.map((assignment) => `#${assignment.issueNumber}`).join(", ")} to ${formatTrackedAgent(result.target.id)}.`,
          details: recordedAssignments.map((assignment) =>
            assignment.branch
              ? `#${assignment.issueNumber} on \`${assignment.branch}\``
              : `#${assignment.issueNumber}`,
          ),
          fields: [
            { label: "Worker", value: formatTrackedAgent(result.target.id) },
            { label: "Thread", value: result.threadId },
            { label: "Message", value: result.messageId },
          ],
          tone: "info",
        });
      }

      return { messageId: result.messageId, target: result.target.name };
    }

    if (brokerRole === "follower" && brokerClient) {
      const client = brokerClient.client as BrokerClient;
      const messageId = await client.sendAgentMessage(targetRef, finalBody, finalMetadata);
      return { messageId, target: targetRef };
    }

    throw new Error("Pinet is in an unexpected state.");
  }

  function applyMeshSkin(themeInput: string): { theme: string; updatedAgents: string[] } {
    if (brokerRole !== "broker" || !activeBroker) {
      throw new Error("/pinet-skin can only run on the active broker.");
    }

    const theme = normalizePinetSkinTheme(themeInput);
    if (!theme) {
      throw new Error("Usage: /pinet-skin <theme>");
    }

    const selfId = activeSelfId;
    if (!selfId) {
      throw new Error("Broker agent identity is unavailable.");
    }

    activeSkinTheme = theme;
    activeBroker.db.setSetting(PINET_SKIN_SETTING_KEY, theme);

    const updatedAgents: string[] = [];
    for (const agent of activeBroker.db.getAgents()) {
      const role =
        agent.id === selfId
          ? "broker"
          : getMeshRoleFromMetadata(agent.metadata ?? undefined, "worker");
      const assignment = buildPinetSkinAssignment({
        theme,
        role,
        seed: agent.stableId ?? agent.id,
      });
      const updated = activeBroker.db.updateAgentIdentity(agent.id, {
        name: assignment.name,
        emoji: assignment.emoji,
        metadata: buildSkinMetadata(agent.metadata ?? undefined, assignment.personality),
      });
      if (!updated) continue;

      if (agent.id === selfId) {
        applyLocalAgentIdentity(updated.name, updated.emoji, assignment.personality);
      } else {
        dispatchDirectAgentMessage(activeBroker.db, {
          senderAgentId: selfId,
          senderAgentName: agentName,
          target: updated.id,
          body: `Mesh skin changed to ${theme}`,
          metadata: buildPinetSkinMetadata({
            theme,
            name: updated.name,
            emoji: updated.emoji,
            personality: assignment.personality,
          }),
        });
      }

      updatedAgents.push(updated.name);
    }

    persistState();
    return { theme, updatedAgents };
  }

  let remoteControlState: PinetRemoteControlState = {
    currentCommand: null,
    queuedCommand: null,
  };
  const pendingBrokerControlInboxIds: Record<PinetControlCommand, Set<number>> = {
    reload: new Set<number>(),
    exit: new Set<number>(),
  };
  const pendingFollowerControlInboxIds: Record<PinetControlCommand, Set<number>> = {
    reload: new Set<number>(),
    exit: new Set<number>(),
  };

  function resetPendingRemoteControlAcks(): void {
    pendingBrokerControlInboxIds.reload.clear();
    pendingBrokerControlInboxIds.exit.clear();
    pendingFollowerControlInboxIds.reload.clear();
    pendingFollowerControlInboxIds.exit.clear();
  }

  function deferBrokerControlAck(command: PinetControlCommand, inboxId: number): void {
    pendingBrokerControlInboxIds[command].add(inboxId);
    queueBrokerInboxIds(brokerDeliveryState, [inboxId]);
  }

  function deferFollowerControlAck(command: PinetControlCommand, inboxId: number): void {
    pendingFollowerControlInboxIds[command].add(inboxId);
    queueFollowerInboxIds(followerDeliveryState, [inboxId]);
  }

  function flushDeferredRemoteControlAcks(command: PinetControlCommand): void {
    const brokerIds = [...pendingBrokerControlInboxIds[command]];
    if (brokerIds.length > 0 && activeBroker && activeSelfId) {
      activeBroker.db.markDelivered(brokerIds, activeSelfId);
      markBrokerInboxIdsHandled(brokerDeliveryState, brokerIds);
      pendingBrokerControlInboxIds[command].clear();
    }

    const followerIds = [...pendingFollowerControlInboxIds[command]];
    if (followerIds.length > 0) {
      markFollowerInboxIdsDelivered(followerDeliveryState, followerIds);
      pendingFollowerControlInboxIds[command].clear();
      void flushDeliveredFollowerAcks();
    }
  }

  async function stopPinetRuntime(
    ctx: ExtensionContext,
    options: { releaseIdentity: boolean },
  ): Promise<void> {
    flushPersist();
    stopBrokerHeartbeat();
    stopBrokerMaintenance();
    stopBrokerRalphLoop();
    stopBrokerScheduledWakeups();

    if (activeBroker) {
      try {
        if (options.releaseIdentity && activeSelfId) {
          activeBroker.db.unregisterAgent(activeSelfId);
        }
        await activeBroker.stop();
      } catch {
        /* best effort */
      }
      activeBroker = null;
    }
    activeRouter = null;
    activeSelfId = null;
    lastBrokerMaintenance = null;
    lastBrokerMaintenanceSignature = "";
    lastBrokerControlPlaneCanvasRefreshAt = null;
    lastBrokerControlPlaneCanvasError = null;
    lastBrokerControlPlaneHomeTabSnapshot = null;
    lastBrokerControlPlaneHomeTabRefreshAt = null;
    lastBrokerControlPlaneHomeTabError = null;
    brokerControlPlaneHomeTabViewers.clear();
    resetRalphLoopState(ralphLoopState);
    resetBrokerDeliveryState(brokerDeliveryState);

    if (brokerClient) {
      if (options.releaseIdentity) {
        await disconnectFollower(ctx).catch(() => {
          /* best effort */
        });
      } else {
        try {
          if (brokerClient.pollInterval) {
            clearInterval(brokerClient.pollInterval);
          }
          await flushDeliveredFollowerAcks().catch(() => {
            /* best effort */
          });
          brokerClient.client.disconnect();
        } catch {
          /* best effort */
        }
        brokerClient = null;
        resetFollowerDeliveryState(followerDeliveryState);
        followerAckPromise = null;
        brokerRole = null;
        pinetEnabled = false;
      }
    }

    await disconnect();
    activityLogger.clearPending();
    brokerRole = null;
    pinetEnabled = false;
    setExtStatus(ctx, "off");
  }

  async function reloadPinetRuntime(ctx: ExtensionContext): Promise<void> {
    await reloadPinetRuntimeSafely({
      getCurrentRole: () => brokerRole,
      snapshotState: () => snapshotReloadableRuntime(),
      restoreState: (snapshot) => {
        restoreReloadableRuntime(snapshot);
      },
      refreshState: () => {
        refreshSettings();
      },
      validateRefreshedState: () => {
        if (!botToken || !appToken) {
          throw new Error("Slack tokens are not configured after reload.");
        }
      },
      stopRuntime: async () => {
        await stopPinetRuntime(ctx, { releaseIdentity: false });
        // Reload intentionally keeps the extension alive in-process, so restore a
        // fresh top-level Slack request tracker after aborting the previous
        // generation. This preserves shutdown abort semantics without leaving
        // top-level Slack tools permanently stuck in "shutdown in progress".
        resetTopLevelSlackRequests();
        shuttingDown = false;
        setExtStatus(ctx, "reconnecting");
      },
      startRuntime: async (role) => {
        if (role === "broker") {
          await connectAsBroker(ctx);
          return;
        }
        await connectAsFollower(ctx);
      },
    });
  }

  function runRemoteControl(command: PinetControlCommand, ctx: ExtensionContext): void {
    flushDeferredRemoteControlAcks(command);

    const controlCtx = ctx as PinetRuntimeControlContext;
    if (!(ctx.isIdle?.() ?? true)) {
      try {
        controlCtx.abort?.();
      } catch {
        /* best effort */
      }
    }

    ctx.ui.notify(`Pinet remote control requested: /${command}`, "warning");
    void (async () => {
      try {
        if (command === "reload") {
          await reloadPinetRuntime(ctx);
          return;
        }

        if (typeof controlCtx.shutdown !== "function") {
          throw new Error("Shutdown is not available in this extension context.");
        }
        controlCtx.shutdown();
      } catch (err) {
        ctx.ui.notify(`Pinet remote control failed: ${msg(err)}`, "error");
      } finally {
        const next = finishPinetRemoteControl(remoteControlState);
        remoteControlState = {
          currentCommand: next.currentCommand,
          queuedCommand: next.queuedCommand,
        };
        if (next.nextCommand) {
          ctx.ui.notify(
            `Pinet remote control continuing with queued /${next.nextCommand}`,
            "warning",
          );
          runRemoteControl(next.nextCommand, ctx);
        }
      }
    })();
  }

  function requestRemoteControl(
    command: PinetControlCommand,
    ctx: ExtensionContext,
  ): ReturnType<typeof queuePinetRemoteControl> {
    const queued = queuePinetRemoteControl(remoteControlState, command);
    remoteControlState = {
      currentCommand: queued.currentCommand,
      queuedCommand: queued.queuedCommand,
    };

    if (queued.status === "queued") {
      ctx.ui.notify(`Pinet remote control queued: /${queued.queuedCommand ?? command}`, "warning");
    } else if (!queued.shouldStartNow) {
      ctx.ui.notify(
        `Pinet remote control already scheduled — keeping /${queued.scheduledCommand}`,
        "warning",
      );
    }

    return queued;
  }

  pi.registerTool({
    name: "pinet_message",
    label: "Pinet Message",
    description:
      "Send a message to another connected Pinet agent, or from the broker to a broadcast channel.",
    promptSnippet:
      "Send a message to another connected Pinet agent. When you send a task, sepcify the desired workflow, ideally something like `ack/work/ask/report`: ACK briefly, do the work, report blockers or questions immediately, report the outcome when done. Always reply where the task came from. To trigger remote agent control, send the exact message `/reload` or `/exit`. Broadcast channels like `#all` or `#extensions` are broker-only.",
    parameters: Type.Object({
      to: Type.String({
        description:
          "Target agent name/ID, or a broker-only broadcast channel like #all or #extensions",
      }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params) {
      requireToolPolicy("pinet_message", undefined, `to=${params.to} | message=${params.message}`);

      if (brokerRole === "broker" && activeBroker && isBroadcastChannelTarget(params.to)) {
        const selfId = activeSelfId;
        if (!selfId) {
          throw new Error("Broker agent identity is unavailable.");
        }

        const outgoing = prepareOutgoingPinetAgentMessage(params.message);
        const result = dispatchBroadcastAgentMessage(activeBroker.db, {
          senderAgentId: selfId,
          senderAgentName: agentName,
          channel: params.to,
          body: outgoing.body,
          ...(outgoing.metadata ? { metadata: outgoing.metadata } : {}),
        });
        const recipients = result.targets.map((target) => target.name);
        const preview = recipients.slice(0, 5).join(", ");
        const suffix = recipients.length > 5 ? ", …" : "";

        return {
          content: [
            {
              type: "text",
              text: `Broadcast sent to ${result.channel} (${result.targets.length} agents: ${preview}${suffix}).`,
            },
          ],
          details: {
            channel: result.channel,
            messageIds: result.messageIds,
            recipients,
          },
        };
      }

      const result = await sendPinetAgentMessage(params.to, params.message);
      return {
        content: [
          { type: "text", text: `Message sent to ${result.target} (id: ${result.messageId}).` },
        ],
        details: { messageId: result.messageId, target: result.target },
      };
    },
  });

  pi.registerTool({
    name: "pinet_free",
    label: "Pinet Free",
    description: "Signal that this Pinet agent is idle/free and available for new work.",
    promptSnippet:
      "When you have finished all assigned work and already reported the outcome, call this to mark yourself idle/free for new assignments.",
    parameters: Type.Object({
      note: Type.Optional(
        Type.String({ description: "Optional short note about what you just finished" }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy("pinet_free", undefined, `note=${params.note ?? ""}`);

      const note = typeof params.note === "string" ? params.note.trim() : "";
      const result = signalAgentFree(undefined, { requirePinet: true });
      const inboxSuffix =
        result.queuedInboxCount > 0
          ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
          : "";
      const noteSuffix = note ? ` Note: ${note}.` : "";

      return {
        content: [
          {
            type: "text",
            text: `Marked this Pinet agent idle/free for new work.${noteSuffix}${inboxSuffix}`,
          },
        ],
        details: {
          status: "idle",
          note: note || null,
          queuedInboxCount: result.queuedInboxCount,
        },
      };
    },
  });

  pi.registerTool({
    name: "pinet_schedule",
    label: "Pinet Schedule",
    description: "Schedule a future wake-up message for the current Pinet agent.",
    promptSnippet:
      "Schedule a future wake-up for yourself via the Pinet broker. Use this instead of busy-waiting when you need to check back later.",
    parameters: Type.Object({
      delay: Type.Optional(
        Type.String({ description: "Relative delay like 5m, 30s, 1h30m, or 1d" }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute ISO-8601 UTC time, e.g. 2026-04-02T14:30:00Z" }),
      ),
      message: Type.String({ description: "Reminder or wake-up message to deliver later" }),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "pinet_schedule",
        undefined,
        `delay=${params.delay ?? ""} | at=${params.at ?? ""} | message=${params.message}`,
      );

      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      const message = params.message.trim();
      if (!message) {
        throw new Error("message is required");
      }

      const fireAt = resolveScheduledWakeupFireAt({ delay: params.delay, at: params.at });

      if (brokerRole === "broker" && activeBroker && activeSelfId) {
        const wakeup = (activeBroker.db as BrokerDB).scheduleWakeup(activeSelfId, message, fireAt);
        return {
          content: [
            {
              type: "text",
              text: `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`,
            },
          ],
          details: wakeup,
        };
      }

      if (brokerRole === "follower" && brokerClient) {
        const wakeup = await (brokerClient.client as BrokerClient).scheduleWakeup(fireAt, message);
        return {
          content: [
            {
              type: "text",
              text: `Wake-up scheduled for ${wakeup.fireAt} (id: ${wakeup.id}).`,
            },
          ],
          details: wakeup,
        };
      }

      throw new Error("Pinet is in an unexpected state.");
    },
  });

  pi.registerTool({
    name: "pinet_agents",
    label: "Pinet Agents",
    description: "List Pinet agents, including liveness and capability visibility.",
    promptSnippet:
      "List connected Pinet agents with liveness and capability info. Use before delegating work to find available agents, or to check health and status of agents you have assigned work to.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Preferred repo name for routing" })),
      branch: Type.Optional(Type.String({ description: "Preferred branch for routing" })),
      role: Type.Optional(
        Type.String({ description: "Preferred agent role, e.g. broker or worker" }),
      ),
      required_tools: Type.Optional(
        Type.String({ description: "Comma-separated required capability/tool tags" }),
      ),
      task: Type.Optional(Type.String({ description: "Optional natural-language task hint" })),
    }),
    async execute(_toolCallId, params) {
      requireToolPolicy(
        "pinet_agents",
        undefined,
        `repo=${params.repo ?? ""} | branch=${params.branch ?? ""} | role=${params.role ?? ""} | required_tools=${params.required_tools ?? ""} | task=${params.task ?? ""}`,
      );

      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      const includeGhosts = true;
      const recentGhostWindowMs = DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
      const nowMs = Date.now();

      const isRecentDisconnected = (agent: { disconnectedAt?: string | null }): boolean => {
        if (!agent.disconnectedAt) return true;
        const disconnectedMs = Date.parse(agent.disconnectedAt);
        return !Number.isNaN(disconnectedMs) && nowMs - disconnectedMs <= recentGhostWindowMs;
      };

      const toDisplay = (agent: {
        emoji: string;
        name: string;
        id: string;
        pid?: number;
        status: "working" | "idle";
        metadata: Record<string, unknown> | null;
        lastHeartbeat: string;
        disconnectedAt?: string | null;
        resumableUntil?: string | null;
      }): AgentDisplayInfo =>
        buildAgentDisplayInfo(agent, {
          now: nowMs,
          heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        });

      let rawAgents: Array<{
        emoji: string;
        name: string;
        id: string;
        pid?: number;
        status: "working" | "idle";
        metadata: Record<string, unknown> | null;
        lastHeartbeat: string;
        disconnectedAt?: string | null;
        resumableUntil?: string | null;
      }>;
      if (brokerRole === "broker" && activeBroker) {
        rawAgents = activeBroker.db
          .getAllAgents()
          .filter((agent) => includeGhosts || !agent.disconnectedAt)
          .filter((agent) => (includeGhosts ? isRecentDisconnected(agent) : true))
          .map((agent) => ({
            emoji: agent.emoji,
            name: agent.name,
            id: agent.id,
            pid: agent.pid,
            status: agent.status,
            metadata: agent.metadata,
            lastHeartbeat: agent.lastHeartbeat,
            disconnectedAt: agent.disconnectedAt,
            resumableUntil: agent.resumableUntil,
          }));
      } else if (brokerRole === "follower" && brokerClient) {
        rawAgents = (await brokerClient.client.listAgents(includeGhosts))
          .filter((agent) => includeGhosts || !agent.disconnectedAt)
          .filter((agent) => (includeGhosts ? isRecentDisconnected(agent) : true))
          .map((agent) => ({
            emoji: agent.emoji,
            name: agent.name,
            id: agent.id,
            pid: agent.pid,
            status: agent.status ?? "idle",
            metadata: agent.metadata,
            lastHeartbeat: agent.lastHeartbeat,
            disconnectedAt: agent.disconnectedAt,
            resumableUntil: agent.resumableUntil,
          }));
      } else {
        throw new Error("Pinet is in an unexpected state.");
      }

      const visibleAgents = rawAgents.map(toDisplay);
      const hint = {
        repo: params.repo,
        branch: params.branch,
        role: params.role,
        requiredTools: params.required_tools
          ?.split(",")
          .map((tool: string) => tool.trim())
          .filter(Boolean),
        task: params.task,
      };
      const hasHint = Boolean(
        hint.repo || hint.branch || hint.role || (hint.requiredTools?.length ?? 0) > 0 || hint.task,
      );
      const agents = rankAgentsForRouting(visibleAgents, hint);

      const header = hasHint
        ? `Agent routing hints: ${[
            hint.repo ? `repo=${hint.repo}` : null,
            hint.branch ? `branch=${hint.branch}` : null,
            hint.role ? `role=${hint.role}` : null,
            hint.requiredTools && hint.requiredTools.length > 0
              ? `tools=${hint.requiredTools.join(",")}`
              : null,
            hint.task ? `task=${hint.task}` : null,
          ]
            .filter((item): item is string => Boolean(item))
            .join(" · ")}\n\n`
        : "";
      const text = `${header}${formatAgentList(agents, os.homedir())}`;
      return {
        content: [{ type: "text", text }],
        details: { agents, hint },
      };
    },
  });

  // ─── Commands ───────────────────────────────────────

  async function connectAsBroker(ctx: ExtensionContext): Promise<void> {
    refreshSettings();
    const meshAuth = resolvePinetMeshAuth(settings);
    const broker = await startBroker({
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
    });
    const adapter = new SlackAdapter({
      botToken: botToken!,
      appToken: appToken!,
      allowedUsers: allowedUsers ? [...allowedUsers] : undefined,
      suggestedPrompts: settings.suggestedPrompts,
      reactionCommands: settings.reactionCommands,
      isKnownThread: (threadTs: string) => broker.db.getThread(threadTs) != null,
      rememberKnownThread: (threadTs: string, channelId: string) => {
        broker.db.updateThread(threadTs, { source: "slack", channel: channelId });
      },
      onAppHomeOpened: async ({ userId }) => {
        await publishCurrentPinetHomeTabSafely(userId, ctx, new Date().toISOString());
      },
    });
    let selfId: string | null = null;

    try {
      const router = new MessageRouter(broker.db);
      activeSkinTheme =
        broker.db.getSetting<string>(PINET_SKIN_SETTING_KEY) ?? DEFAULT_PINET_SKIN_THEME;
      broker.db.setSetting(PINET_SKIN_SETTING_KEY, activeSkinTheme);
      broker.server.setAgentRegistrationResolver((registration) => {
        const theme = activeSkinTheme ?? DEFAULT_PINET_SKIN_THEME;
        const role = getMeshRoleFromMetadata(registration.metadata, "worker");
        const assignment = buildPinetSkinAssignment({
          theme,
          role,
          seed: registration.stableId ?? registration.agentId,
        });
        return {
          name: assignment.name,
          emoji: assignment.emoji,
          metadata: buildSkinMetadata(registration.metadata, assignment.personality),
        };
      });

      const selfAssignment = buildPinetSkinAssignment({
        theme: activeSkinTheme,
        role: "broker",
        seed: agentStableId,
      });
      const selfAgent = broker.db.registerAgent(
        ctx.sessionManager.getLeafId() ?? `broker-${process.pid}`,
        selfAssignment.name,
        selfAssignment.emoji,
        process.pid,
        buildSkinMetadata(await getAgentMetadata("broker"), selfAssignment.personality),
        agentStableId,
      );
      selfId = selfAgent.id;
      applyLocalAgentIdentity(selfAgent.name, selfAgent.emoji, selfAssignment.personality);

      const brokerThreadOwnerHintCache = new TtlCache<
        string,
        { agentOwner?: string; agentName?: string }
      >({
        maxSize: 2000,
        ttlMs: 60 * 1000,
      });

      async function resolveBrokerThreadOwnerHint(
        channel: string,
        threadTs: string,
      ): Promise<{ agentOwner?: string; agentName?: string } | null> {
        if (!channel || !threadTs) return null;

        const cacheKey = `${channel}:${threadTs}`;
        const cached = brokerThreadOwnerHintCache.get(cacheKey);
        if (cached) {
          return cached;
        }

        try {
          const response = await slack("conversations.replies", botToken!, {
            channel,
            ts: threadTs,
            limit: 200,
            include_all_metadata: true,
          });
          const replies = (response.messages as Record<string, unknown>[]) ?? [];
          const hint = extractPiAgentThreadOwnerHint(replies);
          if (hint) {
            brokerThreadOwnerHintCache.set(cacheKey, hint);
          }
          return hint;
        } catch {
          return null;
        }
      }

      adapter.onInbound((inMsg) => {
        void (async () => {
          try {
            const ownerHint =
              inMsg.source === "slack" && inMsg.threadId && inMsg.channel
                ? await resolveBrokerThreadOwnerHint(inMsg.channel, inMsg.threadId)
                : null;
            const routedMessage =
              ownerHint && (ownerHint.agentOwner || ownerHint.agentName)
                ? {
                    ...inMsg,
                    metadata: {
                      ...(inMsg.metadata ?? {}),
                      ...(ownerHint.agentOwner
                        ? { threadOwnerAgentOwner: ownerHint.agentOwner }
                        : {}),
                      ...(ownerHint.agentName ? { threadOwnerAgentName: ownerHint.agentName } : {}),
                    },
                  }
                : inMsg;

            // Track thread metadata locally as a cache without claiming broker ownership.
            trackBrokerInboundThread(threads, routedMessage);

            const decision = router.route(routedMessage);

            if (routedMessage.threadId && routedMessage.channel) {
              broker.db.updateThread(routedMessage.threadId, {
                source: routedMessage.source,
                channel: routedMessage.channel,
              });
            }

            if (decision.action === "deliver" && decision.agentId !== selfId) {
              broker.db.queueMessage(decision.agentId, routedMessage);
              return;
            }

            if (decision.action === "deliver" || decision.action === "unrouted") {
              // Message routed to broker itself (or unrouted) — deliver to broker's own inbox.
              inbox.push({
                channel: routedMessage.channel,
                threadTs: routedMessage.threadId,
                userId: routedMessage.userId,
                text: routedMessage.text,
                timestamp: routedMessage.timestamp,
                metadata: routedMessage.metadata ?? null,
              });
              updateBadge();
              maybeDrainInboxIfIdle(extCtx ?? undefined);
            }
          } catch (err) {
            console.error(`[slack-bridge] broker inbound routing failed: ${msg(err)}`);
          }
        })();
      });

      broker.addAdapter(adapter);
      await adapter.connect();
      botUserId = adapter.getBotUserId();

      activeBroker = broker;
      activeRouter = router;
      activeSelfId = selfId;
      brokerRole = "broker";
      pinetEnabled = true;

      resetBrokerDeliveryState(brokerDeliveryState);
      const releasedBrokerClaims = broker.db.releaseThreadClaims(selfId);
      const recoveredTargetedBacklogCount = broker.db.recoverPendingTargetedBacklog(selfId);
      const recoveredBrokerMessages = broker.db.getPendingInboxCount(selfId);
      if (recoveredBrokerMessages > 0 || releasedBrokerClaims > 0) {
        const recoveredTargetedDetail =
          recoveredTargetedBacklogCount > 0
            ? ` including ${recoveredTargetedBacklogCount} recovered targeted backlog item${recoveredTargetedBacklogCount === 1 ? "" : "s"}`
            : "";
        ctx.ui.notify(
          `Pinet broker recovered ${recoveredBrokerMessages} pending message${recoveredBrokerMessages === 1 ? "" : "s"}${recoveredTargetedDetail} and released ${releasedBrokerClaims} broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}`,
          "info",
        );
      }
      syncBrokerDbInbox(selfId, broker.db, ctx);

      // When a worker sends a pinet_message targeting the broker, the socket server writes to the
      // DB inbox but the broker only reads its in-memory inbox. Sync the durable inbox into memory
      // without acknowledging the row until the broker has actually consumed it.
      broker.server.onAgentMessage((targetAgentId) => {
        if (targetAgentId !== selfId) return;
        syncBrokerDbInbox(selfId, broker.db, ctx);
      });
      broker.server.onAgentStatusChange((changedAgentId, status) => {
        if (status === "idle") {
          runBrokerMaintenance(ctx);
        }

        logBrokerActivity({
          kind: "agent_status",
          level: "verbose",
          title: status === "idle" ? "Worker available" : "Worker busy",
          summary: `${formatTrackedAgent(changedAgentId)} marked itself ${status}.`,
          fields: [{ label: "Agent", value: formatTrackedAgent(changedAgentId) }],
          tone: status === "idle" ? "success" : "info",
        });
      });

      startBrokerHeartbeat();
      startBrokerMaintenance(ctx);
      startBrokerRalphLoop(ctx);
      startBrokerScheduledWakeups(ctx);
      setExtStatus(ctx, "ok");
      logBrokerActivity({
        kind: "broker_started",
        level: "actions",
        title: "Broker started",
        summary: `${agentEmoji} ${agentName} is online and coordinating the mesh.`,
        details:
          recoveredBrokerMessages > 0 || releasedBrokerClaims > 0
            ? [
                `Recovered ${recoveredBrokerMessages} pending broker inbox item${recoveredBrokerMessages === 1 ? "" : "s"}.`,
                ...(recoveredTargetedBacklogCount > 0
                  ? [
                      `Recovered ${recoveredTargetedBacklogCount} targeted backlog item${recoveredTargetedBacklogCount === 1 ? "" : "s"} during startup.`,
                    ]
                  : []),
                `Released ${releasedBrokerClaims} stale broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}.`,
              ]
            : undefined,
        fields: [
          { label: "Bot", value: botUserId ?? "unknown" },
          { label: "Log channel", value: settings.logChannel ?? "disabled" },
          { label: "Log level", value: settings.logLevel ?? "actions" },
        ],
        tone: "success",
      });
      ctx.ui.notify(`${agentEmoji} ${agentName} — broker started (${botUserId})`, "info");
    } catch (err) {
      try {
        await adapter.disconnect();
      } catch {
        /* best effort */
      }
      try {
        if (selfId) {
          broker.db.unregisterAgent(selfId);
        }
      } catch {
        /* best effort */
      }
      try {
        await broker.stop();
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  registerPinetCommands(pi, {
    pinetEnabled: () => pinetEnabled,
    pinetRegistrationBlocked: () => pinetRegistrationBlocked,
    brokerRole: () => brokerRole,
    agentName: () => agentName,
    agentEmoji: () => agentEmoji,
    agentOwnerToken: () => agentOwnerToken,
    agentPersonality: () => agentPersonality,
    agentAliases: () => agentAliases,
    botUserId: () => botUserId,
    activeSkinTheme: () => activeSkinTheme,
    lastDmChannel: () => lastDmChannel,
    threads: () => threads,
    allowedUsers: () => allowedUsers,
    inboxLength: () => inbox.length,
    activityLogger: () => activityLogger,
    settings: () => settings,
    lastBrokerMaintenance: () => lastBrokerMaintenance,
    isBrokerControlPlaneCanvasEnabled,
    getConfiguredBrokerControlPlaneCanvasId,
    getConfiguredBrokerControlPlaneCanvasChannel,
    lastBrokerControlPlaneCanvasRefreshAt: () => lastBrokerControlPlaneCanvasRefreshAt,
    lastBrokerControlPlaneCanvasError: () => lastBrokerControlPlaneCanvasError,
    getBrokerControlPlaneHomeTabViewerIds,
    lastBrokerControlPlaneHomeTabRefreshAt: () => lastBrokerControlPlaneHomeTabRefreshAt,
    lastBrokerControlPlaneHomeTabError: () => lastBrokerControlPlaneHomeTabError,
    getPinetRegistrationBlockReason,
    connectAsBroker,
    connectAsFollower,
    disconnectFollower,
    sendPinetAgentMessage,
    signalAgentFree,
    applyMeshSkin,
    applyLocalAgentIdentity,
    setExtStatus,
    setExtCtx: (ctx) => {
      extCtx = ctx;
    },
  });

  async function connectAsFollower(ctx: ExtensionContext): Promise<void> {
    if (pinetRegistrationBlocked) {
      throw new Error(getPinetRegistrationBlockReason());
    }

    refreshSettings();
    const meshAuth = resolvePinetMeshAuth(settings);
    const client = new BrokerClient({
      path: DEFAULT_SOCKET_PATH,
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
    });

    async function registerFollowerRuntime(): Promise<void> {
      refreshSettings();
      const workerIdentity = resolveRuntimeAgentIdentity(
        { name: agentName, emoji: agentEmoji },
        settings,
        process.env.PI_NICKNAME,
        ctx.sessionManager.getSessionFile() ?? agentStableId,
        "worker",
      );

      const registration = await client.register(
        workerIdentity.name,
        workerIdentity.emoji,
        await getAgentMetadata("worker"),
        agentStableId,
      );
      applyRegistrationIdentity(registration);
    }

    try {
      await client.connect();
      await registerFollowerRuntime();

      const brokerClientRef: BrokerClientRef = {
        client,
        pollInterval: null,
      };
      resetFollowerDeliveryState(followerDeliveryState);
      followerAckPromise = null;
      let wasDisconnected = false;
      let followerPollRunning = false;

      async function resumeThreadClaims(): Promise<void> {
        for (const thread of getFollowerOwnedThreadClaims(
          threads,
          agentName,
          agentAliases,
          agentOwnerToken,
        )) {
          try {
            await client.claimThread(thread.threadTs, thread.channelId);
          } catch {
            break;
          }
        }
      }

      function startPolling(): void {
        if (brokerClientRef.pollInterval) return;
        brokerClientRef.pollInterval = setInterval(async () => {
          if (!pinetEnabled || followerPollRunning) return;

          followerPollRunning = true;
          try {
            const entries = await client.pollInbox();
            const newEntries = entries.filter(
              (entry) => !isFollowerInboxIdTracked(followerDeliveryState, entry.inboxId),
            );
            if (newEntries.length === 0) {
              if (hasDeliveredFollowerInboxIds(followerDeliveryState)) {
                void flushDeliveredFollowerAcks();
              }
              return;
            }

            const controlEntries: Array<{ inboxId: number; command: PinetControlCommand }> = [];
            const skinEntries: Array<{
              inboxId: number;
              update: { theme: string; name: string; emoji: string; personality: string };
            }> = [];
            const remainingEntries = [];
            for (const entry of newEntries) {
              const command = extractPinetControlCommand({
                threadId: entry.message.threadId,
                body: entry.message.body,
                metadata: entry.message.metadata,
              });
              if (command) {
                controlEntries.push({ inboxId: entry.inboxId, command });
                continue;
              }

              const skinUpdate = extractPinetSkinUpdate({
                threadId: entry.message.threadId,
                body: entry.message.body,
                metadata: entry.message.metadata,
              });
              if (skinUpdate) {
                skinEntries.push({ inboxId: entry.inboxId, update: skinUpdate });
                continue;
              }

              remainingEntries.push(entry);
            }

            if (controlEntries.length > 0) {
              const immediateAckIds: number[] = [];
              const commandsToStart: PinetControlCommand[] = [];
              for (const entry of controlEntries) {
                const queued = requestRemoteControl(entry.command, ctx);
                if (queued.ackDisposition === "immediate") {
                  immediateAckIds.push(entry.inboxId);
                } else {
                  deferFollowerControlAck(queued.scheduledCommand, entry.inboxId);
                }
                if (queued.shouldStartNow) {
                  commandsToStart.push(entry.command);
                }
              }
              if (immediateAckIds.length > 0) {
                await client.ackMessages(immediateAckIds);
              }
              for (const command of commandsToStart) {
                runRemoteControl(command, ctx);
              }
              return;
            }

            if (skinEntries.length > 0) {
              for (const entry of skinEntries) {
                activeSkinTheme = entry.update.theme;
                applyLocalAgentIdentity(
                  entry.update.name,
                  entry.update.emoji,
                  entry.update.personality,
                );
              }
              await client.ackMessages(skinEntries.map((entry) => entry.inboxId));
            }

            // Partition nudges and a2a traffic out of the human Slack inbox flow.
            const { nudges, agentMessages, regular } =
              partitionFollowerInboxEntries(remainingEntries);

            if (nudges.length > 0) {
              const nudgeText = nudges
                .map((n) => n.message.body ?? "")
                .filter(Boolean)
                .join("\\n");
              if (nudgeText && deliverFollowUpMessage(nudgeText)) {
                markFollowerInboxIdsDelivered(
                  followerDeliveryState,
                  nudges.flatMap((entry) =>
                    typeof entry.inboxId === "number" ? [entry.inboxId] : [],
                  ),
                );
                void flushDeliveredFollowerAcks();
              }
            }

            if (agentMessages.length > 0) {
              const pinetPrompt = formatPinetInboxMessages(agentMessages);
              if (deliverFollowUpMessage(pinetPrompt)) {
                markFollowerInboxIdsDelivered(
                  followerDeliveryState,
                  agentMessages.flatMap((entry) =>
                    typeof entry.inboxId === "number" ? [entry.inboxId] : [],
                  ),
                );
                void flushDeliveredFollowerAcks();
              }
            }

            if (regular.length > 0) {
              const synced = syncFollowerInboxEntries(
                regular,
                threads,
                agentOwnerToken,
                lastDmChannel,
              );
              for (const nextThread of synced.threadUpdates) {
                const existing = threads.get(nextThread.threadTs);
                if (!existing) {
                  threads.set(nextThread.threadTs, { ...nextThread });
                  continue;
                }
                existing.channelId = nextThread.channelId;
                existing.threadTs = nextThread.threadTs;
                existing.userId = nextThread.userId;
                existing.owner = nextThread.owner;
              }
              lastDmChannel = synced.lastDmChannel;
              inbox.push(...synced.inboxMessages);
              queueFollowerInboxIds(
                followerDeliveryState,
                regular.flatMap((entry) =>
                  typeof entry.inboxId === "number" ? [entry.inboxId] : [],
                ),
              );
              if (synced.changed) persistState();
              updateBadge();
              maybeDrainInboxIfIdle(ctx);
            }
          } catch {
            /* broker may be restarting */
          } finally {
            followerPollRunning = false;
          }
        }, 2000);
      }

      function stopPolling(): void {
        if (brokerClientRef.pollInterval) {
          clearInterval(brokerClientRef.pollInterval);
          brokerClientRef.pollInterval = null;
        }
        followerPollRunning = false;
      }

      client.onDisconnect(() => {
        stopPolling();
        setExtStatus(ctx, "reconnecting");
        const uiUpdate = getFollowerReconnectUiUpdate("disconnect", wasDisconnected);
        wasDisconnected = uiUpdate.nextWasDisconnected;
        if (uiUpdate.notify) {
          ctx.ui.notify(uiUpdate.notify.message, uiUpdate.notify.level);
        }
      });

      client.onReconnect(() => {
        void (async () => {
          try {
            await registerFollowerRuntime();
          } catch (err) {
            console.error(
              `[slack-bridge] follower reconnect registration refresh failed: ${msg(err)}`,
            );
            const registration = client.getRegisteredIdentity();
            if (registration) {
              applyRegistrationIdentity(registration);
            }
          }
          await resumeThreadClaims();
          const currentlyIdle = ctx.isIdle?.() ?? true;
          void client.updateStatus(currentlyIdle ? "idle" : "working").catch(() => {
            /* best effort */
          });
          startPolling();
          if (hasDeliveredFollowerInboxIds(followerDeliveryState)) {
            void flushDeliveredFollowerAcks();
          }
          setExtStatus(ctx, "ok");
          const uiUpdate = getFollowerReconnectUiUpdate("reconnect", wasDisconnected);
          wasDisconnected = uiUpdate.nextWasDisconnected;
          if (uiUpdate.notify) {
            ctx.ui.notify(uiUpdate.notify.message, uiUpdate.notify.level);
          }
        })();
      });

      await resumeThreadClaims();
      brokerClient = brokerClientRef;
      brokerRole = "follower";
      pinetEnabled = true;
      startPolling();
      setExtStatus(ctx, "ok");
    } catch (err) {
      await client.unregister().catch(() => {
        /* best effort */
      });
      client.disconnect();
      throw err;
    }
  }

  async function disconnectFollower(
    ctx: ExtensionContext,
  ): Promise<{ unregisterError: string | null }> {
    const current = brokerClient;

    if (current?.pollInterval) {
      clearInterval(current.pollInterval);
      current.pollInterval = null;
    }

    await flushDeliveredFollowerAcks().catch(() => {
      /* best effort */
    });

    let unregisterError: string | null = null;
    if (current) {
      try {
        await current.client.disconnectGracefully();
      } catch (err) {
        unregisterError = msg(err);
      }
    }

    brokerClient = null;
    resetFollowerDeliveryState(followerDeliveryState);
    followerAckPromise = null;
    brokerRole = null;
    pinetEnabled = false;
    setExtStatus(ctx, "off");

    return { unregisterError };
  }

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    resetTopLevelSlackRequests();
    remoteControlState = { currentCommand: null, queuedCommand: null };
    resetPendingRemoteControlAcks();
    suppressAutoDrainUntil = 0;
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    extCtx = ctx;
    const sessionHeader = (
      ctx.sessionManager as { getHeader?: () => { parentSession?: string } | null }
    ).getHeader?.();
    pinetRegistrationBlocked = isLikelyLocalSubagentContext({
      sessionHeader,
      sessionFile: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId(),
      argv: process.argv.slice(2),
      hasUI: ctx.hasUI,
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
    });
    const uiWithTerminalInput = ctx.ui as ExtensionContext["ui"] & {
      onTerminalInput?: (
        handler: (data: string) => { consume?: boolean; data?: string } | undefined,
      ) => () => void;
    };
    if (ctx.hasUI && typeof uiWithTerminalInput.onTerminalInput === "function") {
      terminalInputUnsubscribe = uiWithTerminalInput.onTerminalInput((data: string) => {
        notePotentialInterruptInput(data);
        return undefined;
      });
    }

    // Restore persisted thread state (always restore, even before /pinet)
    interface PersistedState {
      threads?: [string, ThreadInfo][];
      lastDmChannel?: string | null;
      userNames?: [string, string][];
      agentName?: string;
      agentEmoji?: string;
      agentStableId?: string;
      activeSkinTheme?: string | null;
      agentPersonality?: string | null;
      agentAliases?: string[];
      brokerControlPlaneCanvasId?: string | null;
      brokerControlPlaneCanvasChannelId?: string | null;
    }
    try {
      let savedState: PersistedState | null = null;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "slack-bridge-state") {
          savedState = entry.data as PersistedState;
        }
      }

      agentStableId = resolveAgentStableId(
        savedState?.agentStableId,
        ctx.sessionManager.getSessionFile(),
        os.hostname(),
        ctx.cwd,
        ctx.sessionManager.getLeafId(),
      );
      agentOwnerToken = buildPinetOwnerToken(agentStableId);
      const identitySeed = ctx.sessionManager.getSessionFile() ?? agentStableId;
      activeSkinTheme = savedState?.activeSkinTheme ?? null;
      agentPersonality = savedState?.agentPersonality ?? null;
      agentAliases.clear();
      for (const alias of savedState?.agentAliases ?? []) {
        if (alias) {
          agentAliases.add(alias);
        }
      }
      const restoredIdentity = resolvePersistedAgentIdentity(
        settings,
        savedState?.agentName,
        savedState?.agentEmoji,
        process.env.PI_NICKNAME,
        identitySeed,
        brokerRole === "broker" ? "broker" : "worker",
      );
      agentName = restoredIdentity.name;
      agentEmoji = restoredIdentity.emoji;

      if (savedState) {
        if (savedState.threads) {
          for (const [k, v] of savedState.threads) {
            if (!threads.has(k)) threads.set(k, v);
          }
        }
        if (savedState.lastDmChannel && !lastDmChannel) {
          lastDmChannel = savedState.lastDmChannel;
        }
        if (savedState.userNames) {
          for (const [k, v] of savedState.userNames) {
            if (!userNames.has(k)) userNames.set(k, v);
          }
        }
        brokerControlPlaneCanvasRuntimeId =
          normalizeOptionalSetting(savedState.brokerControlPlaneCanvasId) ??
          brokerControlPlaneCanvasRuntimeId;
        brokerControlPlaneCanvasRuntimeChannelId =
          normalizeOptionalSetting(savedState.brokerControlPlaneCanvasChannelId) ??
          brokerControlPlaneCanvasRuntimeChannelId;
      }
      persistStateNow();
    } catch (err) {
      console.error(`[slack-bridge] restore failed: ${msg(err)}`);
    }

    if (pinetRegistrationBlocked) {
      console.log("[slack-bridge] detected local subagent context; skipping Pinet registration");
      setExtStatus(ctx, "off");
      return;
    }

    // Auto-follow: if enabled and broker socket exists, connect as follower
    if (settings.autoFollow && fs.existsSync(DEFAULT_SOCKET_PATH)) {
      try {
        await connectAsFollower(ctx);
        console.log(`[slack-bridge] autoFollow: connected as follower`);
      } catch (err) {
        console.error(`[slack-bridge] autoFollow failed: ${msg(err)}`);
        setExtStatus(ctx, "off");
      }
    } else {
      // Use /pinet-start or /pinet-follow to connect
      setExtStatus(ctx, "off");
    }
  });

  // ─── Agent status reporting ──────────────────────────

  function reportStatus(status: "working" | "idle"): void {
    if (!pinetEnabled) return;
    try {
      if (brokerRole === "broker" && activeBroker && activeSelfId) {
        activeBroker.db.updateAgentStatus(activeSelfId, status);
      } else if (brokerRole === "follower" && brokerClient) {
        brokerClient.client.updateStatus(status).catch(() => {
          /* best effort */
        });
      }
    } catch {
      /* best effort */
    }
  }

  function signalAgentFree(
    ctx?: ExtensionContext,
    options: { requirePinet?: boolean } = {},
  ): { queuedInboxCount: number; drainedQueuedInbox: boolean } {
    if (!pinetEnabled) {
      if (options.requirePinet) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }
      return { queuedInboxCount: inbox.length, drainedQueuedInbox: false };
    }

    reportStatus("idle");
    const maintenanceCtx = ctx ?? extCtx ?? undefined;
    if (brokerRole === "broker" && maintenanceCtx) {
      runBrokerMaintenance(maintenanceCtx);
    }

    const queuedInboxCount = inbox.length;
    const drainedQueuedInbox = queuedInboxCount > 0 && (ctx ? maybeDrainInboxIfIdle(ctx) : false);

    return { queuedInboxCount, drainedQueuedInbox };
  }

  function deliverFollowUpMessage(text: string): boolean {
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
      return true;
    } catch {
      try {
        pi.sendUserMessage(text);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function flushDeliveredFollowerAcks(): Promise<void> {
    if (followerAckPromise) {
      await followerAckPromise;
      return;
    }
    if (brokerRole !== "follower" || !brokerClient?.client) return;

    const client = brokerClient.client;
    const promise = drainFollowerAckBatches(followerDeliveryState, async (ids) => {
      await client.ackMessages(ids);
    }).finally(() => {
      if (followerAckPromise === promise) {
        followerAckPromise = null;
      }
    });

    followerAckPromise = promise;
    await promise;
  }

  // Drain inbox: set thinking status, send to agent
  function drainInbox(): void {
    if (inbox.length === 0) return;

    const pending = inbox.splice(0, inbox.length);
    const brokerInboxIds = getBrokerInboxIds(pending);
    updateBadge();
    reportStatus("working");

    let prompt = formatInboxMessages(pending, userNames);

    // Prepend security guardrails if configured
    if (securityPrompt) {
      prompt = securityPrompt + "\n\n" + prompt;
    }

    if (
      deliverTrackedSlackFollowUpMessage({
        queue: pendingSlackToolPolicyTurns,
        prompt,
        messages: pending,
        deliver: deliverFollowUpMessage,
      })
    ) {
      if (brokerInboxIds.length > 0) {
        if (brokerRole === "follower") {
          markFollowerInboxIdsDelivered(followerDeliveryState, brokerInboxIds);
          void flushDeliveredFollowerAcks();
        } else if (brokerRole === "broker" && activeBroker && activeSelfId) {
          try {
            activeBroker.db.markDelivered(brokerInboxIds, activeSelfId);
            markBrokerInboxIdsHandled(brokerDeliveryState, brokerInboxIds);
          } catch {
            /* best effort */
          }
        }
      }
      return;
    }

    inbox.push(...pending);
    updateBadge();
  }

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      return;
    }

    nextSlackToolPolicyTurn = consumePendingSlackToolPolicyTurn(
      pendingSlackToolPolicyTurns,
      event.text,
    );
  });

  pi.on("turn_start", async () => {
    activeSlackToolPolicyTurn = nextSlackToolPolicyTurn;
    nextSlackToolPolicyTurn = null;
  });

  pi.on("turn_end", async () => {
    activeSlackToolPolicyTurn = null;
  });

  pi.on("agent_end", async () => {
    activeSlackToolPolicyTurn = null;
  });

  // Hard-block forbidden tools when broker role is active.
  // Also hard-enforce Slack-origin guardrails for core built-in tools.
  pi.on("tool_call", async (event) => {
    if (brokerRole === "broker" && isBrokerForbiddenTool(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is forbidden for the broker role. The broker coordinates — it does not code. Use pinet_message to delegate to a connected worker instead.`,
      };
    }

    return evaluateSlackOriginCoreToolPolicy({
      turn: activeSlackToolPolicyTurn,
      toolName: event.toolName,
      input: event.input,
      guardrails,
      requireToolPolicy,
      formatAction: formatConfirmationAction,
      formatError: msg,
    });
  });

  // Inject dynamic identity guidance every turn so reload/session restore keeps prompts in sync.
  pi.on("before_agent_start", async (event) => {
    const guidelines = [
      ...getIdentityGuidelines(),
      ...buildAgentPersonalityGuidelines(agentName),
      ...buildReactionPromptGuidelines(),
    ];
    const skinGuideline = buildPinetSkinPromptGuideline(activeSkinTheme, agentPersonality);
    if (skinGuideline) {
      guidelines.push(skinGuideline);
    }
    if (brokerRole === "broker") {
      guidelines.push(...buildBrokerPromptGuidelines(agentEmoji, agentName));
      guidelines.push(buildBrokerToolGuardrailsPrompt());
    } else if (brokerRole === "follower") {
      guidelines.push(...buildWorkerPromptGuidelines());
    }
    return {
      systemPrompt: event.systemPrompt + "\n\n" + guidelines.join("\n"),
    };
  });

  // When agent finishes: clear thinking status, mark free, and auto-drain inbox
  pi.on("agent_end", async (_event, ctx) => {
    for (const ts of thinking) {
      const thread = threads.get(ts);
      if (thread) await clearThreadStatus(thread.channelId, ts);
    }
    thinking.clear();
    ralphLoopState.followUpPending = false;

    signalAgentFree(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    remoteControlState = { currentCommand: null, queuedCommand: null };
    resetPendingRemoteControlAcks();
    terminalInputUnsubscribe?.();
    terminalInputUnsubscribe = null;
    suppressAutoDrainUntil = 0;
    await stopPinetRuntime(ctx, { releaseIdentity: true });
    pinetRegistrationBlocked = false;
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
