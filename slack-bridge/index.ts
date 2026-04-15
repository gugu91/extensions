import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createGitContextCache, probeGitBranch, probeGitContext } from "./git-metadata.js";
import {
  type InboxMessage,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  getSlackUserAccessWarning,
  isUserAllowed as checkUserAllowed,
  formatInboxMessages,
  buildPinetSkinAssignment,
  buildPinetSkinPromptGuideline,
  reloadPinetRuntimeSafely,
  callSlackAPI,
  createAbortableOperationTracker,
  buildPinetOwnerToken,
  resolveAgentIdentity,
  resolveRuntimeAgentIdentity,
  resolveBrokerStableId,
  shortenPath,
  buildIdentityReplyGuidelines,
  buildAgentPersonalityGuidelines,
  buildBrokerPromptGuidelines,
  buildWorkerPromptGuidelines,
  resolveAgentStableId,
  isLikelyLocalSubagentContext,
  resolveAllowAllWorkspaceUsers,
  normalizeOwnedThreads,
  trackBrokerInboundThread,
} from "./helpers.js";
import {
  buildSecurityPrompt,
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
import { buildReactionPromptGuidelines, resolveReactionCommands } from "./reaction-triggers.js";
import type { Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { DEFAULT_SOCKET_PATH } from "./broker/client.js";
import { dispatchDirectAgentMessage } from "./broker/agent-messaging.js";
import { registerSlackTools } from "./slack-tools.js";
import { registerPinetCommands } from "./pinet-commands.js";
import { registerPinetTools } from "./pinet-tools.js";
import { registerIMessageTools } from "./imessage-tools.js";
import { createSlackRuntimeAccess } from "./slack-runtime-access.js";
import { createThreadConfirmationPolicy } from "./thread-confirmations.js";
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
} from "@gugu910/pi-imessage-bridge";
import {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "./slack-access.js";
import {
  createFollowerDeliveryState,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
} from "./follower-delivery.js";
import { createFollowerRuntime, type BrokerClientRef } from "./follower-runtime.js";
import {
  createSinglePlayerRuntime,
  type SinglePlayerPendingAttentionEntry,
  type SinglePlayerThreadInfo,
} from "./single-player-runtime.js";
import { createBrokerRuntime } from "./broker-runtime.js";
import { SlackActivityLogger } from "./activity-log.js";
import {
  createBrokerDeliveryState,
  getBrokerInboxIds,
  queueBrokerInboxIds,
} from "./broker-delivery.js";
import { buildBrokerControlPlaneDashboardSnapshot } from "./broker/control-plane-canvas.js";
import { createPinetHomeTabs } from "./pinet-home-tabs.js";
import { createPinetAgentStatus } from "./pinet-agent-status.js";
import { createPinetMeshSkin } from "./pinet-skin.js";
import { createBrokerThreadOwnerHints } from "./broker-thread-owner-hints.js";
import { createPersistedRuntimeState } from "./persisted-runtime-state.js";
import { createPinetActivityFormatting } from "./pinet-activity-formatting.js";
import { createPinetControlPlaneCanvas } from "./pinet-control-plane-canvas.js";
import { createPinetMaintenanceDelivery } from "./pinet-maintenance-delivery.js";
import { createPinetRemoteControlAcks } from "./pinet-remote-control-acks.js";
import { createPinetRemoteControl } from "./pinet-remote-control.js";
import { createPinetMeshOps } from "./pinet-mesh-ops.js";
import {
  type SlackBridgeRuntimeMode,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";

// Settings and helpers imported from ./helpers.js

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

  // Security guardrails
  let guardrails: SecurityGuardrails = settings.security ?? {};
  let securityPrompt = buildSecurityPrompt(guardrails);

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

  let botUserId: string | null = null;

  const threads = new Map<string, SinglePlayerThreadInfo>();
  const thinking = new Set<string>();
  const pendingEyes = new Map<string, SinglePlayerPendingAttentionEntry[]>(); // thread_ts → message ts list // thread_ts values showing "is thinking…"
  const userNames = new TtlCache<string, string>({ maxSize: 2000, ttlMs: 60 * 60 * 1000 });
  let lastDmChannel: string | null = null;
  const channelCache = new TtlCache<string, string>({ maxSize: 500, ttlMs: 30 * 60 * 1000 });
  const unclaimedThreads = new TtlSet<string>({ maxSize: 5000, ttlMs: 5 * 60 * 1000 });
  const processedSlackSocketDeliveries = new TtlSet<string>({
    maxSize: SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
    ttlMs: SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  });

  const {
    formatAction: formatConfirmationAction,
    registerRequest: registerConfirmationRequest,
    consumeReply: consumeConfirmationReply,
    requireToolPolicy,
  } = createThreadConfirmationPolicy({
    getGuardrails: () => guardrails,
  });

  // ─── State persistence ──────────────────────────────

  const persistedRuntimeState = createPersistedRuntimeState({
    pi,
    threads,
    userNames,
    getLastDmChannel: () => lastDmChannel,
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    getAgentName: () => agentName,
    setAgentName: (name) => {
      agentName = name;
    },
    getAgentEmoji: () => agentEmoji,
    setAgentEmoji: (emoji) => {
      agentEmoji = emoji;
    },
    getAgentStableId: () => agentStableId,
    setAgentStableId: (stableId) => {
      agentStableId = stableId;
    },
    getBrokerStableId: () => brokerStableId,
    setBrokerStableId: (stableId) => {
      brokerStableId = stableId;
    },
    getBrokerRole: () => brokerRole,
    getActiveSkinTheme: () => activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    getAgentPersonality: () => agentPersonality,
    setAgentPersonality: (personality) => {
      agentPersonality = personality;
    },
    agentAliases,
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getSettings: () => settings,
    getControlPlaneCanvasRuntimeId: () => brokerRuntime.getControlPlaneCanvasRuntimeId(),
    getControlPlaneCanvasRuntimeChannelId: () =>
      brokerRuntime.getControlPlaneCanvasRuntimeChannelId(),
    restoreControlPlaneCanvasRuntimeState: (input) => {
      brokerRuntime.restoreControlPlaneCanvasRuntimeState(input);
    },
    formatError: msg,
  });
  const { persistState, flushPersist, restorePersistedRuntimeState } = persistedRuntimeState;

  // ─── Inbox queue ────────────────────────────────────

  const inbox: InboxMessage[] = [];
  const brokerDeliveryState = createBrokerDeliveryState();
  const AUTO_DRAIN_INTERRUPT_SUPPRESSION_MS = 1_500;
  let suppressAutoDrainUntil = 0;
  let terminalInputUnsubscribe: (() => void) | null = null;
  let extCtx: ExtensionContext | null = null; // cached for badge updates
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

  let isSinglePlayerShuttingDown = () => false;
  let isSinglePlayerConnected = () => false;
  const slackRuntimeAccess = createSlackRuntimeAccess({
    slack,
    getBotToken: () => botToken!,
    userNames,
    channelCache,
    persistState,
    isSinglePlayerShuttingDown: () => isSinglePlayerShuttingDown(),
    getSuggestedPrompts: () => settings.suggestedPrompts,
    getAgentName: () => agentName,
    getThreads: () => threads,
    getBrokerRole: () => brokerRole,
    resolveBrokerThreadChannel: (threadTs) =>
      brokerRuntime.getBroker()?.db.getThread(threadTs)?.channel ?? null,
    resolveFollowerThreadChannel: async (threadTs) =>
      (await brokerClient?.client.resolveThread(threadTs)) ?? null,
  });
  const {
    addReaction,
    removeReaction,
    resolveUser,
    rememberChannel,
    resolveChannel,
    resolveFollowerReplyChannel,
    clearThreadStatus,
    setSuggestedPrompts,
    fetchSlackMessageByTs,
  } = slackRuntimeAccess;
  const pinetHomeTabs = createPinetHomeTabs({
    slack,
    getBotToken: () => botToken,
    formatError: msg,
    getAgentName: () => agentName,
    getAgentEmoji: () => agentEmoji,
    getBrokerRole: () => brokerRole,
    getRuntimeMode: () => currentRuntimeMode,
    isFollowerConnected: () => brokerClient != null,
    isSinglePlayerConnected: () => isSinglePlayerConnected(),
    getActiveThreads: () => threads.size,
    getPendingInboxCount: () => inbox.length,
    getDefaultChannel: () => settings.defaultChannel ?? null,
    getCurrentBranch: async () => (await probeGitBranch(process.cwd())) ?? null,
    getBrokerHomeTabs: () => brokerRuntime,
  });
  const pinetAgentStatus = createPinetAgentStatus({
    getPinetEnabled: () => pinetEnabled,
    getBrokerRole: () => brokerRole,
    getDesiredAgentStatus: () => desiredAgentStatus,
    setDesiredAgentStatus: (status) => {
      desiredAgentStatus = status;
    },
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    hasFollowerClient: () => brokerClient != null,
    syncFollowerDesiredStatus: (status, options) =>
      followerRuntime.syncDesiredStatus(status, options),
    runBrokerMaintenance: (ctx) => {
      brokerRuntime.runMaintenance(ctx);
    },
    getInboxLength: () => inbox.length,
    getCurrentRuntimeMode: () => currentRuntimeMode,
    maybeDrainInboxIfIdle,
    getExtensionContext: () => extCtx ?? undefined,
  });
  const { reportStatus, signalAgentFree } = pinetAgentStatus;
  const pinetMeshSkin = createPinetMeshSkin({
    getBrokerRole: () => brokerRole,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    pinetSkinSettingKey: PINET_SKIN_SETTING_KEY,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    getMeshRoleFromMetadata: (metadata, fallbackRole) =>
      getMeshRoleFromMetadata(metadata ?? undefined, fallbackRole),
    buildSkinMetadata: (metadata, personality) =>
      buildSkinMetadata(metadata ?? undefined, personality),
    applyLocalAgentIdentity,
    getAgentName: () => agentName,
    dispatchDirectAgentMessage: (input) => {
      const db = getActiveBrokerDb();
      if (!db) {
        return;
      }
      dispatchDirectAgentMessage(db, input);
    },
    persistState,
  });
  const { applyMeshSkin } = pinetMeshSkin;
  const pinetMaintenanceDelivery = createPinetMaintenanceDelivery({
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    sendUserMessage: (body, options) => {
      pi.sendUserMessage(body, options);
    },
  });
  const { sendBrokerMaintenanceMessage, trySendBrokerFollowUp } = pinetMaintenanceDelivery;
  const pinetRemoteControlAcks = createPinetRemoteControlAcks({
    queueBrokerInboxIds: (inboxIds) => {
      queueBrokerInboxIds(brokerDeliveryState, inboxIds);
    },
    isBrokerConnected: () => brokerRuntime.isConnected(),
    markBrokerInboxIdsDelivered: (inboxIds) => {
      brokerRuntime.markDelivered(inboxIds);
    },
    queueFollowerInboxIds: (inboxIds) => {
      queueFollowerInboxIds(followerDeliveryState, inboxIds);
    },
    markFollowerInboxIdsDelivered: (inboxIds) => {
      markFollowerInboxIdsDelivered(followerDeliveryState, inboxIds);
    },
    flushDeliveredFollowerAcks,
  });
  const {
    resetPendingRemoteControlAcks,
    deferBrokerControlAck,
    deferFollowerControlAck,
    flushDeferredRemoteControlAcks,
  } = pinetRemoteControlAcks;
  const pinetRemoteControl = createPinetRemoteControl({
    flushDeferredRemoteControlAcks,
    reloadPinetRuntime,
    formatError: msg,
  });
  const { requestRemoteControl, runRemoteControl, resetRemoteControlState } = pinetRemoteControl;
  const pinetActivityFormatting = createPinetActivityFormatting({
    getActiveBrokerDb: () => (brokerRuntime.getBroker()?.db as BrokerDB | undefined) ?? null,
  });
  const { formatTrackedAgent, summarizeTrackedAssignmentStatus } = pinetActivityFormatting;
  const pinetControlPlaneCanvas = createPinetControlPlaneCanvas({
    getSettings: () => settings,
    getBotToken: () => botToken,
    slack,
    resolveChannel,
    persistState,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    heartbeatTimerActive: () => brokerRuntime.heartbeatTimerActive(),
    maintenanceTimerActive: () => brokerRuntime.maintenanceTimerActive(),
    getLastMaintenance: () => brokerRuntime.getLastMaintenance(),
    isBrokerControlPlaneCanvasEnabled: () => brokerRuntime.isBrokerControlPlaneCanvasEnabled(),
    getControlPlaneCanvasRuntimeId: () => brokerRuntime.getControlPlaneCanvasRuntimeId(),
    getControlPlaneCanvasRuntimeChannelId: () =>
      brokerRuntime.getControlPlaneCanvasRuntimeChannelId(),
    restoreControlPlaneCanvasRuntimeState: (input) => {
      brokerRuntime.restoreControlPlaneCanvasRuntimeState(input);
    },
    setLastControlPlaneCanvasRefreshAt: (value) => {
      brokerRuntime.setLastControlPlaneCanvasRefreshAt(value);
    },
    getLastControlPlaneCanvasError: () => brokerRuntime.getLastControlPlaneCanvasError(),
    setLastControlPlaneCanvasError: (value) => {
      brokerRuntime.setLastControlPlaneCanvasError(value);
    },
  });
  const {
    buildCurrentBrokerControlPlaneDashboardSnapshot,
    refreshBrokerControlPlaneCanvasDashboard,
  } = pinetControlPlaneCanvas;

  // ─── Socket Mode (native WebSocket) ─────────────────

  const singlePlayerRuntime = createSinglePlayerRuntime({
    slack,
    getBotToken: () => botToken!,
    getAppToken: () => appToken!,
    dedup: processedSlackSocketDeliveries,
    abortSlackRequests: () => slackRequests.abortAndWait(),
    isSingleRuntimeActive: () => currentRuntimeMode === "single",
    setExtStatus,
    formatError: msg,
    getAgentName: () => agentName,
    getAgentAliases: () => agentAliases,
    getAgentOwnerToken: () => agentOwnerToken,
    getBotUserId: () => botUserId,
    getThreads: () => threads,
    getPendingEyes: () => pendingEyes,
    getUnclaimedThreads: () => unclaimedThreads,
    pushInboxMessage: (message) => {
      inbox.push(message);
    },
    setLastDmChannel: (channelId) => {
      lastDmChannel = channelId;
    },
    persistState,
    updateBadge,
    maybeDrainInboxIfIdle,
    resolveThreadChannel: resolveFollowerReplyChannel,
    setSuggestedPrompts,
    publishCurrentPinetHomeTab: (userId, ctx) =>
      pinetHomeTabs.publishCurrentPinetHomeTabSafely(userId, ctx),
    fetchSlackMessageByTs,
    addReaction,
    removeReaction,
    resolveUser,
    isUserAllowed,
    getReactionCommand: (reactionName) => reactionCommands.get(reactionName),
    consumeConfirmationReply,
    claimOwnedThread: (threadTs, channelId, source = "slack") => {
      if (brokerRole === "broker") {
        brokerRuntime.claimThread(threadTs, channelId, source);
      } else if (brokerRole === "follower" && brokerClient?.client) {
        void brokerClient.client.claimThread(threadTs, channelId, source).catch(() => {
          /* broker gone, best effort */
        });
      }
    },
  });

  isSinglePlayerShuttingDown = () => singlePlayerRuntime.isShuttingDown();
  isSinglePlayerConnected = () => singlePlayerRuntime.isConnected();

  // ─── Reconnect / status ─────────────────────────────

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
    threadContext: singlePlayerRuntime.getThreadContextPort(),
    resolveChannel,
    rememberChannel,
    requireToolPolicy,
    getBotUserId: () => botUserId,
    registerConfirmationRequest,
  });

  // ─── Agent-to-agent messaging tools ──────────────────

  // These are registered unconditionally but only work when pinet is active.
  // The variables they reference (pinetEnabled, brokerRole, brokerRuntime,
  // brokerClient) are declared in the Commands section just below.

  // Forward-declared — assigned in the Commands section below.
  let pinetEnabled = false;
  let currentRuntimeMode: SlackBridgeRuntimeMode = "off";
  let brokerRole: "broker" | "follower" | null = null;
  let pinetRegistrationBlocked = false;
  let brokerClient: BrokerClientRef | null = null;
  const followerDeliveryState = createFollowerDeliveryState();
  let desiredAgentStatus: "working" | "idle" = "idle";

  function getPinetRegistrationBlockReason(): string {
    return "Pinet is disabled in local subagent sessions to avoid polluting the agent mesh.";
  }

  const brokerThreadOwnerHints = createBrokerThreadOwnerHints({
    slack,
    getBotToken: () => botToken!,
  });
  const { resolveBrokerThreadOwnerHint } = brokerThreadOwnerHints;

  const brokerRuntime = createBrokerRuntime({
    getSettings: () => settings,
    getBotToken: () => botToken!,
    getAppToken: () => appToken!,
    getAllowedUsers: () => allowedUsers,
    shouldAllowAllWorkspaceUsers: () =>
      resolveAllowAllWorkspaceUsers(settings, process.env.SLACK_ALLOW_ALL_WORKSPACE_USERS),
    getBrokerStableId: () => brokerStableId,
    setBrokerStableId: (stableId) => {
      brokerStableId = stableId;
    },
    getActiveSkinTheme: () => activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    setAgentOwnerToken: (ownerToken) => {
      agentOwnerToken = ownerToken;
    },
    getAgentMetadata,
    applyLocalAgentIdentity,
    buildSkinMetadata: (metadata, personality) =>
      buildSkinMetadata(metadata ?? undefined, personality),
    getMeshRoleFromMetadata: (metadata, fallbackRole) =>
      getMeshRoleFromMetadata(metadata ?? undefined, fallbackRole),
    handleInboundMessage: async ({ message, broker, router, selfId, ctx }) => {
      try {
        const ownerHint =
          message.source === "slack" && message.threadId && message.channel
            ? await resolveBrokerThreadOwnerHint(message.channel, message.threadId)
            : null;
        const routedMessage =
          ownerHint && (ownerHint.agentOwner || ownerHint.agentName)
            ? {
                ...message,
                metadata: {
                  ...(message.metadata ?? {}),
                  ...(ownerHint.agentOwner ? { threadOwnerAgentOwner: ownerHint.agentOwner } : {}),
                  ...(ownerHint.agentName ? { threadOwnerAgentName: ownerHint.agentName } : {}),
                },
              }
            : message;

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
          inbox.push({
            channel: routedMessage.channel,
            threadTs: routedMessage.threadId,
            userId: routedMessage.userId,
            text: routedMessage.text,
            timestamp: routedMessage.timestamp,
            metadata: routedMessage.metadata ?? null,
          });
          updateBadge();
          maybeDrainInboxIfIdle(ctx);
        }
      } catch (err) {
        console.error(`[slack-bridge] broker inbound routing failed: ${msg(err)}`);
      }
    },
    onAppHomeOpened: async (userId, ctx) => {
      await pinetHomeTabs.publishCurrentPinetHomeTabSafely(userId, ctx, new Date().toISOString());
    },
    pushInboxMessages: (messages) => {
      inbox.push(...messages);
    },
    updateBadge,
    maybeDrainInboxIfIdle,
    requestRemoteControl,
    deferControlAck: deferBrokerControlAck,
    runRemoteControl,
    applySkinUpdate: (update) => {
      activeSkinTheme = update.theme;
      applyLocalAgentIdentity(update.name, update.emoji, update.personality);
    },
    formatError: msg,
    deliveryState: brokerDeliveryState,
    createActivityLogger: (onError) =>
      new SlackActivityLogger({
        getBotToken: () => botToken,
        getLogChannel: () => settings.logChannel,
        getLogLevel: () => settings.logLevel,
        getAgentName: () => agentName,
        getAgentEmoji: () => agentEmoji,
        resolveChannel,
        slack,
        onError,
      }),
    formatTrackedAgent,
    summarizeTrackedAssignmentStatus,
    sendMaintenanceMessage: (targetAgentId, body) => {
      sendBrokerMaintenanceMessage(targetAgentId, body);
    },
    trySendFollowUp: (body, onDelivered) => {
      trySendBrokerFollowUp(body, onDelivered);
    },
    refreshCanvasDashboard: async (ctx, input) => {
      await refreshBrokerControlPlaneCanvasDashboard(
        ctx,
        input as Parameters<typeof refreshBrokerControlPlaneCanvasDashboard>[1],
      );
    },
    refreshHomeTabs: async (ctx, snapshot, refreshedAt, userIds) => {
      await pinetHomeTabs.refreshBrokerControlPlaneHomeTabs(ctx, snapshot, refreshedAt, userIds);
    },
    buildControlPlaneDashboardSnapshot: (input) =>
      buildBrokerControlPlaneDashboardSnapshot(
        input as unknown as Parameters<typeof buildBrokerControlPlaneDashboardSnapshot>[0],
      ),
    buildCurrentDashboardSnapshot: async (openedAt) =>
      buildCurrentBrokerControlPlaneDashboardSnapshot(openedAt),
    onMaintenanceResult: (ctx, { result, previousSignature, signature }) => {
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
        brokerRuntime.logActivity({
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
    },
    onMaintenanceError: (ctx, error) => {
      ctx.ui.notify(`Pinet maintenance failed: ${msg(error)}`, "error");
      brokerRuntime.logActivity({
        kind: "broker_maintenance_error",
        level: "errors",
        title: "Broker maintenance failed",
        summary: msg(error),
        tone: "error",
      });
    },
    onScheduledWakeupError: (ctx, error) => {
      ctx.ui.notify(`Pinet scheduled wake-ups failed: ${msg(error)}`, "error");
      brokerRuntime.logActivity({
        kind: "scheduled_wakeup_error",
        level: "errors",
        title: "Scheduled wake-up delivery failed",
        summary: msg(error),
        tone: "error",
      });
    },
    onAgentStatusChange: (_ctx, changedAgentId, status) => {
      brokerRuntime.logActivity({
        kind: "agent_status",
        level: "verbose",
        title: status === "idle" ? "Worker available" : "Worker busy",
        summary: `${formatTrackedAgent(changedAgentId)} marked itself ${status}.`,
        fields: [{ label: "Agent", value: formatTrackedAgent(changedAgentId) }],
        tone: status === "idle" ? "success" : "info",
      });
    },
  });

  function getActiveBroker(): Broker | null {
    return brokerRuntime.getBroker();
  }

  function getActiveBrokerDb(): BrokerDB | null {
    return (getActiveBroker()?.db as BrokerDB | undefined) ?? null;
  }

  function getActiveBrokerSelfId(): string | null {
    return brokerRuntime.getSelfId();
  }

  const pinetMeshOps = createPinetMeshOps({
    getPinetEnabled: () => pinetEnabled,
    getBrokerRole: () => brokerRole,
    getActiveBrokerDb,
    getActiveBrokerSelfId,
    getAgentName: () => agentName,
    getFollowerClient: () => brokerClient?.client ?? null,
    formatTrackedAgent,
    logActivity: (entry) => {
      brokerRuntime.logActivity(entry);
    },
  });
  const {
    sendPinetAgentMessage,
    sendPinetBroadcastMessage,
    scheduleBrokerWakeup,
    scheduleFollowerWakeup,
    listBrokerAgents,
    listFollowerAgents,
  } = pinetMeshOps;

  function getBrokerControlPlaneHomeTabViewerIds(): string[] {
    return brokerRuntime.getHomeTabViewerIds();
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
      singlePlayerRuntime.resetShutdownState();
    }

    if (mode === "off") {
      currentRuntimeMode = "off";
      setExtStatus(ctx, "off");
      return;
    }

    if (mode === "single") {
      currentRuntimeMode = "single";
      setExtStatus(ctx, "reconnecting");
      await singlePlayerRuntime.connect(ctx);
      botUserId = singlePlayerRuntime.getBotUserId() ?? botUserId;
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
    await brokerRuntime.disconnect({ releaseIdentity: options.releaseIdentity });

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

    await singlePlayerRuntime.disconnect();
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
        singlePlayerRuntime.resetShutdownState();
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

  registerPinetTools(pi, {
    pinetEnabled: () => pinetEnabled,
    brokerRole: () => brokerRole,
    requireToolPolicy,
    sendPinetAgentMessage,
    sendPinetBroadcastMessage,
    signalAgentFree,
    scheduleBrokerWakeup,
    scheduleFollowerWakeup,
    listBrokerAgents,
    listFollowerAgents,
  });

  registerIMessageTools(pi, {
    pinetEnabled: () => pinetEnabled,
    brokerRole: () => brokerRole,
    requireToolPolicy,
    getActiveBroker,
    getActiveBrokerSelfId,
    sendFollowerIMessage: async (input) => {
      if (!brokerClient?.client) {
        throw new Error("Pinet is in an unexpected state.");
      }

      const result = await brokerClient.client.sendMessage(input);
      return {
        adapter: result.adapter,
        messageId: result.messageId,
      };
    },
    getAgentIdentity: () => ({
      name: agentName,
      emoji: agentEmoji,
      ownerToken: agentOwnerToken,
    }),
    trackOwnedThread: (threadId, channel, source) => {
      singlePlayerRuntime.trackOwnedThread(threadId, channel, source);
    },
  });

  // ─── Commands ───────────────────────────────────────

  async function connectAsBroker(ctx: ExtensionContext): Promise<void> {
    refreshSettings();
    maybeWarnSlackUserAccess(ctx);

    const {
      botUserId: brokerBotUserId,
      recoveredBrokerMessages,
      recoveredTargetedBacklogCount,
      releasedBrokerClaims,
    } = await brokerRuntime.connect(ctx);
    const broker = brokerRuntime.getBroker();
    if (!broker) {
      throw new Error("Broker runtime failed to initialize.");
    }
    botUserId = brokerBotUserId;

    if (settings.imessage?.enabled) {
      const environment = detectIMessageMvpEnvironment();
      const readinessSummary = formatIMessageMvpReadiness(environment).join(" | ");

      if (!environment.canAttemptSend) {
        ctx.ui.notify(`iMessage adapter unavailable — ${readinessSummary}`, "warning");
        brokerRuntime.logActivity({
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
            brokerRuntime.logActivity({
              kind: "transport_readiness",
              level: "actions",
              title: "iMessage send-first mode enabled",
              summary: readinessSummary,
              tone: "warning",
            });
          }
        } catch (err) {
          ctx.ui.notify(`iMessage adapter failed to start: ${msg(err)}`, "warning");
          brokerRuntime.logActivity({
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

    brokerRole = "broker";
    pinetEnabled = true;
    desiredAgentStatus = "idle";
    currentRuntimeMode = "broker";

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

    brokerRuntime.startObservability(ctx);
    setExtStatus(ctx, "ok");
    brokerRuntime.logActivity({
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
        ? brokerRuntime.isConnected()
        : currentRuntimeMode === "follower"
          ? brokerClient != null
          : currentRuntimeMode === "single"
            ? singlePlayerRuntime.isConnected()
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
    recentActivityLogEntries: (limit) => brokerRuntime.getRecentActivityEntries(limit),
    settings: () => settings,
    lastBrokerMaintenance: () => brokerRuntime.getLastMaintenance(),
    isBrokerControlPlaneCanvasEnabled: () => brokerRuntime.isBrokerControlPlaneCanvasEnabled(),
    getConfiguredBrokerControlPlaneCanvasId: () =>
      brokerRuntime.getConfiguredBrokerControlPlaneCanvasId(),
    getConfiguredBrokerControlPlaneCanvasChannel: () =>
      brokerRuntime.getConfiguredBrokerControlPlaneCanvasChannel(),
    lastBrokerControlPlaneCanvasRefreshAt: () => brokerRuntime.getLastControlPlaneCanvasRefreshAt(),
    lastBrokerControlPlaneCanvasError: () => brokerRuntime.getLastControlPlaneCanvasError(),
    getBrokerControlPlaneHomeTabViewerIds,
    lastBrokerControlPlaneHomeTabRefreshAt: () => brokerRuntime.getLastHomeTabRefreshAt(),
    lastBrokerControlPlaneHomeTabError: () => brokerRuntime.getLastHomeTabError(),
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
    singlePlayerRuntime.resetShutdownState();
    resetTopLevelSlackRequests();
    resetRemoteControlState();
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
    restorePersistedRuntimeState(ctx);

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
        } else if (brokerRole === "broker") {
          try {
            brokerRuntime.markDelivered(brokerInboxIds);
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
    brokerRuntime.clearFollowUpPending();

    try {
      await signalAgentFree(ctx);
    } catch (err) {
      ctx.ui.notify(`Pinet auto-free failed: ${msg(err)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetRemoteControlState();
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
