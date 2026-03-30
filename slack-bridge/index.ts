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
  // Use JSON only when the body contains complex values (arrays/objects);
  // otherwise use form-encoded, which all Slack methods accept.
  const needsJson = body && Object.values(body).some((v) => typeof v === "object" && v !== null);

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
  const thinking = new Set<string>(); // thread_ts values showing "is thinking…"
  const userNames = new Map<string, string>();
  let lastDmChannel: string | null = null;

  // ─── Helpers ─────────────────────────────────────────

  async function resolveUser(userId: string): Promise<string> {
    const cached = userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await slack("users.info", botToken!, { user: userId });
      const u = res.user as { real_name?: string; name?: string };
      const name = u.real_name ?? u.name ?? userId;
      userNames.set(userId, name);
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

    // track if new
    if (!threads.has(effectiveTs)) {
      threads.set(effectiveTs, { channelId: channel, threadTs: effectiveTs, userId: user });
    }
    lastDmChannel = channel;

    // show "is thinking…"
    await setThreadStatus(channel, effectiveTs, "is thinking…");
    thinking.add(effectiveTs);

    // forward to pi
    const name = await resolveUser(user);
    let prompt = `[Slack from ${name}] ${text}`;
    prompt += `\n\n(Respond with slack_send, thread_ts "${effectiveTs}".)`;

    ctx.ui.notify(`${name}: ${text.slice(0, 100)}`, "info");

    try {
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    } catch {
      try {
        pi.sendUserMessage(prompt);
      } catch {
        /* ignore */
      }
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
    const t = ctx.ui.theme;
    const text =
      state === "ok"
        ? t.fg("accent", "slack ✦")
        : state === "reconnecting"
          ? t.fg("warning", "slack ⟳")
          : state === "error"
            ? t.fg("error", "slack ✗")
            : "";
    ctx.ui.setStatus("slack-bridge", text);
  }

  // ─── Tools ──────────────────────────────────────────

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

      // clear thinking status
      if (params.thread_ts && thinking.has(params.thread_ts)) {
        thinking.delete(params.thread_ts);
        await clearThreadStatus(channel, params.thread_ts);
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
      ctx.ui.notify(
        [
          `Bot: ${botUserId ?? "unknown"}`,
          `Socket Mode: ${socket}`,
          `Threads: ${threads.size}`,
          `DM channel: ${lastDmChannel ?? "none yet"}`,
        ].join("\n"),
        "info",
      );
    },
  });

  // ─── Lifecycle ──────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;

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

  // safety net: clear any lingering "is thinking…" when the agent finishes
  pi.on("agent_end", async () => {
    for (const ts of thinking) {
      const thread = threads.get(ts);
      if (thread) await clearThreadStatus(thread.channelId, ts);
    }
    thinking.clear();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disconnect();
    setExtStatus(ctx, "off");
  });
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
