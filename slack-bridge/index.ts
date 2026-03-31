import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  type InboxMessage,
  loadSettings as loadSettingsFromFile,
  buildAllowlist,
  isUserAllowed as checkUserAllowed,
  formatInboxMessages,
  stripBotMention,
  isChannelId,
  buildSlackRequest,
  generateAgentName,
  resolveAgentIdentity,
} from "./helpers.js";
import { startBroker, type BrokerDB } from "./broker/index.js";
import { SlackAdapter } from "./broker/adapters/slack.js";
import type { InboundMessage as BrokerInboundMessage } from "./broker/adapters/types.js";
import { MessageRouter } from "./broker/router.js";
import { BrokerClient, DEFAULT_SOCKET_PATH } from "./broker/client.js";

// ─── Slack API (raw fetch, zero deps) ────────────────────

interface SlackResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

async function slack(
  method: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<SlackResult> {
  const { url, init } = buildSlackRequest(method, token, body);
  const res = await fetch(url, init);

  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? "3");
    await new Promise((r) => setTimeout(r, wait * 1000));
    return slack(method, token, body);
  }

  const data = (await res.json()) as SlackResult;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  return data;
}

// Settings and helpers imported from ./helpers.js

// ─── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const settings = loadSettingsFromFile();

  const botToken = settings.botToken ?? process.env.SLACK_BOT_TOKEN;
  const appToken = settings.appToken ?? process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) return;

  // allowedUsers: settings.json takes priority, env var as fallback
  const allowedUsers = buildAllowlist(settings, process.env.SLACK_ALLOWED_USERS);

  function isUserAllowed(userId: string): boolean {
    return checkUserAllowed(allowedUsers, userId);
  }

  const identity = resolveAgentIdentity(settings, process.env.PI_NICKNAME);
  let agentName = identity.name;
  let agentEmoji = identity.emoji;

  function inboundToInbox(inMsg: BrokerInboundMessage): InboxMessage {
    return {
      channel: inMsg.channel,
      threadTs: inMsg.threadId,
      userId: inMsg.userId ?? "",
      text: inMsg.text ?? "",
      timestamp: inMsg.timestamp ?? "",
      isChannelMention: inMsg.isChannelMention,
    };
  }

  function getAgentMetadata(): Record<string, unknown> {
    let branch = "";
    try {
      branch = execSync("git branch --show-current", { encoding: "utf-8" }).trim();
    } catch {
      /* not in a git repo */
    }
    return {
      cwd: process.cwd(),
      branch,
      host: os.hostname(),
    };
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
  const userNames = new Map<string, string>();
  let lastDmChannel: string | null = null;
  const channelCache = new Map<string, string>();
  const unclaimedThreads = new Set<string>(); // negative cache for resolveThreadOwner

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
      console.error(`[slack-bridge] Socket Mode: ${msg(err)}`);
      scheduleReconnect(ctx);
    }
  }

  async function handleFrame(raw: string, ctx: ExtensionContext): Promise<void> {
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

    const name = await resolveUser(user);
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
      text: cleanText,
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

  function disconnect(): void {
    shuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
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

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: `Check for new incoming Slack messages. You are ${agentEmoji} ${agentName}.`,
    promptGuidelines: [
      "You are connected to Slack via the slack-bridge extension.",
      `Your Slack identity is ${agentEmoji} ${agentName} — use this name and emoji when replying in Slack threads.`,
      "New Slack messages are queued — call `slack_inbox` periodically (e.g. between tasks or when you see the badge count increase) to check for pending messages.",
      "Reply to each message with `slack_send`, passing the correct `thread_ts`.",
      `First message in a new thread: use full format — '${agentEmoji} (${agentName}) Just finished splitting the auth module.'`,
      `Follow-up messages in the same thread: just prefix with the emoji — '${agentEmoji} Found two more files to split.'`,
      "Always use this name and emoji — do not invent a new one.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (inbox.length === 0) {
        return {
          content: [
            { type: "text", text: `(no new messages) — you are ${agentEmoji} ${agentName}` },
          ],
          details: { count: 0 },
        };
      }

      const pending = inbox.splice(0, inbox.length);
      updateBadge();

      const lines: string[] = [];
      for (const m of pending) {
        const name = await resolveUser(m.userId);
        const prefix = m.isChannelMention
          ? `[thread ${m.threadTs}] (channel mention in <#${m.channel}>) ${name}`
          : `[thread ${m.threadTs}] ${name}`;
        lines.push(`${prefix} (${m.timestamp}): ${m.text}`);
      }

      return {
        content: [
          { type: "text", text: `You are ${agentEmoji} ${agentName}.\n\n${lines.join("\n")}` },
        ],
        details: { count: pending.length },
      };
    },
  });

  pi.registerTool({
    name: "slack_send",
    label: "Slack Send",
    description: "Send a message in a Slack assistant thread.",
    promptSnippet: "Reply in a Slack assistant thread.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(
        Type.String({
          description: "Thread to reply in. Omit to start a new conversation.",
        }),
      ),
    }),
    async execute(_id, params) {
      const thread = params.thread_ts ? threads.get(params.thread_ts) : undefined;
      const channel = thread?.channelId ?? lastDmChannel;

      if (!channel) {
        throw new Error("No active Slack thread. Wait for an incoming message first.");
      }

      const body: Record<string, unknown> = {
        channel,
        text: params.text,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: agentName },
        },
      };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const res = await slack("chat.postMessage", botToken!, body);
      const ts = (res.message as { ts: string }).ts;
      const actualTs = params.thread_ts ?? ts;

      // track + claim ownership (first-responder-wins)
      if (!threads.has(actualTs)) {
        threads.set(actualTs, {
          channelId: channel,
          threadTs: actualTs,
          userId: "",
          owner: agentName,
        });
      } else {
        const t = threads.get(actualTs)!;
        if (!t.owner) t.owner = agentName;
      }
      unclaimedThreads.delete(actualTs);
      persistState();

      // Claim in broker DB so inbound replies route back to us
      if (brokerRole === "broker" && activeRouter && activeSelfId) {
        activeRouter.claimThread(actualTs, activeSelfId);
      } else if (brokerRole === "follower" && brokerClient?.client) {
        void (brokerClient.client as BrokerClient).claimThread(actualTs, channel);
      }

      // Remove 👀 from all messages in this thread
      if (params.thread_ts) {
        const pending = pendingEyes.get(params.thread_ts);
        if (pending) {
          for (const p of pending) {
            void removeReaction(p.channel, p.messageTs, "eyes");
          }
          pendingEyes.delete(params.thread_ts);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts}.`
              : `Sent message (thread_ts: ${ts}). Use this to continue the conversation.`,
          },
        ],
        details: { ts, channel },
      };
    },
  });

  pi.registerTool({
    name: "slack_read",
    label: "Slack Read",
    description: "Read messages from a Slack assistant thread.",
    promptSnippet: "Read messages from a Slack assistant thread.",
    parameters: Type.Object({
      thread_ts: Type.String({ description: "Thread to read." }),
      limit: Type.Optional(Type.Number({ description: "Max messages (default 20)" })),
    }),
    async execute(_id, params) {
      const thread = threads.get(params.thread_ts);
      const channel = thread?.channelId ?? lastDmChannel;
      if (!channel) throw new Error("Unknown thread.");

      const res = await slack("conversations.replies", botToken!, {
        channel,
        ts: params.thread_ts,
        limit: params.limit ?? 20,
      });

      const msgs = res.messages as Record<string, unknown>[];
      const lines: string[] = [];

      for (const m of msgs) {
        const uid = m.user as string | undefined;
        const name = uid ? await resolveUser(uid) : "bot";
        const txt = (m.text as string) ?? "";
        const ts = m.ts as string;
        lines.push(`[${ts}] ${name}: ${txt}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: msgs.length },
      };
    },
  });

  pi.registerTool({
    name: "slack_create_channel",
    label: "Slack Create Channel",
    description: "Create a new Slack channel, optionally setting its topic and purpose.",
    promptSnippet: "Create a new Slack channel.",
    parameters: Type.Object({
      name: Type.String({
        description: "Channel name (lowercase, no spaces, max 80 chars)",
      }),
      topic: Type.Optional(Type.String({ description: "Channel topic" })),
      purpose: Type.Optional(Type.String({ description: "Channel purpose" })),
    }),
    async execute(_id, params) {
      const res = await slack("conversations.create", botToken!, {
        name: params.name,
      });
      const ch = res.channel as { id: string; name: string };

      if (params.topic) {
        await slack("conversations.setTopic", botToken!, {
          channel: ch.id,
          topic: params.topic,
        });
      }
      if (params.purpose) {
        await slack("conversations.setPurpose", botToken!, {
          channel: ch.id,
          purpose: params.purpose,
        });
      }

      channelCache.set(ch.name, ch.id);

      return {
        content: [{ type: "text", text: `Created channel #${ch.name} (${ch.id})` }],
        details: { id: ch.id, name: ch.name },
      };
    },
  });

  pi.registerTool({
    name: "slack_post_channel",
    label: "Slack Post Channel",
    description:
      "Post a message to a Slack channel (by name or ID), optionally in a thread. Uses defaultChannel from settings if channel is omitted.",
    promptSnippet: "Post a message to a Slack channel.",
    parameters: Type.Object({
      channel: Type.Optional(
        Type.String({
          description: "Channel name or ID (uses defaultChannel from settings if omitted)",
        }),
      ),
      text: Type.String({ description: "Message text (Slack markdown)" }),
      thread_ts: Type.Optional(Type.String({ description: "Thread timestamp to reply in" })),
    }),
    async execute(_id, params) {
      const channelInput = params.channel ?? settings.defaultChannel;
      if (!channelInput) {
        throw new Error("No channel specified and no defaultChannel configured in settings.json.");
      }
      const channelId = await resolveChannel(channelInput);
      const body: Record<string, unknown> = {
        channel: channelId,
        text: params.text,
        metadata: {
          event_type: "pi_agent_msg",
          event_payload: { agent: agentName },
        },
      };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const res = await slack("chat.postMessage", botToken!, body);
      const ts = (res.message as { ts: string }).ts;
      const actualTs = params.thread_ts ?? ts;

      // Track + claim ownership so inbound replies route back to us
      if (!threads.has(actualTs)) {
        threads.set(actualTs, {
          channelId,
          threadTs: actualTs,
          userId: "",
          owner: agentName,
        });
      } else {
        const t = threads.get(actualTs)!;
        if (!t.owner) t.owner = agentName;
      }
      unclaimedThreads.delete(actualTs);
      persistState();

      if (brokerRole === "broker" && activeRouter && activeSelfId) {
        activeRouter.claimThread(actualTs, activeSelfId);
      } else if (brokerRole === "follower" && brokerClient?.client) {
        void (brokerClient.client as BrokerClient).claimThread(actualTs, channelId);
      }

      return {
        content: [
          {
            type: "text",
            text: params.thread_ts
              ? `Replied in thread ${params.thread_ts} in channel ${channelInput}.`
              : `Posted to #${channelInput} (ts: ${ts}).`,
          },
        ],
        details: { ts, channel: channelId },
      };
    },
  });

  pi.registerTool({
    name: "slack_read_channel",
    label: "Slack Read Channel",
    description: "Read messages from a Slack channel or a thread within a channel.",
    promptSnippet: "Read messages from a Slack channel.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel name or ID" }),
      thread_ts: Type.Optional(
        Type.String({ description: "Thread timestamp to read replies from" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max messages to return (default 20)" })),
    }),
    async execute(_id, params) {
      const channelId = await resolveChannel(params.channel);
      const limit = params.limit ?? 20;

      let msgs: Record<string, unknown>[];
      if (params.thread_ts) {
        const res = await slack("conversations.replies", botToken!, {
          channel: channelId,
          ts: params.thread_ts,
          limit,
        });
        msgs = res.messages as Record<string, unknown>[];
      } else {
        const res = await slack("conversations.history", botToken!, {
          channel: channelId,
          limit,
        });
        msgs = (res.messages as Record<string, unknown>[]).reverse();
      }

      const lines: string[] = [];
      for (const m of msgs) {
        const uid = m.user as string | undefined;
        const name = uid ? await resolveUser(uid) : "bot";
        const txt = (m.text as string) ?? "";
        const ts = m.ts as string;
        lines.push(`[${ts}] ${name}: ${txt}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") || "(no messages)" }],
        details: { count: msgs.length, channel: channelId },
      };
    },
  });

  // ─── Agent-to-agent messaging tools ──────────────────

  // These are registered unconditionally but only work when pinet is active.
  // The variables they reference (pinetEnabled, brokerRole, activeBroker,
  // brokerClient) are declared in the Commands section just below.

  // Forward-declared — assigned in the Commands section below.
  let pinetEnabled = false;
  let brokerRole: "broker" | "follower" | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let activeBroker: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let brokerClient: any = null;
  let activeRouter: MessageRouter | null = null;
  let activeSelfId: string | null = null;

  pi.registerTool({
    name: "pinet_message",
    label: "Pinet Message",
    description: "Send a message to another connected Pinet agent.",
    promptSnippet: "Send a message to another connected Pinet agent.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name or ID" }),
      message: Type.String({ description: "Message body" }),
    }),
    async execute(_id, params) {
      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      if (brokerRole === "broker" && activeBroker) {
        // Direct DB access for broker mode
        const db = activeBroker.db as BrokerDB;
        const allAgents = db.getAgents();
        const target =
          allAgents.find((a: { id: string }) => a.id === params.to) ??
          allAgents.find((a: { name: string }) => a.name === params.to);

        if (!target) {
          throw new Error(`Agent not found: ${params.to}`);
        }

        const selfId = `broker-${process.pid}`;
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
        const client = brokerClient.client as BrokerClient;
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
    description: "List all connected Pinet agents.",
    promptSnippet: "List all connected Pinet agents.",
    parameters: Type.Object({}),
    async execute() {
      if (!pinetEnabled) {
        throw new Error("Pinet is not running. Use /pinet-start or /pinet-follow first.");
      }

      let agents: Array<{ emoji: string; name: string; id: string }>;
      if (brokerRole === "broker" && activeBroker) {
        agents = (activeBroker.db as BrokerDB).getAgents();
      } else if (brokerRole === "follower" && brokerClient) {
        agents = await (brokerClient.client as BrokerClient).listAgents();
      } else {
        throw new Error("Pinet is in an unexpected state.");
      }

      const lines = agents.map((a) => `${a.emoji} ${a.name} (${a.id})`);
      return {
        content: [
          {
            type: "text",
            text: lines.length > 0 ? lines.join("\n") : "(no agents connected)",
          },
        ],
        details: { agents },
      };
    },
  });

  // ─── Commands ───────────────────────────────────────

  pi.registerCommand("pinet-start", {
    description: "Start Pinet as the broker (Slack connection + message routing)",
    handler: async (_args, ctx) => {
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
        });

        const router = new MessageRouter(broker.db);
        const selfId = `broker-${process.pid}`;
        broker.db.registerAgent(selfId, agentName, agentEmoji, process.pid, getAgentMetadata());

        adapter.onInbound((inMsg) => {
          const decision = router.route(inMsg);
          if (decision.action === "deliver" && decision.agentId === selfId) {
            inbox.push(inboundToInbox(inMsg));
            updateBadge();
            if (ctx.isIdle?.()) drainInbox();
          } else if (decision.action === "deliver") {
            broker.db.queueMessage(decision.agentId, inMsg);
          } else if (decision.action === "unrouted") {
            inbox.push(inboundToInbox(inMsg));
            updateBadge();
            router.claimThread(inMsg.threadId, selfId);
            if (ctx.isIdle?.()) drainInbox();
          }
        });

        broker.addAdapter(adapter);
        await adapter.connect();
        botUserId = adapter.getBotUserId();

        activeBroker = broker;
        activeRouter = router;
        activeSelfId = selfId;
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
    const client = new BrokerClient();
    await client.connect();
    await client.register(agentName, agentEmoji);

    const pollInterval = setInterval(async () => {
      if (!pinetEnabled) return;
      try {
        const entries = await client.pollInbox();
        if (entries.length === 0) return;
        const ids: number[] = [];
        for (const entry of entries) {
          const meta = entry.message.metadata ?? {};
          inbox.push({
            channel: (meta.channel as string) ?? "",
            threadTs: entry.message.threadId ?? "",
            userId: entry.message.sender ?? "",
            text: entry.message.body ?? "",
            timestamp: entry.message.createdAt ?? "",
          });
          ids.push(entry.inboxId);
        }
        if (ids.length > 0) await client.ackMessages(ids);
        updateBadge();
        if (ctx.isIdle?.()) drainInbox();
      } catch {
        /* broker may be restarting */
      }
    }, 2000);

    client.onDisconnect(() => clearInterval(pollInterval));

    brokerClient = { client, pollInterval };
    brokerRole = "follower";
    pinetEnabled = true;
    setExtStatus(ctx, "ok");
  }

  pi.registerCommand("pinet-follow", {
    description: "Connect to an existing Pinet broker as a follower",
    handler: async (_args, ctx) => {
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
    extCtx = ctx;

    // Restore persisted thread state (always restore, even before /pinet)
    interface PersistedState {
      threads?: [string, ThreadInfo][];
      lastDmChannel?: string | null;
      userNames?: [string, string][];
      agentName?: string;
      agentEmoji?: string;
    }
    try {
      let savedState: PersistedState | null = null;
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "slack-bridge-state") {
          savedState = entry.data as PersistedState;
        }
      }
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
        if (savedState.agentName && savedState.agentEmoji) {
          agentName = savedState.agentName;
          agentEmoji = savedState.agentEmoji;
        }
      }
    } catch (err) {
      console.error(`[slack-bridge] restore failed: ${msg(err)}`);
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

  // Drain inbox: set thinking status, send to agent
  function drainInbox(): void {
    if (inbox.length === 0) return;

    const pending = inbox.splice(0, inbox.length);
    updateBadge();

    const prompt = formatInboxMessages(pending, userNames);

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

  // When agent finishes: clear thinking status + auto-drain inbox
  pi.on("agent_end", async () => {
    for (const ts of thinking) {
      const thread = threads.get(ts);
      if (thread) await clearThreadStatus(thread.channelId, ts);
    }
    thinking.clear();

    drainInbox();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    flushPersist();
    if (activeBroker) {
      try {
        await activeBroker.stop();
      } catch {
        /* best effort */
      }
      activeBroker = null;
    }
    activeRouter = null;
    activeSelfId = null;
    if (brokerClient) {
      try {
        clearInterval(brokerClient.pollInterval);
        brokerClient.client.disconnect();
      } catch {
        /* best effort */
      }
      brokerClient = null;
    }
    disconnect();
    brokerRole = null;
    pinetEnabled = false;
    setExtStatus(ctx, "off");
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
