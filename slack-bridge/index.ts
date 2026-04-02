import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@gugu91/pi-ext-types/typebox";
import { createGitContextCache, probeGitBranch, probeGitContext } from "./git-metadata.js";
import {
  type InboxMessage,
  type AgentDisplayInfo,
  type ConfirmationRequest,
  type ThreadConfirmationState,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  isUserAllowed as checkUserAllowed,
  formatInboxMessages,
  formatPinetInboxMessages,
  buildPinetControlMetadata,
  extractPinetControlCommand,
  getPinetControlCommandFromText,
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
  rewriteRalphLoopGhostAnomalies,
  buildRalphLoopNudgeMessage,
  buildRalphLoopAnomalySignature,
  buildRalphLoopCycleNotifications,
  buildRalphLoopStatusMessage,
  shouldDeliverRalphLoopFollowUp,
  DEFAULT_RALPH_LOOP_INTERVAL_MS,
  DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
  DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
  DEFAULT_CONFIRMATION_REQUEST_TTL_MS,
  partitionFollowerInboxEntries,
  generateAgentName,
  resolveAgentIdentity,
  shortenPath,
  buildIdentityReplyGuidelines,
  buildBrokerPromptGuidelines,
  buildWorkerPromptGuidelines,
  resolveAgentStableId,
  isLikelyLocalSubagentContext,
  syncFollowerInboxEntries,
  resolveFollowerThreadChannel,
  getFollowerReconnectUiUpdate,
  getFollowerOwnedThreadClaims,
  normalizeThreadConfirmationState,
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
import { TtlCache, TtlSet } from "./ttl-cache.js";
import { startBroker, type Broker } from "./broker/index.js";
import type { BrokerDB } from "./broker/schema.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./broker/socket-server.js";
import { MessageRouter } from "./broker/router.js";
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
  getPendingTaskAssignmentReport,
  hasTaskAssignmentStatusChange,
  resolveTaskAssignments,
} from "./task-assignments.js";
import { resolveScheduledWakeupFireAt } from "./scheduled-wakeups.js";
import {
  createBrokerDeliveryState,
  getBrokerInboxIds,
  isBrokerInboxIdTracked,
  markBrokerInboxIdsHandled,
  queueBrokerInboxIds,
  resetBrokerDeliveryState,
} from "./broker-delivery.js";
import { getMainCheckoutToolBlockReason } from "./worktree-policy.js";

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

  async function slack(method: string, token: string, body?: Record<string, unknown>) {
    return slackRequests.run((signal) => callSlackAPI(method, token, body, { signal }));
  }

  // allowedUsers: settings.json takes priority, env var as fallback
  let allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(allowedUsers, userId);
  }

  const initialIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, process.cwd());
  let agentName = initialIdentity.name;
  let agentEmoji = initialIdentity.emoji;
  let agentStableId = resolveAgentStableId(undefined, undefined, os.hostname(), process.cwd());

  // Security guardrails
  let guardrails: SecurityGuardrails = settings.security ?? {};
  let securityPrompt = buildSecurityPrompt(guardrails);

  interface ReloadableRuntimeSnapshot {
    settings: typeof settings;
    botToken: string | undefined;
    appToken: string | undefined;
    allowedUsers: Set<string> | null;
    guardrails: SecurityGuardrails;
    securityPrompt: string;
    agentName: string;
    agentEmoji: string;
  }

  function refreshSettings(): void {
    settings = loadSettingsFromFile();
    botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
    appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;
    allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);
    guardrails = settings.security ?? {};
    securityPrompt = buildSecurityPrompt(guardrails);
    const identitySeed = extCtx?.sessionManager.getSessionFile() ?? agentStableId;
    const refreshedIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, identitySeed);
    agentName = refreshedIdentity.name;
    agentEmoji = refreshedIdentity.emoji;
  }

  function snapshotReloadableRuntime(): ReloadableRuntimeSnapshot {
    return {
      settings: structuredClone(settings),
      botToken,
      appToken,
      allowedUsers: allowedUsers ? new Set(allowedUsers) : null,
      guardrails: structuredClone(guardrails),
      securityPrompt,
      agentName,
      agentEmoji,
    };
  }

  function restoreReloadableRuntime(snapshot: ReloadableRuntimeSnapshot): void {
    settings = structuredClone(snapshot.settings);
    botToken = snapshot.botToken;
    appToken = snapshot.appToken;
    allowedUsers = snapshot.allowedUsers ? new Set(snapshot.allowedUsers) : null;
    guardrails = structuredClone(snapshot.guardrails);
    securityPrompt = snapshot.securityPrompt;
    agentName = snapshot.agentName;
    agentEmoji = snapshot.agentEmoji;
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
    const { cwd, repo, repoRoot, worktreePath, worktreeKind, branch } = gitContext;
    const resolvedProjectRoot = worktreePath ?? repoRoot ?? cwd;
    const tools = detectProjectTools(resolvedProjectRoot, cwd);
    const tags = [
      `role:${role}`,
      `repo:${repo}`,
      ...(branch ? [`branch:${branch}`] : []),
      ...(worktreeKind ? [`checkout:${worktreeKind}`] : []),
      ...tools.map((tool) => `tool:${tool}`),
    ];

    return {
      cwd,
      branch,
      host: os.hostname(),
      role,
      repo,
      repoRoot,
      worktreePath,
      worktreeKind,
      capabilities: {
        repo,
        repoRoot,
        branch,
        role,
        tools,
        tags,
        worktreePath,
        worktreeKind,
      },
    };
  }

  const selfLocation = `${shortenPath(process.cwd(), os.homedir())}@${os.hostname()}`;

  function getIdentityGuidelines(): [string, string, string] {
    return buildIdentityReplyGuidelines(agentEmoji, agentName, selfLocation);
  }

  function applyBrokerIdentity(nextName: string, nextEmoji: string): void {
    if (agentName === nextName && agentEmoji === nextEmoji) return;
    const previousName = agentName;
    agentName = nextName;
    agentEmoji = nextEmoji;
    for (const thread of threads.values()) {
      if (thread.owner === previousName) {
        thread.owner = nextName;
      }
    }
    persistState();
    updateBadge();
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
  let extCtx: ExtensionContext | null = null; // cached for badge updates

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
          | { event_type?: string; event_payload?: { agent?: string } }
          | undefined;
        if (meta?.event_type === "pi_agent_msg" && meta.event_payload?.agent) {
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

    try {
      const data = JSON.parse(raw) as Record<string, unknown>;

      // ack every envelope
      if (data.envelope_id) {
        ws?.send(JSON.stringify({ envelope_id: data.envelope_id }));
      }

      if (data.type === "disconnect") {
        scheduleReconnect(ctx);
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
        case "message":
          if (!evt.subtype && !evt.bot_id) await onMessage(evt, ctx);
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
            if (ctx.isIdle?.()) drainInbox();
          }
          break;
      }
    } catch {
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
    if (localOwner && localOwner !== agentName) return; // owned by another agent

    if (!localOwner && !unclaimedThreads.has(effectiveTs)) {
      const remoteOwner = await resolveThreadOwner(channel, effectiveTs);
      if (shuttingDown) return;
      if (remoteOwner && remoteOwner !== agentName) {
        const t = threads.get(effectiveTs);
        if (t) t.owner = remoteOwner; // cache so we skip instantly next time
        return;
      }
      if (remoteOwner === agentName) {
        const t = threads.get(effectiveTs);
        if (t) t.owner = agentName;
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
    const confirmationResult = consumeConfirmationReply(effectiveTs, cleanText);
    const messageText =
      confirmationResult === null
        ? cleanText
        : confirmationResult.approved
          ? `${cleanText}\n\n✅ User approved security confirmation request in this thread.`
          : `${cleanText}\n\n❌ User denied security confirmation request in this thread.`;

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
    if (ctx.isIdle?.()) {
      drainInbox();
    }
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
          owner: agentName,
        });
      } else {
        const thread = threads.get(threadTs)!;
        if (!thread.owner) thread.owner = agentName;
      }
      unclaimedThreads.delete(threadTs);
      persistState();
    },
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
  let brokerRalphLoopTimer: ReturnType<typeof setInterval> | null = null;
  let brokerScheduledWakeupTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceRunning = false;
  let brokerRalphLoopRunning = false;
  let brokerScheduledWakeupRunning = false;
  let lastBrokerMaintenance: BrokerMaintenanceResult | null = null;
  let lastBrokerMaintenanceSignature = "";
  let lastBrokerRalphLoopNonGhostSignature = "";
  let lastBrokerRalphLoopHadOutstandingAnomalies = false;
  let lastBrokerRalphLoopFollowUpAt = 0;
  let brokerRalphLoopFollowUpPending = false;
  const lastReportedGhostIds = new Set<string>();
  let lastBrokerTaskAssignmentReport = "";
  let pendingBrokerTaskAssignmentReport: string | null = null;
  const lastBrokerNudges = new Map<string, number>();

  function getPinetRegistrationBlockReason(): string {
    return "Pinet is disabled in local subagent sessions to avoid polluting the agent mesh.";
  }

  function syncBrokerDbInbox(agentId: string, db: BrokerDB): void {
    const pending = db
      .getInbox(agentId)
      .filter((item) => !isBrokerInboxIdTracked(brokerDeliveryState, item.entry.id));
    if (pending.length === 0) {
      return;
    }

    queueBrokerInboxIds(
      brokerDeliveryState,
      pending.map((item) => item.entry.id),
    );

    for (const item of pending) {
      const meta = item.message.metadata ?? {};
      const senderName =
        typeof meta.senderAgent === "string" ? meta.senderAgent : item.message.sender;
      inbox.push({
        channel: "",
        threadTs: item.message.threadId,
        userId: senderName,
        text: item.message.body,
        timestamp: item.message.createdAt,
        brokerInboxId: item.entry.id,
      });
    }

    updateBadge();
    if (extCtx?.isIdle?.()) {
      drainInbox();
    }
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
      lastBrokerMaintenance = result;

      const signature = result.anomalies.join("|");
      if (signature && signature !== lastBrokerMaintenanceSignature) {
        ctx.ui.notify(`Pinet broker: ${result.anomalies.join("; ")}`, "warning");
      } else if (!signature && lastBrokerMaintenanceSignature) {
        ctx.ui.notify("Pinet broker health recovered", "info");
      }
      lastBrokerMaintenanceSignature = signature;
    } catch (err) {
      ctx.ui.notify(`Pinet maintenance failed: ${msg(err)}`, "error");
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
        syncBrokerDbInbox(activeSelfId, activeBroker.db as BrokerDB);
      }
    } catch (err) {
      ctx.ui.notify(`Pinet scheduled wake-ups failed: ${msg(err)}`, "error");
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

  async function runBrokerRalphLoop(ctx: ExtensionContext): Promise<void> {
    if (!activeBroker || !activeSelfId || brokerRalphLoopRunning) return;

    brokerRalphLoopRunning = true;
    const cycleStartedAt = new Date().toISOString();
    const cycleStartMs = Date.now();
    try {
      runBrokerMaintenance(ctx);

      const db = activeBroker.db;
      const currentBranch = (await probeGitBranch(process.cwd())) ?? null;

      const workloads = db.getAllAgents().map((agent) => ({
        ...agent,
        pendingInboxCount: db.getPendingInboxCount(agent.id),
        ownedThreadCount: db.getOwnedThreadCount(agent.id),
      }));
      const pendingBacklogCount = db.getBacklogCount("pending");
      const evaluation = evaluateRalphLoopCycle(workloads, {
        now: Date.now(),
        heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        stuckWorkingThresholdMs: DEFAULT_RALPH_LOOP_STUCK_WORKING_THRESHOLD_MS,
        pendingBacklogCount,
        currentBranch,
        brokerHeartbeatActive: brokerHeartbeatTimer != null,
        brokerMaintenanceActive: brokerMaintenanceTimer != null,
      });

      const now = Date.now();
      const nudgeAgentIds = new Set(evaluation.nudgeAgentIds);
      for (const workload of workloads) {
        if (!nudgeAgentIds.has(workload.id)) {
          lastBrokerNudges.delete(workload.id);
          continue;
        }

        const lastNudgeAt = lastBrokerNudges.get(workload.id) ?? 0;
        if (now - lastNudgeAt < DEFAULT_RALPH_LOOP_NUDGE_COOLDOWN_MS) {
          continue;
        }

        sendBrokerMaintenanceMessage(
          workload.id,
          buildRalphLoopNudgeMessage(workload.pendingInboxCount, workload.ownedThreadCount),
        );
        lastBrokerNudges.set(workload.id, now);
      }

      const ghostRewrite = rewriteRalphLoopGhostAnomalies(evaluation, lastReportedGhostIds);
      lastReportedGhostIds.clear();
      for (const ghostId of ghostRewrite.nextReportedGhostIds) {
        lastReportedGhostIds.add(ghostId);
      }

      const visibleEvaluation = ghostRewrite.evaluation;
      const visibleSignature = buildRalphLoopAnomalySignature(visibleEvaluation);
      const nonGhostSignature = ghostRewrite.nonGhostAnomalies.join("|");
      const hasOutstandingAnomalies = evaluation.anomalies.length > 0;
      const ralphNotifications = buildRalphLoopCycleNotifications(
        visibleEvaluation,
        cycleStartedAt,
      );
      const followUpPrompt =
        ghostRewrite.newGhostIds.length === 0 &&
        ghostRewrite.clearedGhostIds.length > 0 &&
        ghostRewrite.nonGhostAnomalies.length === 0
          ? null
          : ralphNotifications.followUpPrompt;

      const agentsById = new Map(
        workloads.map((workload) => [workload.id, { emoji: workload.emoji, name: workload.name }]),
      );
      const trackedAssignments = db.listTaskAssignments();
      if (trackedAssignments.length === 0) {
        pendingBrokerTaskAssignmentReport = null;
        lastBrokerTaskAssignmentReport = "";
      } else {
        const resolvedAssignments = await resolveTaskAssignments(trackedAssignments, process.cwd());
        const projectedAssignments = resolvedAssignments.map((assignment) => {
          if (hasTaskAssignmentStatusChange(assignment)) {
            db.updateTaskAssignmentProgress(
              assignment.id,
              assignment.nextStatus,
              assignment.nextPrNumber,
            );
          }

          return {
            ...assignment,
            status: assignment.nextStatus,
            prNumber: assignment.nextPrNumber,
          };
        });

        pendingBrokerTaskAssignmentReport = getPendingTaskAssignmentReport(
          projectedAssignments,
          agentsById,
          lastBrokerTaskAssignmentReport,
        );
      }
      // Keep cooldown state across transient clean cycles so flapping anomalies
      // do not immediately re-notify when they return.
      const shouldDeliverFollowUp =
        followUpPrompt != null &&
        shouldDeliverRalphLoopFollowUp({
          signature: visibleSignature,
          lastDeliveredAt: lastBrokerRalphLoopFollowUpAt,
          now,
          cooldownMs: DEFAULT_RALPH_LOOP_FOLLOW_UP_COOLDOWN_MS,
          pending: brokerRalphLoopFollowUpPending,
          idle: ctx.isIdle?.() ?? true,
        });
      if (shouldDeliverFollowUp && followUpPrompt) {
        trySendBrokerFollowUp(followUpPrompt, () => {
          brokerRalphLoopFollowUpPending = true;
          lastBrokerRalphLoopFollowUpAt = now;
        });
      }
      if (
        pendingBrokerTaskAssignmentReport &&
        (ctx.isIdle?.() ?? true) &&
        pendingBrokerTaskAssignmentReport !== lastBrokerTaskAssignmentReport
      ) {
        const reportToDeliver = pendingBrokerTaskAssignmentReport;
        trySendBrokerFollowUp(reportToDeliver, () => {
          lastBrokerTaskAssignmentReport = reportToDeliver;
          pendingBrokerTaskAssignmentReport = null;
        });
      } else if (pendingBrokerTaskAssignmentReport === lastBrokerTaskAssignmentReport) {
        pendingBrokerTaskAssignmentReport = null;
      }

      const shouldWarn =
        ghostRewrite.newGhostIds.length > 0 ||
        (nonGhostSignature.length > 0 &&
          nonGhostSignature !== lastBrokerRalphLoopNonGhostSignature);
      const shouldInform =
        ghostRewrite.clearedGhostIds.length > 0 && visibleEvaluation.anomalies.length > 0;
      if (shouldWarn) {
        ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "warning");
      } else if (shouldInform) {
        ctx.ui.notify(ralphNotifications.anomalyStatus ?? "RALPH loop anomaly detected", "info");
      } else if (!hasOutstandingAnomalies && lastBrokerRalphLoopHadOutstandingAnomalies) {
        ctx.ui.notify(ralphNotifications.recoveryStatus, "info");
      }
      lastBrokerRalphLoopNonGhostSignature = nonGhostSignature;
      lastBrokerRalphLoopHadOutstandingAnomalies = hasOutstandingAnomalies;

      // #103: Record ralph cycle for observability
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
      } catch {
        /* best effort — don't let cycle recording break the loop */
      }
    } catch (err) {
      ctx.ui.notify(buildRalphLoopStatusMessage(`failed: ${msg(err)}`, cycleStartedAt), "error");
    } finally {
      brokerRalphLoopRunning = false;
    }
  }

  function startBrokerRalphLoop(ctx: ExtensionContext): void {
    stopBrokerRalphLoop();
    brokerRalphLoopTimer = setInterval(() => {
      void runBrokerRalphLoop(ctx);
    }, DEFAULT_RALPH_LOOP_INTERVAL_MS);
    brokerRalphLoopTimer.unref?.();
    void runBrokerRalphLoop(ctx);
  }

  function stopBrokerRalphLoop(): void {
    if (brokerRalphLoopTimer) {
      clearInterval(brokerRalphLoopTimer);
      brokerRalphLoopTimer = null;
    }
    lastBrokerNudges.clear();
    lastReportedGhostIds.clear();
    lastBrokerRalphLoopNonGhostSignature = "";
    lastBrokerRalphLoopHadOutstandingAnomalies = false;
    lastBrokerRalphLoopFollowUpAt = 0;
    brokerRalphLoopFollowUpPending = false;
    lastBrokerTaskAssignmentReport = "";
    pendingBrokerTaskAssignmentReport = null;
  }

  function getOutgoingPinetMessageMetadata(body: string): Record<string, unknown> | undefined {
    const control = getPinetControlCommandFromText(body);
    if (!control) return undefined;
    return buildPinetControlMetadata(control);
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

    const effectiveMetadata = {
      ...(getOutgoingPinetMessageMetadata(body) ?? {}),
      ...(metadata ?? {}),
    };
    const finalMetadata = Object.keys(effectiveMetadata).length > 0 ? effectiveMetadata : undefined;

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
        body,
        metadata: finalMetadata,
      });

      for (const assignment of extractTaskAssignmentsFromMessage(body)) {
        db.recordTaskAssignment(
          result.target.id,
          assignment.issueNumber,
          assignment.branch,
          result.threadId,
          result.messageId,
        );
      }

      return { messageId: result.messageId, target: result.target.name };
    }

    if (brokerRole === "follower" && brokerClient) {
      const client = brokerClient.client as BrokerClient;
      const messageId = await client.sendAgentMessage(targetRef, body, finalMetadata);
      return { messageId, target: targetRef };
    }

    throw new Error("Pinet is in an unexpected state.");
  }

  let remoteControlState: PinetRemoteControlState = {
    currentCommand: null,
    queuedCommand: null,
  };

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
    lastBrokerRalphLoopNonGhostSignature = "";
    lastBrokerRalphLoopHadOutstandingAnomalies = false;
    lastReportedGhostIds.clear();
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

  function requestRemoteControl(command: PinetControlCommand, ctx: ExtensionContext): boolean {
    const queued = queuePinetRemoteControl(remoteControlState, command);
    remoteControlState = {
      currentCommand: queued.currentCommand,
      queuedCommand: queued.queuedCommand,
    };

    if (queued.shouldStartNow) {
      runRemoteControl(command, ctx);
      return true;
    }

    if (queued.status === "queued") {
      ctx.ui.notify(`Pinet remote control queued: /${queued.queuedCommand ?? command}`, "warning");
    } else {
      const scheduled = queued.queuedCommand ?? queued.currentCommand ?? command;
      ctx.ui.notify(`Pinet remote control already scheduled — keeping /${scheduled}`, "warning");
    }
    return queued.accepted;
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

        const result = dispatchBroadcastAgentMessage(activeBroker.db, {
          senderAgentId: selfId,
          senderAgentName: agentName,
          channel: params.to,
          body: params.message,
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
    const broker = await startBroker();
    const adapter = new SlackAdapter({
      botToken: botToken!,
      appToken: appToken!,
      allowedUsers: allowedUsers ? [...allowedUsers] : undefined,
      suggestedPrompts: settings.suggestedPrompts,
      isKnownThread: (threadTs: string) => broker.db.getThread(threadTs) != null,
      rememberKnownThread: (threadTs: string, channelId: string) => {
        broker.db.updateThread(threadTs, { source: "slack", channel: channelId });
      },
    });
    let selfId: string | null = null;

    try {
      const router = new MessageRouter(broker.db);
      const selfAgent = broker.db.registerAgent(
        ctx.sessionManager.getLeafId() ?? `broker-${process.pid}`,
        agentName,
        agentEmoji,
        process.pid,
        await getAgentMetadata("broker"),
        agentStableId,
      );
      selfId = selfAgent.id;
      applyBrokerIdentity(selfAgent.name, selfAgent.emoji);

      resetBrokerDeliveryState(brokerDeliveryState);
      const recoveredBrokerMessages = broker.db.getPendingInboxCount(selfId);
      const releasedBrokerClaims = broker.db.releaseThreadClaims(selfId);
      if (recoveredBrokerMessages > 0 || releasedBrokerClaims > 0) {
        ctx.ui.notify(
          `Pinet broker recovered ${recoveredBrokerMessages} pending message${recoveredBrokerMessages === 1 ? "" : "s"} and released ${releasedBrokerClaims} broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}`,
          "info",
        );
      }

      adapter.onInbound((inMsg) => {
        // Track thread metadata locally as a cache without claiming broker ownership.
        trackBrokerInboundThread(threads, inMsg);

        const decision = router.route(inMsg);

        if (inMsg.threadId && inMsg.channel) {
          broker.db.updateThread(inMsg.threadId, {
            source: inMsg.source,
            channel: inMsg.channel,
          });
        }

        if (decision.action === "deliver" && decision.agentId !== selfId) {
          broker.db.queueMessage(decision.agentId, inMsg);
          return;
        }

        if (decision.action === "deliver" || decision.action === "unrouted") {
          // Message routed to broker itself (or unrouted) — deliver to broker's own inbox.
          inbox.push({
            channel: inMsg.channel,
            threadTs: inMsg.threadId,
            userId: inMsg.userId,
            text: inMsg.text,
            timestamp: inMsg.timestamp,
          });
          updateBadge();
          if (extCtx?.isIdle?.()) drainInbox();
        }
      });

      broker.addAdapter(adapter);
      await adapter.connect();
      botUserId = adapter.getBotUserId();

      activeBroker = broker;
      activeRouter = router;
      activeSelfId = selfId;
      syncBrokerDbInbox(selfId, broker.db);

      // When a worker sends a pinet_message targeting the broker, the socket server writes to the
      // DB inbox but the broker only reads its in-memory inbox. Sync the durable inbox into memory
      // without acknowledging the row until the broker has actually consumed it.
      broker.server.onAgentMessage((targetAgentId, brokerMsg, meta) => {
        if (targetAgentId !== selfId) return;

        const control = extractPinetControlCommand({
          threadId: brokerMsg.threadId,
          body: brokerMsg.body,
          metadata: meta,
        });
        if (control) {
          try {
            const accepted = requestRemoteControl(control, ctx);
            if (accepted) {
              broker.db.markDeliveredByMessageId(brokerMsg.id, selfId);
            }
          } catch (err) {
            ctx.ui.notify(`Pinet remote control failed: ${msg(err)}`, "error");
          }
          return;
        }

        syncBrokerDbInbox(selfId, broker.db);
      });
      broker.server.onAgentStatusChange((_agentId, status) => {
        if (status === "idle") {
          runBrokerMaintenance(ctx);
        }
      });

      startBrokerHeartbeat();
      startBrokerMaintenance(ctx);
      startBrokerRalphLoop(ctx);
      startBrokerScheduledWakeups(ctx);
      brokerRole = "broker";
      pinetEnabled = true;
      setExtStatus(ctx, "ok");
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

  pi.registerCommand("pinet-start", {
    description: "Start Pinet as the broker (Slack connection + message routing)",
    handler: async (_args, ctx) => {
      if (pinetRegistrationBlocked) {
        ctx.ui.notify(getPinetRegistrationBlockReason(), "warning");
        return;
      }
      if (pinetEnabled) {
        ctx.ui.notify(`Pinet already running (${brokerRole})`, "info");
        return;
      }
      extCtx = ctx;

      try {
        await connectAsBroker(ctx);
      } catch (err) {
        ctx.ui.notify(`Pinet broker failed: ${msg(err)}`, "error");
        setExtStatus(ctx, "error");
      }
    },
  });

  async function connectAsFollower(ctx: ExtensionContext): Promise<void> {
    if (pinetRegistrationBlocked) {
      throw new Error(getPinetRegistrationBlockReason());
    }

    const client = new BrokerClient();

    try {
      await client.connect();
      const registration = await client.register(
        agentName,
        agentEmoji,
        await getAgentMetadata("worker"),
        agentStableId,
      );
      applyBrokerIdentity(registration.name, registration.emoji);

      const brokerClientRef: BrokerClientRef = {
        client,
        pollInterval: null,
      };
      resetFollowerDeliveryState(followerDeliveryState);
      followerAckPromise = null;
      let wasDisconnected = false;
      let followerPollRunning = false;

      async function resumeThreadClaims(): Promise<void> {
        for (const thread of getFollowerOwnedThreadClaims(threads, agentName)) {
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
            for (const entry of newEntries) {
              const command = extractPinetControlCommand({
                threadId: entry.message.threadId,
                body: entry.message.body,
                metadata: entry.message.metadata,
              });
              if (command) {
                controlEntries.push({ inboxId: entry.inboxId, command });
              }
            }

            if (controlEntries.length > 0) {
              const acceptedIds: number[] = [];
              for (const entry of controlEntries) {
                if (requestRemoteControl(entry.command, ctx)) {
                  acceptedIds.push(entry.inboxId);
                }
              }
              if (acceptedIds.length > 0) {
                await client.ackMessages(acceptedIds);
              }
              return;
            }

            // Partition nudges and a2a traffic out of the human Slack inbox flow.
            const { nudges, agentMessages, regular } = partitionFollowerInboxEntries(newEntries);

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
              const synced = syncFollowerInboxEntries(regular, threads, agentName, lastDmChannel);
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
              if (ctx.isIdle?.()) drainInbox();
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
          const registration = client.getRegisteredIdentity();
          if (registration) {
            applyBrokerIdentity(registration.name, registration.emoji);
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
      startPolling();
      brokerClient = brokerClientRef;
      brokerRole = "follower";
      pinetEnabled = true;
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

  pi.registerCommand("pinet-follow", {
    description: "Connect to an existing Pinet broker as a follower",
    handler: async (_args, ctx) => {
      if (pinetRegistrationBlocked) {
        ctx.ui.notify(getPinetRegistrationBlockReason(), "warning");
        return;
      }
      if (pinetEnabled) {
        ctx.ui.notify(`Pinet already running (${brokerRole})`, "info");
        return;
      }
      extCtx = ctx;

      try {
        await connectAsFollower(ctx);
        ctx.ui.notify(`${agentEmoji} ${agentName} — following broker`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet follow failed: ${msg(err)}`, "error");
        setExtStatus(ctx, "error");
      }
    },
  });

  pi.registerCommand("pinet-unfollow", {
    description: "Disconnect from the Pinet broker and keep working locally",
    handler: async (_args, ctx) => {
      if (!pinetEnabled || brokerRole == null) {
        ctx.ui.notify("Pinet not running. Use /pinet-start or /pinet-follow.", "info");
        return;
      }

      if (brokerRole !== "follower") {
        ctx.ui.notify(
          "Pinet is running as broker; /pinet-unfollow only applies to followers.",
          "warning",
        );
        return;
      }

      const { unregisterError } = await disconnectFollower(ctx);
      if (unregisterError) {
        ctx.ui.notify(
          `Pinet follower disconnected locally, but broker deregistration failed: ${unregisterError}`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(
        `${agentEmoji} ${agentName} — disconnected from broker; local session still running`,
        "info",
      );
    },
  });
  pi.registerCommand("pinet-reload", {
    description: "Tell a connected Pinet agent to reload itself",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /pinet-reload <agent-name-or-id>", "warning");
        return;
      }

      try {
        const result = await sendPinetAgentMessage(target, "/reload");
        ctx.ui.notify(`Sent /reload to ${result.target}`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet reload failed: ${msg(err)}`, "error");
      }
    },
  });

  pi.registerCommand("pinet-exit", {
    description: "Tell a connected Pinet agent to exit gracefully",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /pinet-exit <agent-name-or-id>", "warning");
        return;
      }

      try {
        const result = await sendPinetAgentMessage(target, "/exit");
        ctx.ui.notify(`Sent /exit to ${result.target}`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet exit failed: ${msg(err)}`, "error");
      }
    },
  });
  pi.registerCommand("pinet-free", {
    description: "Mark this Pinet agent idle/free for new work",
    handler: async (_args, ctx) => {
      if (!pinetEnabled) {
        ctx.ui.notify("Pinet not running. Use /pinet-start or /pinet-follow.", "info");
        return;
      }

      try {
        const result = signalAgentFree(ctx, { requirePinet: true });
        const suffix = result.drainedQueuedInbox
          ? ` Processing ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? "" : "s"} now.`
          : result.queuedInboxCount > 0
            ? ` ${result.queuedInboxCount} queued inbox item${result.queuedInboxCount === 1 ? " remains" : "s remain"}.`
            : "";
        ctx.ui.notify(`Marked ${agentEmoji} ${agentName} idle/free for new work.${suffix}`, "info");
      } catch (err) {
        ctx.ui.notify(`Pinet free failed: ${msg(err)}`, "error");
      }
    },
  });
  pi.registerCommand("pinet-status", {
    description: "Show Pinet status",
    handler: async (_args, ctx) => {
      if (!pinetEnabled) {
        ctx.ui.notify("Pinet not running. Use /pinet-start or /pinet-follow.", "info");
        return;
      }
      const mode = brokerRole === "broker" ? "broker" : "follower";
      const socket = mode;
      const ownedCount = [...threads.values()].filter((t) => t.owner === agentName).length;
      const allowlistInfo = allowedUsers
        ? `Allowed users: ${[...allowedUsers].join(", ")}`
        : "Allowed users: all (no allowlist set)";
      const defaultChInfo = settings.defaultChannel
        ? `Default channel: ${settings.defaultChannel}`
        : "Default channel: none";
      const brokerHealthInfo =
        mode === "broker" && lastBrokerMaintenance
          ? [
              `Pending backlog: ${lastBrokerMaintenance.pendingBacklogCount}`,
              `Last maintenance: assigned ${lastBrokerMaintenance.assignedBacklogCount}, reaped ${lastBrokerMaintenance.reapedAgentIds.length}, repaired ${lastBrokerMaintenance.repairedThreadClaims}`,
              ...(lastBrokerMaintenance.anomalies.length > 0
                ? [`Health: ${lastBrokerMaintenance.anomalies.join("; ")}`]
                : []),
            ]
          : [];
      ctx.ui.notify(
        [
          `Mode: ${mode}`,
          `Agent: ${agentEmoji} ${agentName}`,
          `Bot: ${botUserId ?? "unknown"}`,
          `Connection: ${socket}`,
          `Threads: ${threads.size} (${ownedCount} owned by ${agentName})`,
          `DM channel: ${lastDmChannel ?? "none yet"}`,
          allowlistInfo,
          defaultChInfo,
          ...brokerHealthInfo,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("pinet-rename", {
    description: "Rename this Pinet agent",
    handler: async (args, ctx) => {
      const newName = args.trim();
      if (!newName) {
        const fresh = generateAgentName();
        agentName = fresh.name;
        agentEmoji = fresh.emoji;
      } else {
        agentName = newName;
      }
      persistState();
      ctx.ui.notify(`${agentEmoji} Agent renamed to: ${agentName}`, "info");
    },
  });

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    slackRequests = createAbortableOperationTracker();
    remoteControlState = { currentCommand: null, queuedCommand: null };
    extCtx = ctx;
    const sessionHeader = (
      ctx.sessionManager as { getHeader?: () => { parentSession?: string } | null }
    ).getHeader?.();
    pinetRegistrationBlocked = isLikelyLocalSubagentContext({
      sessionHeader,
      argv: process.argv.slice(2),
    });

    // Restore persisted thread state (always restore, even before /pinet)
    interface PersistedState {
      threads?: [string, ThreadInfo][];
      lastDmChannel?: string | null;
      userNames?: [string, string][];
      agentName?: string;
      agentEmoji?: string;
      agentStableId?: string;
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
      const identitySeed = ctx.sessionManager.getSessionFile() ?? agentStableId;
      const restoredIdentity = resolveAgentIdentity(
        settings,
        process.env.PI_NICKNAME,
        identitySeed,
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
      }
      persistStateNow();
    } catch (err) {
      console.error(`[slack-bridge] restore failed: ${msg(err)}`);
    }

    try {
      const gitContext = await gitContextCache.get();
      if (gitContext.worktreeKind === "main" && gitContext.branch && gitContext.branch !== "main") {
        ctx.ui.notify(
          `Main checkout drift detected: on ${gitContext.branch}, expected main. Use a worktree for feature work.`,
          "warning",
        );
      }
    } catch {
      /* best effort */
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
    const drainedQueuedInbox = queuedInboxCount > 0 && (ctx ? (ctx.isIdle?.() ?? true) : false);
    if (drainedQueuedInbox) {
      drainInbox();
    }

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

    if (deliverFollowUpMessage(prompt)) {
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

  // Hard-block forbidden tools when broker role is active, and enforce worktree-only coding.
  pi.on("tool_call", async (event, ctx) => {
    if (brokerRole === "broker" && isBrokerForbiddenTool(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is forbidden for the broker role. The broker coordinates — it does not code. Use pinet_message to delegate to a connected worker instead.`,
      };
    }

    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") {
      const gitContext = await probeGitContext(ctx.cwd);
      const worktreeBlockReason = getMainCheckoutToolBlockReason(event.toolName, event.input, {
        worktreeKind: gitContext.worktreeKind,
        branch: gitContext.branch,
        cwd: ctx.cwd,
        repoRoot: gitContext.repoRoot,
      });
      if (worktreeBlockReason) {
        return {
          block: true,
          reason: worktreeBlockReason,
        };
      }
    }
  });

  // Inject dynamic identity guidance every turn so reload/session restore keeps prompts in sync.
  pi.on("before_agent_start", async (event) => {
    const guidelines = [...getIdentityGuidelines()];
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
    brokerRalphLoopFollowUpPending = false;

    signalAgentFree(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    remoteControlState = { currentCommand: null, queuedCommand: null };
    await stopPinetRuntime(ctx, { releaseIdentity: true });
    pinetRegistrationBlocked = false;
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
