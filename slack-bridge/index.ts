import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const SLACK_API = "https://slack.com/api";

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
  // Form-encode read methods (they reject JSON); JSON for everything else.
  const FORM_METHODS = new Set([
    "auth.test",
    "users.info",
    "conversations.list",
    "conversations.history",
    "conversations.replies",
    "conversations.info",
    "apps.connections.open",
  ]);
  const needsJson = !FORM_METHODS.has(method);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  let serialized: string | undefined;
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

  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers,
    body: serialized,
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? "3");
    await new Promise((r) => setTimeout(r, wait * 1000));
    return slack(method, token, body);
  }

  const data = (await res.json()) as SlackResult;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  return data;
}

// ─── Extension ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) return;

  const allowedUsers: Set<string> | null = process.env.SLACK_ALLOWED_USERS
    ? new Set(
        process.env.SLACK_ALLOWED_USERS.split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      )
    : null;

  function isUserAllowed(userId: string): boolean {
    return allowedUsers === null || allowedUsers.has(userId);
  }

  interface ThreadInfo {
    channelId: string;
    threadTs: string;
    userId: string;
    context?: { channelId: string; teamId: string };
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

  // ─── State persistence ──────────────────────────────

  function persistState(): void {
    pi.appendEntry("slack-bridge-state", {
      threads: Array.from(threads.entries()),
      lastDmChannel,
      userNames: Array.from(userNames.entries()),
    });
  }

  // ─── Inbox queue ────────────────────────────────────

  interface InboxMessage {
    channel: string;
    threadTs: string;
    userId: string;
    text: string;
    timestamp: string;
  }

  const inbox: InboxMessage[] = [];
  let extCtx: ExtensionContext | null = null; // cached for badge updates

  function updateBadge(): void {
    if (!extCtx?.hasUI) return;
    const t = extCtx.ui.theme;
    const n = inbox.length;
    const label = n > 0 ? t.fg("accent", `slack ✦ ${n}`) : t.fg("accent", "slack ✦");
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

  async function setThreadStatus(
    channelId: string,
    threadTs: string,
    status: string,
  ): Promise<void> {
    try {
      await slack("assistant.threads.setStatus", botToken!, {
        channel_id: channelId,
        thread_ts: threadTs,
        status,
      });
    } catch {
      /* non-critical */
    }
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
    try {
      await slack("assistant.threads.setSuggestedPrompts", botToken!, {
        channel_id: channelId,
        thread_ts: threadTs,
        prompts: [
          { title: "Status", message: "What are you working on right now?" },
          { title: "Help", message: "I need help with something in the codebase" },
          { title: "Review", message: "Summarise the recent changes" },
        ],
      });
    } catch {
      /* non-critical */
    }
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

    if (!isTracked && !isDM) return;

    const effectiveTs = threadTs ?? (evt.ts as string);

    // ── User allowlist check ──
    if (!isUserAllowed(user)) {
      await slack("chat.postMessage", botToken!, {
        channel,
        thread_ts: effectiveTs,
        text: "Sorry, I can only respond to authorized users. Please contact an admin if you need access.",
      });
      return;
    }

    // track if new
    if (!threads.has(effectiveTs)) {
      threads.set(effectiveTs, { channelId: channel, threadTs: effectiveTs, userId: user });
    }
    lastDmChannel = channel;
    persistState();

    const name = await resolveUser(user);
    ctx.ui.notify(`${name}: ${text.slice(0, 100)}`, "info");

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
      text,
      timestamp: (evt.ts as string) ?? effectiveTs,
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
        ? t.fg("warning", "slack ⟳")
        : state === "error"
          ? t.fg("error", "slack ✗")
          : "";
    ctx.ui.setStatus("slack-bridge", text);
  }

  // ─── Tools ──────────────────────────────────────────

  pi.registerTool({
    name: "slack_inbox",
    label: "Slack Inbox",
    description:
      "Return pending Slack messages that arrived since the last check, then clear the queue.",
    promptSnippet: "Check for new incoming Slack messages.",
    promptGuidelines: [
      "You are connected to Slack via the slack-bridge extension.",
      "New Slack messages are queued — call `slack_inbox` periodically (e.g. between tasks or when you see the badge count increase) to check for pending messages.",
      "Reply to each message with `slack_send`, passing the correct `thread_ts`.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (inbox.length === 0) {
        return {
          content: [{ type: "text", text: "(no new messages)" }],
          details: { count: 0 },
        };
      }

      const pending = inbox.splice(0, inbox.length);
      updateBadge();

      const lines: string[] = [];
      for (const m of pending) {
        const name = await resolveUser(m.userId);
        lines.push(`[thread ${m.threadTs}] ${name} (${m.timestamp}): ${m.text}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
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

      const body: Record<string, unknown> = { channel, text: params.text };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const res = await slack("chat.postMessage", botToken!, body);
      const ts = (res.message as { ts: string }).ts;
      const actualTs = params.thread_ts ?? ts;

      // track
      if (!threads.has(actualTs)) {
        threads.set(actualTs, { channelId: channel, threadTs: actualTs, userId: "" });
      }
      persistState();

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

  // ─── Commands ───────────────────────────────────────

  pi.registerCommand("slack", {
    description: "Show Slack assistant status",
    handler: async (_args, ctx) => {
      const socket = ws?.readyState === WebSocket.OPEN ? "connected" : "disconnected";
      const allowlistInfo = allowedUsers
        ? `Allowed users: ${[...allowedUsers].join(", ")}`
        : "Allowed users: all (no allowlist set)";
      ctx.ui.notify(
        [
          `Bot: ${botUserId ?? "unknown"}`,
          `Socket Mode: ${socket}`,
          `Threads: ${threads.size}`,
          `DM channel: ${lastDmChannel ?? "none yet"}`,
          allowlistInfo,
        ].join("\n"),
        "info",
      );
    },
  });

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    extCtx = ctx;

    // Restore persisted thread state
    interface PersistedState {
      threads?: [string, ThreadInfo][];
      lastDmChannel?: string | null;
      userNames?: [string, string][];
    }
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
    }

    try {
      const auth = await slack("auth.test", botToken!);
      botUserId = auth.user_id as string;
      setExtStatus(ctx, "reconnecting");
      await connectSocketMode(ctx);
    } catch (err) {
      ctx.ui.notify(`slack-bridge: ${msg(err)}`, "error");
      setExtStatus(ctx, "error");
    }
  });

  // Drain inbox: set thinking status, send to agent
  function drainInbox(): void {
    if (inbox.length === 0) return;

    const pending = inbox.splice(0, inbox.length);
    updateBadge();

    const lines = pending.map((m) => {
      const n = userNames.get(m.userId) ?? m.userId;
      return `[thread ${m.threadTs}] ${n}: ${m.text}`;
    });

    const prompt =
      `New Slack messages:\n${lines.join("\n")}\n\n` +
      `Respond to each via slack_send with the correct thread_ts.`;

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
    disconnect();
    setExtStatus(ctx, "off");
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
