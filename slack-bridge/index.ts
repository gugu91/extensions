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
  buildRalphLoopFollowUpMessage,
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
import { registerSlackTools } from "./slack-tools.js";
import {
  buildTaskAssignmentReport,
  extractTaskAssignmentsFromMessage,
  hasTaskAssignmentStatusChange,
  resolveTaskAssignments,
} from "./task-assignments.js";

// Settings and helpers imported from ./helpers.js

/**
 * Reference to the broker client with polling interval management.
 */
type BrokerClientRef = {
  client: BrokerClient;
  pollInterval: ReturnType<typeof setInterval> | null;
};

export default function (pi: ExtensionAPI) {
  const settings = loadSettingsFromFile();

  const botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
  const appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) return;

  let slackRequests = createAbortableOperationTracker();

  async function slack(method: string, token: string, body?: Record<string, unknown>) {
    return slackRequests.run((signal) => callSlackAPI(method, token, body, { signal }));
  }

  // allowedUsers: settings.json takes priority, env var as fallback
  const allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(allowedUsers, userId);
  }

  const initialIdentity = resolveAgentIdentity(settings, process.env.PI_NICKNAME, process.cwd());
  let agentName = initialIdentity.name;
  let agentEmoji = initialIdentity.emoji;
  let agentStableId = resolveAgentStableId(undefined, undefined, os.hostname(), process.cwd());

  // Security guardrails
  const guardrails: SecurityGuardrails = settings.security ?? {};
  const securityPrompt = buildSecurityPrompt(guardrails);

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
    botToken: botToken!,
    defaultChannel: settings.defaultChannel,
    securityPrompt,
    guardrails,
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
  let activeRouter: MessageRouter | null = null;
  let activeSelfId: string | null = null;
  let brokerHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
  let brokerRalphLoopTimer: ReturnType<typeof setInterval> | null = null;
  let brokerMaintenanceRunning = false;
  let brokerRalphLoopRunning = false;
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
      const followUpPrompt =
        ghostRewrite.newGhostIds.length === 0 &&
        ghostRewrite.clearedGhostIds.length > 0 &&
        ghostRewrite.nonGhostAnomalies.length === 0
          ? null
          : buildRalphLoopFollowUpMessage(visibleEvaluation);

      const agentsById = new Map(
        workloads.map((workload) => [workload.id, { emoji: workload.emoji, name: workload.name }]),
      );
      const trackedAssignments = db.listTaskAssignments();
      if (trackedAssignments.length === 0) {
        pendingBrokerTaskAssignmentReport = null;
        lastBrokerTaskAssignmentReport = "";
      } else {
        const resolvedAssignments = await resolveTaskAssignments(trackedAssignments, process.cwd());
        let taskAssignmentChanged = false;
        const projectedAssignments = resolvedAssignments.map((assignment) => {
          if (hasTaskAssignmentStatusChange(assignment)) {
            taskAssignmentChanged = true;
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

        if (taskAssignmentChanged) {
          pendingBrokerTaskAssignmentReport = buildTaskAssignmentReport(
            projectedAssignments,
            agentsById,
          );
        }
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
        ctx.ui.notify(`RALPH loop: ${visibleEvaluation.anomalies.join("; ")}`, "warning");
      } else if (shouldInform) {
        ctx.ui.notify(`RALPH loop: ${visibleEvaluation.anomalies.join("; ")}`, "info");
      } else if (!hasOutstandingAnomalies && lastBrokerRalphLoopHadOutstandingAnomalies) {
        ctx.ui.notify("RALPH loop health recovered", "info");
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
      ctx.ui.notify(`RALPH loop failed: ${msg(err)}`, "error");
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

  pi.registerTool({
    name: "pinet_message",
    label: "Pinet Message",
    description: "Send a message to another connected Pinet agent.",
    promptSnippet:
      "Send a message to another connected Pinet agent. When you send a task, sepcify the desired workflow, ideally something like `ack/work/ask/report`: ACK briefly, do the work, report blockers or questions immediately, report the outcome when done. Always reply where the task came from.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name or ID" }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params) {
      requireToolPolicy("pinet_message", undefined, `to=${params.to} | message=${params.message}`);

      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      if (brokerRole === "broker" && activeBroker) {
        // Direct DB access for broker mode
        const db = activeBroker.db;
        const allAgents = db.getAgents();
        const target =
          allAgents.find((a: { id: string }) => a.id === params.to) ??
          allAgents.find((a: { name: string }) => a.name === params.to);

        if (!target) {
          throw new Error(`Agent not found: ${params.to}`);
        }

        const selfId = activeSelfId;
        if (!selfId) {
          throw new Error("Broker agent identity is unavailable.");
        }
        const threadId = `a2a:${selfId}:${target.id}`;

        if (!db.getThread(threadId)) {
          db.createThread(threadId, "agent", "", selfId);
        }

        const msg = db.insertMessage(
          threadId,
          "agent",
          "inbound",
          selfId,
          params.message,
          [target.id],
          { senderAgent: agentName, a2a: true },
        );

        for (const assignment of extractTaskAssignmentsFromMessage(params.message)) {
          db.recordTaskAssignment(
            target.id,
            assignment.issueNumber,
            assignment.branch,
            threadId,
            msg.id,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Message sent to ${target.name} (id: ${msg.id}).`,
            },
          ],
          details: { messageId: msg.id, target: target.name },
        };
      } else if (brokerRole === "follower" && brokerClient) {
        const client = brokerClient.client;
        const messageId = await client.sendAgentMessage(params.to, params.message);

        return {
          content: [{ type: "text", text: `Message sent to ${params.to} (id: ${messageId}).` }],
          details: { messageId, target: params.to },
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

        const router = new MessageRouter(broker.db);
        const selfAgent = broker.db.registerAgent(
          ctx.sessionManager.getLeafId() ?? `broker-${process.pid}`,
          agentName,
          agentEmoji,
          process.pid,
          await getAgentMetadata("broker"),
          agentStableId,
        );
        const selfId = selfAgent.id;
        applyBrokerIdentity(selfAgent.name, selfAgent.emoji);

        const recoveredBrokerMessages = broker.db.requeueUndeliveredMessages(
          selfId,
          "broker_delegate",
        );
        const releasedBrokerClaims = broker.db.releaseThreadClaims(selfId);
        if (recoveredBrokerMessages > 0 || releasedBrokerClaims > 0) {
          ctx.ui.notify(
            `Pinet broker reclaimed ${recoveredBrokerMessages} message${recoveredBrokerMessages === 1 ? "" : "s"} and released ${releasedBrokerClaims} broker-owned thread claim${releasedBrokerClaims === 1 ? "" : "s"}`,
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
            // Previously, broker-routed messages were queued to `unrouted_backlog` with
            // reason "broker_delegate" and then assigned to random workers by maintenance.
            // Since maintenance explicitly excludes the broker from assignment candidates,
            // the messages ended up on the wrong agent. Fix: always deliver to the broker
            // in-memory inbox so it can handle them directly. (#121)
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

        // When a worker sends a pinet_message targeting the broker, the
        // socket server writes to the DB inbox but the broker only reads
        // its in-memory inbox.  Bridge the gap here: push a2a messages
        // targeting ourselves into the in-memory inbox and trigger drain.
        broker.server.onAgentMessage((targetAgentId, brokerMsg, meta) => {
          if (targetAgentId !== selfId) return;
          const senderName = (meta.senderAgent as string) ?? brokerMsg.sender;
          inbox.push({
            channel: "",
            threadTs: brokerMsg.threadId,
            userId: senderName,
            text: brokerMsg.body,
            timestamp: brokerMsg.createdAt,
          });
          // Mark delivered so the DB row doesn't linger.
          broker.db.markDeliveredByMessageId(brokerMsg.id, selfId);
          updateBadge();
          if (extCtx?.isIdle?.()) drainInbox();
        });

        startBrokerHeartbeat();
        startBrokerMaintenance(ctx);
        startBrokerRalphLoop(ctx);
        brokerRole = "broker";
        pinetEnabled = true;
        setExtStatus(ctx, "ok");
        ctx.ui.notify(`${agentEmoji} ${agentName} — broker started (${botUserId})`, "info");
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
    let wasDisconnected = false;

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
        if (!pinetEnabled) return;
        try {
          const entries = await client.pollInbox();
          if (entries.length === 0) return;

          // #102: Partition nudges from regular messages for direct delivery
          const { nudges, regular } = partitionFollowerInboxEntries(entries);

          // Deliver nudges immediately via pi.sendUserMessage (followUp)
          if (nudges.length > 0) {
            const nudgeText = nudges
              .map((n) => n.message.body ?? "")
              .filter(Boolean)
              .join("\n");
            if (nudgeText) {
              try {
                pi.sendUserMessage(nudgeText, { deliverAs: "followUp" });
              } catch {
                try {
                  pi.sendUserMessage(nudgeText);
                } catch {
                  /* best effort */
                }
              }
            }
          }

          // Process regular messages through normal inbox flow
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

          // ACK all entries (nudges + regular)
          const ids = entries.map((entry) => entry.inboxId);
          if (synced.changed) persistState();
          if (ids.length > 0) await client.ackMessages(ids);
          updateBadge();
          if (ctx.isIdle?.()) drainInbox();
        } catch {
          /* broker may be restarting */
        }
      }, 2000);
    }

    function stopPolling(): void {
      if (brokerClientRef.pollInterval) {
        clearInterval(brokerClientRef.pollInterval);
        brokerClientRef.pollInterval = null;
      }
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
        // #103: Re-report idle/working status on reconnect for resilience
        const currentlyIdle = ctx.isIdle?.() ?? true;
        void client.updateStatus(currentlyIdle ? "idle" : "working").catch(() => {
          /* best effort */
        });
        startPolling();
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

  // Drain inbox: set thinking status, send to agent
  function drainInbox(): void {
    if (inbox.length === 0) return;

    const pending = inbox.splice(0, inbox.length);
    updateBadge();
    reportStatus("working");

    let prompt = formatInboxMessages(pending, userNames);

    // Prepend security guardrails if configured
    if (securityPrompt) {
      prompt = securityPrompt + "\n\n" + prompt;
    }

    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch {
      try {
        pi.sendUserMessage(prompt);
      } catch {
        inbox.push(...pending);
        updateBadge();
      }
    }
  }

  // Hard-block forbidden tools when broker role is active.
  pi.on("tool_call", async (event) => {
    if (brokerRole === "broker" && isBrokerForbiddenTool(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is forbidden for the broker role. The broker coordinates — it does not code. Use pinet_message to delegate to a connected worker instead.`,
      };
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

  // When agent finishes: clear thinking status + auto-drain inbox
  pi.on("agent_end", async () => {
    for (const ts of thinking) {
      const thread = threads.get(ts);
      if (thread) await clearThreadStatus(thread.channelId, ts);
    }
    thinking.clear();
    brokerRalphLoopFollowUpPending = false;

    reportStatus("idle");
    drainInbox();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    stopBrokerHeartbeat();
    stopBrokerMaintenance();
    stopBrokerRalphLoop();
    await disconnect();
    flushPersist();
    if (activeBroker) {
      try {
        if (activeSelfId) {
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
    if (brokerClient) {
      try {
        if (brokerClient.pollInterval) {
          clearInterval(brokerClient.pollInterval);
        }
        await brokerClient.client.unregister().catch(() => {
          /* best effort */
        });
        brokerClient.client.disconnect();
      } catch {
        /* best effort */
      }
      brokerClient = null;
    }
    brokerRole = null;
    pinetEnabled = false;
    pinetRegistrationBlocked = false;
    setExtStatus(ctx, "off");
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
