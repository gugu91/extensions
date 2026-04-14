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
  getSlackUserAccessWarning,
  isUserAllowed as checkUserAllowed,
  formatInboxMessages,
  buildPinetSkinAssignment,
  buildPinetSkinMetadata,
  buildPinetSkinPromptGuideline,
  normalizeOutgoingPinetControlMessage,
  queuePinetRemoteControl,
  finishPinetRemoteControl,
  reloadPinetRuntimeSafely,
  type PinetControlCommand,
  type PinetRemoteControlState,
  formatAgentList,
  callSlackAPI,
  createAbortableOperationTracker,
  isAbortError,
  buildAgentDisplayInfo,
  filterAgentsForMeshVisibility,
  rankAgentsForRouting,
  evaluateRalphLoopCycle,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  agentOwnsThread,
  buildPinetOwnerToken,
  resolveAgentIdentity,
  resolvePersistedAgentIdentity,
  resolveRuntimeAgentIdentity,
  resolveBrokerStableId,
  shortenPath,
  buildIdentityReplyGuidelines,
  buildAgentPersonalityGuidelines,
  buildBrokerPromptGuidelines,
  buildWorkerPromptGuidelines,
  DEFAULT_PINET_SKIN_THEME,
  normalizePinetSkinTheme,
  resolveAgentStableId,
  isLikelyLocalSubagentContext,
  resolveAllowAllWorkspaceUsers,
  resolvePinetMeshAuth,
  syncBrokerInboxEntries,
  resolveFollowerThreadChannel,
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
import { TtlCache, TtlSet } from "./ttl-cache.js";
import {
  buildReactionPromptGuidelines,
  buildReactionTriggerMessage,
  normalizeReactionName,
  resolveReactionCommands,
} from "./reaction-triggers.js";
import { startBroker, type Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { sendBrokerMessage } from "./broker/message-send.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { MessageRouter } from "./broker/router.js";
import {
  DEFAULT_BROKER_MAINTENANCE_INTERVAL_MS,
  DEFAULT_BUSY_ASSIGNMENT_AGE_MS,
  runBrokerMaintenancePass,
  type BrokerMaintenanceResult,
} from "./broker/maintenance.js";
import { DEFAULT_SOCKET_PATH, HEARTBEAT_INTERVAL_MS, type BrokerClient } from "./broker/client.js";
import {
  dispatchBroadcastAgentMessage,
  dispatchDirectAgentMessage,
  isBroadcastChannelTarget,
} from "./broker/agent-messaging.js";
import { registerSlackTools } from "./slack-tools.js";
import { registerPinetCommands } from "./pinet-commands.js";
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
  getDefaultIMessageThreadId,
  normalizeIMessageRecipient,
} from "@gugu910/pi-imessage-bridge";
import {
  type RalphLoopDeps,
  createRalphLoopState,
  resetRalphLoopState,
  startRalphLoop,
  stopRalphLoop,
} from "./ralph-loop.js";
import {
  addSlackReaction,
  classifyMessage,
  clearSlackThreadStatus,
  fetchSlackMessageByTs as fetchSlackMessageByTsFromSlack,
  removeSlackReaction,
  resolveSlackChannelId,
  resolveSlackThreadOwnerHint,
  resolveSlackUserName,
  setSlackSuggestedPrompts,
  SlackSocketModeClient,
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  type ParsedAppHomeOpened,
  type ParsedThreadContextChanged,
  type ParsedThreadStarted,
} from "./slack-access.js";
import {
  createFollowerDeliveryState,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
} from "./follower-delivery.js";
import { createFollowerRuntime, type BrokerClientRef } from "./follower-runtime.js";
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
import {
  type SlackBridgeRuntimeMode,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";

// Settings and helpers imported from ./helpers.js

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

  // allowedUsers / allowAllWorkspaceUsers: settings.json takes priority, env vars as fallback
  let allowedUsers = buildAllowlist(
    settings,
    process.env.SLACK_ALLOWED_USERS,
    process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
  );
  let reactionCommands = resolveReactionCommands(settings.reactionCommands);

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(allowedUsers, userId);
  }

  let lastSlackUserAccessWarning = "";

  function maybeWarnSlackUserAccess(ctx?: ExtensionContext): void {
    const warning = getSlackUserAccessWarning(allowedUsers);
    if (!warning) {
      lastSlackUserAccessWarning = "";
      return;
    }
    if (warning === lastSlackUserAccessWarning) {
      return;
    }
    lastSlackUserAccessWarning = warning;
    console.warn(`[slack-bridge] ${warning}`);
    ctx?.ui.notify(warning, "warning");
  }

  const initialIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, process.cwd());
  let agentName = initialIdentity.name;
  let agentEmoji = initialIdentity.emoji;
  let agentStableId = resolveAgentStableId(undefined, undefined, os.hostname(), process.cwd());
  let brokerStableId = resolveBrokerStableId(undefined, os.hostname(), process.cwd());
  let agentOwnerToken = buildPinetOwnerToken(agentStableId);
  let activeSkinTheme: string | null = null;
  let agentPersonality: string | null = null;
  const agentAliases = new Set<string>();
  const PINET_SKIN_SETTING_KEY = "pinet.skinTheme";
  const PINET_BROKER_STABLE_ID_SETTING_KEY = "pinet.brokerStableId";

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

  function getStableIdForRole(role: "broker" | "worker"): string {
    return role === "broker" ? brokerStableId : agentStableId;
  }

  function getIdentitySeedForRole(
    role: "broker" | "worker",
    sessionFile = extCtx?.sessionManager.getSessionFile() ?? undefined,
  ): string {
    return role === "broker" ? brokerStableId : (sessionFile ?? agentStableId);
  }

  function getSkinSeed(preferredSeed?: string): string {
    return (
      preferredSeed?.trim() || getStableIdForRole(brokerRole === "broker" ? "broker" : "worker")
    );
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
    allowedUsers = buildAllowlist(
      settings,
      process.env.SLACK_ALLOWED_USERS,
      process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
    );
    guardrails = settings.security ?? {};
    reactionCommands = resolveReactionCommands(settings.reactionCommands);
    securityPrompt = buildSecurityPrompt(guardrails);
    const role = brokerRole === "broker" ? "broker" : "worker";
    const identitySeed = getIdentitySeedForRole(role);
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
    agentOwnerToken = buildPinetOwnerToken(
      getStableIdForRole(brokerRole === "broker" ? "broker" : "worker"),
    );
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
    source?: string;
    context?: { channelId: string; teamId: string };
    owner?: string; // agent name that claimed this thread (first-responder-wins)
  }

  let botUserId: string | null = null;
  let singleRuntimeSlackSocket: SlackSocketModeClient | null = null;
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
        brokerStableId,
        lastPinetRole: brokerRole === "broker" ? "broker" : "worker",
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
    await addSlackReaction({
      slack,
      token: botToken!,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  async function removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await removeSlackReaction({
      slack,
      token: botToken!,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  async function resolveUser(userId: string): Promise<string> {
    const hadCachedUser = userNames.get(userId) != null;
    const name = await resolveSlackUserName({
      slack,
      token: botToken!,
      userId,
      cache: userNames,
      shouldUseResult: () => !shuttingDown,
    });
    if (!hadCachedUser && userNames.get(userId) != null) {
      persistState();
    }
    return name;
  }

  async function resolveChannel(nameOrId: string): Promise<string> {
    return resolveSlackChannelId({
      slack,
      token: botToken!,
      nameOrId,
      cache: channelCache,
    });
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
    await clearSlackThreadStatus({
      slack,
      token: botToken!,
      channelId,
      threadTs,
    });
  }

  async function setSuggestedPrompts(channelId: string, threadTs: string): Promise<void> {
    const prompts = settings.suggestedPrompts ?? [
      { title: "Status", message: `Hey ${agentName}, what are you working on right now?` },
      { title: "Help", message: `${agentName}, I need help with something in the codebase` },
      { title: "Review", message: `${agentName}, summarise the recent changes` },
    ];
    await setSlackSuggestedPrompts({
      slack,
      token: botToken!,
      channelId,
      threadTs,
      prompts,
    });
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
    const hint = await resolveSlackThreadOwnerHint({
      slack,
      token: botToken!,
      channel,
      threadTs,
      limit: 50,
    });
    return hint?.agentOwner ?? hint?.agentName ?? null;
  }

  // ─── Socket Mode (native WebSocket) ─────────────────

  async function connectSocketMode(ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    singleRuntimeSlackSocket = new SlackSocketModeClient({
      slack,
      botToken: botToken!,
      appToken: appToken!,
      resolveBotUserIdOnConnect: false,
      dedup: processedSlackSocketDeliveries,
      abortAndWait: () => slackRequests.abortAndWait(),
      onOpen: () => setExtStatus(ctx, "ok"),
      onReconnectScheduled: () => {
        if (!shuttingDown && currentRuntimeMode === "single") {
          setExtStatus(ctx, "reconnecting");
        }
      },
      onError: (err) => {
        if (!isAbortError(err)) {
          console.error(`[slack-bridge] Slack access: ${msg(err)}`);
        }
      },
      onThreadStarted: (event) => onThreadStarted(event),
      onThreadContextChanged: (event) => onContextChanged(event),
      onAppHomeOpened: (event) => onAppHomeOpened(event, ctx),
      onMessage: (event) => onMessage(event, ctx),
      onReactionAdded: (event) => onReactionAdded(event, ctx),
      onMemberJoinedChannel: async ({ channel, isSelf }) => {
        if (!isSelf) return;
        ctx.ui.notify(`Pinet added to channel ${channel}`, "info");
        inbox.push({
          channel,
          threadTs: "",
          userId: "system",
          text: `Pinet was added to channel <#${channel}>. You can now post messages there.`,
          timestamp: String(Date.now() / 1000),
        });
        updateBadge();
        maybeDrainInboxIfIdle(ctx);
      },
      onInteractive: (event) => queueInteractiveInboxEvent(event, ctx),
    });
    await singleRuntimeSlackSocket.connect();
    botUserId = singleRuntimeSlackSocket?.getBotUserId() ?? botUserId;
  }

  // ─── Assistant events ───────────────────────────────

  async function onThreadStarted(event: ParsedThreadStarted): Promise<void> {
    if (shuttingDown) return;

    const info: ThreadInfo = {
      channelId: event.channelId,
      threadTs: event.threadTs,
      userId: event.userId,
      source: "slack",
    };

    if (event.context) {
      info.context = event.context;
    }

    threads.set(info.threadTs, info);
    lastDmChannel = info.channelId;
    persistState();

    await setSuggestedPrompts(info.channelId, info.threadTs);
  }

  function onContextChanged(event: ParsedThreadContextChanged): void {
    if (shuttingDown) return;

    const existing = threads.get(event.threadTs);
    if (!existing || !event.context) return;

    existing.context = event.context;
    persistState();
  }

  async function onAppHomeOpened(event: ParsedAppHomeOpened, ctx: ExtensionContext): Promise<void> {
    if (shuttingDown) return;

    await publishCurrentPinetHomeTabSafely(event.userId, ctx);
  }

  async function fetchSlackMessageByTs(
    channel: string,
    messageTs: string,
  ): Promise<Record<string, unknown> | null> {
    return fetchSlackMessageByTsFromSlack({
      slack,
      token: botToken!,
      channel,
      messageTs,
    });
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
          source: "slack",
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

    const classified = classifyMessage(evt, botUserId, new Set(threads.keys()));
    if (!classified.relevant) return;

    const { threadTs, channel, userId, text, isDM, isChannelMention, messageTs } = classified;

    if (!threads.has(threadTs)) {
      threads.set(threadTs, { channelId: channel, threadTs, userId, source: "slack" });
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
      const remoteOwner = await resolveThreadOwner(channel, threadTs);
      if (shuttingDown) return;
      if (remoteOwner && !agentOwnsThread(remoteOwner, agentName, agentAliases, agentOwnerToken)) {
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

    if (!isUserAllowed(userId)) {
      await slack("chat.postMessage", botToken!, {
        channel,
        thread_ts: threadTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    if (isDM) {
      lastDmChannel = channel;
    }
    persistState();

    const confirmationResult = consumeConfirmationReply(threadTs, text);
    const messageText =
      confirmationResult === null
        ? text
        : confirmationResult.approved
          ? `${text}\n\n✅ User approved security confirmation request in this thread.`
          : `${text}\n\n❌ User denied security confirmation request in this thread.`;

    const name = await resolveUser(userId);
    if (shuttingDown) return;
    ctx.ui.notify(`${name}: ${text.slice(0, 100)}`, "info");

    void addReaction(channel, messageTs, "eyes");
    const pending = pendingEyes.get(threadTs) ?? [];
    pending.push({ channel, messageTs });
    pendingEyes.set(threadTs, pending);

    inbox.push({
      channel,
      threadTs,
      userId,
      text: messageText,
      timestamp: messageTs,
      ...(isChannelMention && { isChannelMention: true }),
    });
    updateBadge();

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
        source: "slack",
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

  // ─── Reconnect / status ─────────────────────────────

  async function disconnect(): Promise<void> {
    shuttingDown = true;
    const socket = singleRuntimeSlackSocket;
    singleRuntimeSlackSocket = null;
    if (socket) {
      await socket.disconnect();
      return;
    }
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

  function trackOwnedThread(threadTs: string, channelId: string, source = "slack"): void {
    if (!threads.has(threadTs)) {
      threads.set(threadTs, {
        channelId,
        threadTs,
        userId: "",
        source,
        owner: agentOwnerToken,
      });
    } else {
      const thread = threads.get(threadTs)!;
      if (!thread.owner) thread.owner = agentOwnerToken;
      if (!thread.source) {
        thread.source = source;
      }
    }
    unclaimedThreads.delete(threadTs);
    persistState();
  }

  function claimOwnedThread(threadTs: string, channelId: string, source = "slack"): void {
    if (brokerRole === "broker" && activeRouter && activeSelfId) {
      activeRouter.claimThread(threadTs, activeSelfId, channelId, source);
    } else if (brokerRole === "follower" && brokerClient?.client) {
      void brokerClient.client.claimThread(threadTs, channelId, source).catch(() => {
        /* broker gone, best effort */
      });
    }
  }

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
      trackOwnedThread(threadTs, channelId, "slack");
    },
    getBotUserId: () => botUserId,
    claimThreadOwnership: (threadTs, channelId) => {
      claimOwnedThread(threadTs, channelId, "slack");
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
  let currentRuntimeMode: SlackBridgeRuntimeMode = "off";
  let brokerRole: "broker" | "follower" | null = null;
  let pinetRegistrationBlocked = false;
  let activeBroker: Broker | null = null;
  let brokerClient: BrokerClientRef | null = null;
  const followerDeliveryState = createFollowerDeliveryState();
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
  let desiredAgentStatus: "working" | "idle" = "idle";

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
        connected:
          currentRuntimeMode === "broker"
            ? activeBroker != null
            : currentRuntimeMode === "follower"
              ? brokerClient != null
              : currentRuntimeMode === "single"
                ? (singleRuntimeSlackSocket?.isConnected() ?? false)
                : false,
        mode: currentRuntimeMode,
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

  async function transitionToRuntimeMode(
    ctx: ExtensionContext,
    mode: SlackBridgeRuntimeMode,
  ): Promise<void> {
    if (currentRuntimeMode === mode) {
      if (mode === "off") {
        setExtStatus(ctx, "off");
      }
      return;
    }

    if (currentRuntimeMode !== "off") {
      await stopPinetRuntime(ctx, { releaseIdentity: true });
      // Runtime transitions keep the extension alive in-process, so restore a
      // fresh top-level Slack request tracker after tearing the prior runtime down.
      resetTopLevelSlackRequests();
      shuttingDown = false;
    }

    if (mode === "off") {
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
      return;
    }

    if (mode === "single") {
      currentRuntimeMode = "single";
      setExtStatus(ctx, "reconnecting");
      await connectSocketMode(ctx);
      return;
    }

    if (mode === "broker") {
      await connectAsBroker(ctx);
      return;
    }

    await connectAsFollower(ctx);
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
        await followerRuntime.disconnect(ctx, { releaseIdentity: false }).catch(() => {
          /* best effort */
        });
        brokerClient = null;
        desiredAgentStatus = "idle";
        brokerRole = null;
        pinetEnabled = false;
      }
    }

    await disconnect();
    activityLogger.clearPending();
    brokerRole = null;
    pinetEnabled = false;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "off";
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
      const result = await signalAgentFree(undefined, { requirePinet: true });
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

      const toDisplay = (agent: {
        emoji: string;
        name: string;
        id: string;
        pid?: number;
        status: "working" | "idle";
        metadata: Record<string, unknown> | null;
        lastHeartbeat: string;
        lastSeen?: string;
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
        lastSeen?: string;
        disconnectedAt?: string | null;
        resumableUntil?: string | null;
      }>;
      if (brokerRole === "broker" && activeBroker) {
        rawAgents = filterAgentsForMeshVisibility(activeBroker.db.getAllAgents(), {
          now: nowMs,
          includeGhosts,
          recentDisconnectWindowMs: recentGhostWindowMs,
        }).map((agent) => ({
          emoji: agent.emoji,
          name: agent.name,
          id: agent.id,
          pid: agent.pid,
          status: agent.status,
          metadata: agent.metadata,
          lastHeartbeat: agent.lastHeartbeat,
          lastSeen: agent.lastSeen,
          disconnectedAt: agent.disconnectedAt,
          resumableUntil: agent.resumableUntil,
        }));
      } else if (brokerRole === "follower" && brokerClient) {
        rawAgents = filterAgentsForMeshVisibility(
          await brokerClient.client.listAgents(includeGhosts),
          {
            now: nowMs,
            includeGhosts,
            recentDisconnectWindowMs: recentGhostWindowMs,
          },
        ).map((agent) => ({
          emoji: agent.emoji,
          name: agent.name,
          id: agent.id,
          pid: agent.pid,
          status: agent.status ?? "idle",
          metadata: agent.metadata,
          lastHeartbeat: agent.lastHeartbeat,
          lastSeen: agent.lastSeen,
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

  pi.registerTool({
    name: "imessage_send",
    label: "iMessage Send",
    description:
      "Send a message through the local send-first iMessage adapter on the active broker.",
    promptSnippet:
      "Send a message through the local send-first iMessage adapter on the active Pinet broker. Use when a task needs a narrow macOS iMessage send path.",
    parameters: Type.Object({
      to: Type.String({
        description: "Recipient handle, phone number, email, or local chat identifier",
      }),
      text: Type.String({ description: "Message body" }),
      thread_id: Type.Optional(
        Type.String({
          description:
            "Optional transport thread id. Defaults to a stable iMessage thread id derived from the recipient.",
        }),
      ),
    }),
    async execute(_id, params) {
      requireToolPolicy(
        "imessage_send",
        undefined,
        `to=${params.to} | thread_id=${params.thread_id ?? ""} | text=${params.text}`,
      );

      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      const recipient = normalizeIMessageRecipient(params.to);
      const text = params.text.trim();
      if (!text) {
        throw new Error("text is required");
      }
      const threadId = params.thread_id?.trim() || getDefaultIMessageThreadId(recipient);
      const metadata = { recipient };

      let adapter = "imessage";
      let messageId: number | null = null;

      if (brokerRole === "broker" && activeBroker && activeSelfId) {
        if (!activeBroker.adapters.some((candidate) => candidate.name === "imessage")) {
          throw new Error(
            "iMessage adapter is not enabled or not ready on the active broker. Set slack-bridge.imessage.enabled: true and restart /pinet-start.",
          );
        }

        const result = await sendBrokerMessage(
          {
            db: activeBroker.db,
            adapters: activeBroker.adapters,
          },
          {
            threadId,
            body: text,
            senderAgentId: activeSelfId,
            source: "imessage",
            channel: recipient,
            agentName,
            agentEmoji,
            agentOwnerToken,
            metadata,
          },
        );
        adapter = result.adapter;
        messageId = result.message.id;
      } else if (brokerRole === "follower" && brokerClient?.client) {
        const result = await brokerClient.client.sendMessage({
          threadId,
          body: text,
          source: "imessage",
          channel: recipient,
          agentName,
          agentEmoji,
          agentOwnerToken,
          metadata,
        });
        adapter = result.adapter;
        messageId = result.messageId;
      } else {
        throw new Error("Pinet is in an unexpected state.");
      }

      trackOwnedThread(threadId, recipient, "imessage");

      return {
        content: [
          {
            type: "text",
            text: `Sent iMessage to ${recipient} (thread_id: ${threadId}).`,
          },
        ],
        details: {
          threadId,
          channel: recipient,
          source: "imessage",
          adapter,
          messageId,
        },
      };
    },
  });

  // ─── Commands ───────────────────────────────────────

  async function connectAsBroker(ctx: ExtensionContext): Promise<void> {
    refreshSettings();
    maybeWarnSlackUserAccess(ctx);
    const meshAuth = resolvePinetMeshAuth(settings);
    const broker = await startBroker({
      ...(meshAuth.meshSecret ? { meshSecret: meshAuth.meshSecret } : {}),
      ...(meshAuth.meshSecretPath ? { meshSecretPath: meshAuth.meshSecretPath } : {}),
    });
    const adapter = new SlackAdapter({
      botToken: botToken!,
      appToken: appToken!,
      allowedUsers: allowedUsers ? [...allowedUsers] : undefined,
      allowAllWorkspaceUsers: resolveAllowAllWorkspaceUsers(
        settings,
        process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS,
      ),
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
      broker.db.setAllowedUsers(allowedUsers);
      const router = new MessageRouter(broker.db);
      activeSkinTheme =
        broker.db.getSetting<string>(PINET_SKIN_SETTING_KEY) ?? DEFAULT_PINET_SKIN_THEME;
      broker.db.setSetting(PINET_SKIN_SETTING_KEY, activeSkinTheme);

      const persistedBrokerStableId =
        normalizeOptionalSetting(
          broker.db.getSetting<string>(PINET_BROKER_STABLE_ID_SETTING_KEY),
        ) ??
        broker.db
          .getAllAgents()
          .flatMap((agent) => {
            const stableId = normalizeOptionalSetting(agent.stableId);
            if (!stableId) {
              return [];
            }
            if (getMeshRoleFromMetadata(agent.metadata ?? undefined, "worker") !== "broker") {
              return [];
            }
            const lastSeenMs = Date.parse(agent.lastSeen);
            const connectedAtMs = Date.parse(agent.connectedAt);
            const recencyMs = Number.isNaN(lastSeenMs)
              ? Number.isNaN(connectedAtMs)
                ? 0
                : connectedAtMs
              : lastSeenMs;
            return [{ stableId, recencyMs }];
          })
          .sort((left, right) => right.recencyMs - left.recencyMs)[0]?.stableId ??
        null;
      brokerStableId = persistedBrokerStableId ?? brokerStableId;
      broker.db.setSetting(PINET_BROKER_STABLE_ID_SETTING_KEY, brokerStableId);
      agentOwnerToken = buildPinetOwnerToken(brokerStableId);
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
        seed: brokerStableId,
      });
      const selfAgent = broker.db.registerAgent(
        ctx.sessionManager.getLeafId() ?? `broker-${process.pid}`,
        selfAssignment.name,
        selfAssignment.emoji,
        process.pid,
        buildSkinMetadata(await getAgentMetadata("broker"), selfAssignment.personality),
        brokerStableId,
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
        return resolveSlackThreadOwnerHint({
          slack,
          token: botToken!,
          channel,
          threadTs,
          cache: brokerThreadOwnerHintCache,
        });
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

      if (settings.imessage?.enabled) {
        const environment = detectIMessageMvpEnvironment();
        const readinessSummary = formatIMessageMvpReadiness(environment).join(" | ");

        if (!environment.canAttemptSend) {
          ctx.ui.notify(`iMessage adapter unavailable — ${readinessSummary}`, "warning");
          logBrokerActivity({
            kind: "transport_readiness",
            level: "actions",
            title: "iMessage adapter unavailable",
            summary: readinessSummary,
            tone: "warning",
          });
        } else {
          try {
            const imessageAdapter = createIMessageAdapter();
            await imessageAdapter.connect();
            broker.addAdapter(imessageAdapter);

            if (environment.blockers.length > 0) {
              ctx.ui.notify(`iMessage send-first mode enabled — ${readinessSummary}`, "warning");
              logBrokerActivity({
                kind: "transport_readiness",
                level: "actions",
                title: "iMessage send-first mode enabled",
                summary: readinessSummary,
                tone: "warning",
              });
            }
          } catch (err) {
            ctx.ui.notify(`iMessage adapter failed to start: ${msg(err)}`, "warning");
            logBrokerActivity({
              kind: "transport_readiness",
              level: "errors",
              title: "iMessage adapter failed to start",
              summary: msg(err),
              tone: "error",
            });
          }
        }
      }

      broker.server.setOutboundMessageAdapters?.(broker.adapters);

      activeBroker = broker;
      activeRouter = router;
      activeSelfId = selfId;
      brokerRole = "broker";
      pinetEnabled = true;
      desiredAgentStatus = "idle";
      currentRuntimeMode = "broker";

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

  const followerRuntime = createFollowerRuntime({
    getSettings: () => settings,
    refreshSettings,
    getPinetEnabled: () => pinetEnabled,
    getAgentIdentity: () => ({ name: agentName, emoji: agentEmoji }),
    getAgentStableId: () => agentStableId,
    getAgentOwnerToken: () => agentOwnerToken,
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getDesiredAgentStatus: () => desiredAgentStatus,
    getAgentAliases: () => agentAliases,
    getThreads: () => threads,
    getLastDmChannel: () => lastDmChannel,
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    getAgentMetadata,
    applyRegistrationIdentity,
    applySkinUpdate: (update) => {
      activeSkinTheme = update.theme;
      applyLocalAgentIdentity(update.name, update.emoji, update.personality);
    },
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    requestRemoteControl,
    deferControlAck: deferFollowerControlAck,
    runRemoteControl,
    deliverFollowUpMessage,
    setExtStatus,
    handleTerminalReconnectFailure: async (ctx, error) => {
      console.error(`[slack-bridge] follower reconnect failed: ${msg(error)}`);
      await disconnectFollower(ctx, { preserveErrorState: true }).catch(() => {
        /* best effort */
      });
      setExtStatus(ctx, "error");
      ctx.ui.notify(
        `Pinet reconnect stopped: ${msg(error)} Update slack-bridge.agentName/agentEmoji or PI_NICKNAME, or clear the explicit identity request, then run /pinet-follow to retry.`,
        "error",
      );
    },
    formatError: msg,
    deliveryState: followerDeliveryState,
  });

  registerPinetCommands(pi, {
    pinetEnabled: () => pinetEnabled,
    pinetRegistrationBlocked: () => pinetRegistrationBlocked,
    runtimeMode: () => currentRuntimeMode,
    runtimeConnected: () =>
      currentRuntimeMode === "broker"
        ? activeBroker != null
        : currentRuntimeMode === "follower"
          ? brokerClient != null
          : currentRuntimeMode === "single"
            ? (singleRuntimeSlackSocket?.isConnected() ?? false)
            : false,
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
    connectAsBroker: (ctx) => transitionToRuntimeMode(ctx, "broker"),
    connectAsFollower: (ctx) => transitionToRuntimeMode(ctx, "follower"),
    reloadPinetRuntime,
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

    const clientRef = await followerRuntime.connect(ctx);
    brokerClient = clientRef;
    brokerRole = "follower";
    pinetEnabled = true;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "follower";
    setExtStatus(ctx, "ok");
  }

  async function disconnectFollower(
    ctx: ExtensionContext,
    options: { preserveErrorState?: boolean } = {},
  ): Promise<{ unregisterError: string | null }> {
    const result = await followerRuntime.disconnect(ctx);
    brokerClient = null;
    desiredAgentStatus = "idle";
    brokerRole = null;
    pinetEnabled = false;
    currentRuntimeMode = "off";
    if (!options.preserveErrorState) {
      setExtStatus(ctx, "off");
    }

    return result;
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
      brokerStableId?: string;
      lastPinetRole?: "broker" | "worker";
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

      const restoredRole = savedState?.lastPinetRole === "broker" ? "broker" : "worker";
      agentStableId = resolveAgentStableId(
        savedState?.agentStableId,
        ctx.sessionManager.getSessionFile(),
        os.hostname(),
        ctx.cwd,
        ctx.sessionManager.getLeafId(),
      );
      brokerStableId = resolveBrokerStableId(savedState?.brokerStableId, os.hostname(), ctx.cwd);
      agentOwnerToken = buildPinetOwnerToken(getStableIdForRole(restoredRole));
      const identitySeed = getIdentitySeedForRole(
        restoredRole,
        ctx.sessionManager.getSessionFile() ?? undefined,
      );
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
        restoredRole,
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
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
      return;
    }

    refreshSettings();
    maybeWarnSlackUserAccess(ctx);
    const startupMode = resolveSlackBridgeStartupRuntimeMode(settings, {
      brokerSocketExists: fs.existsSync(DEFAULT_SOCKET_PATH),
    });

    try {
      await transitionToRuntimeMode(ctx, startupMode);
      if (startupMode === "single") {
        console.log("[slack-bridge] runtime mode: single");
      } else if (startupMode === "follower") {
        console.log("[slack-bridge] runtime mode: follower");
      } else if (startupMode === "broker") {
        console.log("[slack-bridge] runtime mode: broker");
      }
    } catch (err) {
      console.error(`[slack-bridge] runtime start (${startupMode}) failed: ${msg(err)}`);
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
    }
  });

  // ─── Agent status reporting ──────────────────────────

  async function syncDesiredAgentStatus(options: { force?: boolean } = {}): Promise<void> {
    if (!pinetEnabled) {
      return;
    }

    if (brokerRole === "broker" && activeBroker && activeSelfId) {
      activeBroker.db.updateAgentStatus(activeSelfId, desiredAgentStatus);
      return;
    }

    if (brokerRole === "follower" && brokerClient) {
      await followerRuntime.syncDesiredStatus(desiredAgentStatus, options);
    }
  }

  async function reportStatus(status: "working" | "idle"): Promise<void> {
    desiredAgentStatus = status;
    await syncDesiredAgentStatus();
  }

  async function signalAgentFree(
    ctx?: ExtensionContext,
    options: { requirePinet?: boolean } = {},
  ): Promise<{ queuedInboxCount: number; drainedQueuedInbox: boolean }> {
    if (!pinetEnabled && options.requirePinet) {
      throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
    }

    const maintenanceCtx = ctx ?? extCtx ?? undefined;
    if (pinetEnabled) {
      await reportStatus("idle");
      if (brokerRole === "broker" && maintenanceCtx) {
        runBrokerMaintenance(maintenanceCtx);
      }
    }

    const queuedInboxCount = inbox.length;
    const shouldDrainQueuedInbox = pinetEnabled || currentRuntimeMode === "single";
    const drainedQueuedInbox =
      shouldDrainQueuedInbox && queuedInboxCount > 0 && maintenanceCtx
        ? maybeDrainInboxIfIdle(maintenanceCtx)
        : false;

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
    if (brokerRole !== "follower" || !brokerClient?.client) return;
    await followerRuntime.flushDeliveredAcks();
  }

  // Drain inbox: set thinking status, send to agent
  function drainInbox(): void {
    if (inbox.length === 0) return;

    const pending = inbox.splice(0, inbox.length);
    const brokerInboxIds = getBrokerInboxIds(pending);
    updateBadge();
    void reportStatus("working").catch(() => {
      /* best effort */
    });

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

    try {
      await signalAgentFree(ctx);
    } catch (err) {
      ctx.ui.notify(`Pinet auto-free failed: ${msg(err)}`, "warning");
    }
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
