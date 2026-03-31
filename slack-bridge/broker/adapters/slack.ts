import {
  buildSlackRequest,
  buildAllowlist,
  isUserAllowed,
  stripBotMention,
} from "../../helpers.js";
import type { InboundMessage, OutboundMessage, MessageAdapter } from "./types.js";

// ─── Config ──────────────────────────────────────────────

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  allowedUsers?: string[];
  suggestedPrompts?: { title: string; message: string }[];
  /** Check whether a thread_ts belongs to a thread the bot owns in the broker DB. */
  isOwnedThread?: (threadTs: string) => boolean;
}

// ─── Slack API result ────────────────────────────────────

interface SlackResult {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

// ─── Internal thread tracking ────────────────────────────

interface SlackThreadInfo {
  channelId: string;
  threadTs: string;
  userId: string;
  context?: { channelId: string; teamId: string };
}

// ─── Slack API wrapper ───────────────────────────────────

const SLACK_MAX_RETRIES = 3;

async function callSlack(
  method: string,
  token: string,
  body?: Record<string, unknown>,
  _retryCount = 0,
): Promise<SlackResult> {
  const { url, init } = buildSlackRequest(method, token, body);
  const res = await fetch(url, init);

  if (res.status === 429) {
    if (_retryCount >= SLACK_MAX_RETRIES) {
      throw new Error(`Slack ${method}: rate limited after ${SLACK_MAX_RETRIES} retries`);
    }
    const wait = Number(res.headers.get("retry-after") ?? "3");
    await new Promise((r) => setTimeout(r, wait * 1000));
    return callSlack(method, token, body, _retryCount + 1);
  }

  const data = (await res.json()) as SlackResult;
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error ?? "unknown error"}`);
  return data;
}

// ─── Pure parsing functions (exported for testing) ───────

export interface ParsedEnvelope {
  envelopeId?: string;
  type: string;
  event?: Record<string, unknown>;
}

/**
 * Parse a raw Socket Mode WebSocket frame into a structured envelope.
 * Returns null if the frame is malformed JSON.
 */
export function parseSocketFrame(raw: string): ParsedEnvelope | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const result: ParsedEnvelope = {
      type: (data.type as string) ?? "",
    };
    if (data.envelope_id) {
      result.envelopeId = data.envelope_id as string;
    }
    if (data.type === "events_api") {
      const payload = data.payload as { event?: Record<string, unknown> } | undefined;
      result.event = payload?.event;
    }
    return result;
  } catch {
    /* malformed JSON */
    return null;
  }
}

export interface ParsedThreadStarted {
  channelId: string;
  threadTs: string;
  userId: string;
  context?: { channelId: string; teamId: string };
}

/**
 * Extract thread info from an assistant_thread_started event.
 */
export function extractThreadStarted(evt: Record<string, unknown>): ParsedThreadStarted | null {
  const t = evt.assistant_thread as Record<string, unknown> | undefined;
  if (!t) return null;

  const result: ParsedThreadStarted = {
    channelId: t.channel_id as string,
    threadTs: t.thread_ts as string,
    userId: t.user_id as string,
  };

  const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
  if (ctx?.channel_id) {
    result.context = { channelId: ctx.channel_id, teamId: ctx.team_id ?? "" };
  }

  return result;
}

/**
 * Classification result for an incoming message event.
 * Uses a discriminated union so TypeScript narrows fields when relevant is true.
 */
export type MessageClassification =
  | { relevant: false }
  | {
      relevant: true;
      threadTs: string;
      channel: string;
      userId: string;
      text: string;
      isDM: boolean;
      isChannelMention: boolean;
      messageTs: string;
    };

/**
 * Classify an incoming Slack message event. Determines whether the
 * message is relevant (DM, tracked thread, or bot mention) and
 * extracts the cleaned fields.
 */
export function classifyMessage(
  evt: Record<string, unknown>,
  botUserId: string | null,
  trackedThreadIds: Set<string>,
  isOwnedThread?: (threadTs: string) => boolean,
): MessageClassification {
  // Skip bot messages and messages with subtypes (joins, edits, etc.)
  if (evt.subtype || evt.bot_id) return { relevant: false };

  const text = (evt.text as string) ?? "";
  const user = evt.user as string;
  const threadTs = evt.thread_ts as string | undefined;
  const channel = evt.channel as string;
  const channelType = evt.channel_type as string | undefined;

  const isTracked = !!threadTs && trackedThreadIds.has(threadTs);
  const isOwned = !isTracked && !!threadTs && (isOwnedThread?.(threadTs) ?? false);
  const isDM = channelType === "im";
  const isMention = botUserId != null && text.includes(`<@${botUserId}>`);

  if (!isTracked && !isOwned && !isDM && !isMention) return { relevant: false };

  const effectiveTs = threadTs ?? (evt.ts as string);
  const isChannelMention = isMention && !isDM && !isTracked && !isOwned;

  const cleanText = isChannelMention && botUserId ? stripBotMention(text, botUserId) : text;

  return {
    relevant: true,
    threadTs: effectiveTs,
    channel,
    userId: user,
    text: cleanText,
    isDM,
    isChannelMention,
    messageTs: (evt.ts as string) ?? effectiveTs,
  };
}

/**
 * Parse a member_joined_channel event. Returns null if required fields
 * are missing.
 */
export function parseMemberJoinedChannel(
  evt: Record<string, unknown>,
  botUserId: string | null,
): { channel: string; isSelf: boolean } | null {
  const user = evt.user as string | undefined;
  const channel = evt.channel as string | undefined;
  if (!user || !channel) return null;
  return { channel, isSelf: user === botUserId };
}

// ─── Reconnect delay (exported for testing) ──────────────

export const RECONNECT_DELAY_MS = 5000;

// ─── Slack Adapter ───────────────────────────────────────

export class SlackAdapter implements MessageAdapter {
  readonly name = "slack";

  private readonly config: SlackAdapterConfig;
  private readonly allowlist: Set<string> | null;
  private botUserId: string | null = null;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;

  private readonly threads = new Map<string, SlackThreadInfo>();
  private readonly userNames = new Map<string, string>();
  private readonly pendingEyes = new Map<string, { channel: string; messageTs: string }[]>();

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.allowlist = buildAllowlist({ allowedUsers: config.allowedUsers }, undefined);
  }

  // ─── MessageAdapter interface ─────────────────────────

  async connect(): Promise<void> {
    this.shuttingDown = false;
    const auth = await callSlack("auth.test", this.config.botToken);
    this.botUserId = auth.user_id as string;
    await this.connectSocketMode();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore close errors */
    }
    this.ws = null;
  }

  onInbound(handler: (msg: InboundMessage) => void): void {
    this.inboundHandler = handler;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const body: Record<string, unknown> = {
      channel: msg.channel,
      text: msg.text,
      thread_ts: msg.threadId,
    };

    if (msg.agentName ?? msg.metadata) {
      body.metadata = {
        event_type: "pi_agent_msg",
        event_payload: {
          ...(msg.agentName ? { agent: msg.agentName } : {}),
          ...(msg.agentEmoji ? { emoji: msg.agentEmoji } : {}),
          ...msg.metadata,
        },
      };
    }

    await callSlack("chat.postMessage", this.config.botToken, body);

    // Remove pending eyes for this thread
    const pending = this.pendingEyes.get(msg.threadId);
    if (pending) {
      for (const p of pending) {
        void this.removeReaction(p.channel, p.messageTs, "eyes");
      }
      this.pendingEyes.delete(msg.threadId);
    }

    // Clear thread status
    void this.clearThreadStatus(msg.channel, msg.threadId);
  }

  // ─── Getters (for inspection / testing) ────────────────

  getBotUserId(): string | null {
    return this.botUserId;
  }

  getTrackedThreadIds(): Set<string> {
    return new Set(this.threads.keys());
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Socket Mode connection ────────────────────────────

  private async connectSocketMode(): Promise<void> {
    if (this.shuttingDown) return;

    try {
      const res = await callSlack("apps.connections.open", this.config.appToken);
      this.ws = new WebSocket(res.url as string);

      this.ws.addEventListener("message", (event) => {
        void this.handleFrame(String(event.data));
      });

      this.ws.addEventListener("close", () => {
        if (!this.shuttingDown) this.scheduleReconnect();
      });

      this.ws.addEventListener("error", () => {
        /* close fires after error — handled there */
      });
    } catch (err) {
      console.error(`[slack-adapter] Socket Mode: ${errorMsg(err)}`);
      this.scheduleReconnect();
    }
  }

  private async handleFrame(raw: string): Promise<void> {
    const envelope = parseSocketFrame(raw);
    if (!envelope) return;

    // ACK every envelope
    if (envelope.envelopeId) {
      this.ws?.send(JSON.stringify({ envelope_id: envelope.envelopeId }));
    }

    if (envelope.type === "disconnect") {
      this.scheduleReconnect();
      return;
    }

    if (!envelope.event) return;

    const evt = envelope.event;

    switch (evt.type) {
      case "assistant_thread_started":
        await this.onThreadStarted(evt);
        break;
      case "assistant_thread_context_changed":
        this.onContextChanged(evt);
        break;
      case "message":
        await this.onMessage(evt);
        break;
      case "member_joined_channel":
        this.onMemberJoined(evt);
        break;
    }
  }

  // ─── Event handlers ────────────────────────────────────

  private async onThreadStarted(evt: Record<string, unknown>): Promise<void> {
    const parsed = extractThreadStarted(evt);
    if (!parsed) return;

    const info: SlackThreadInfo = {
      channelId: parsed.channelId,
      threadTs: parsed.threadTs,
      userId: parsed.userId,
    };

    if (parsed.context) {
      info.context = parsed.context;
    }

    this.threads.set(info.threadTs, info);
    await this.setSuggestedPrompts(info.channelId, info.threadTs);
  }

  private onContextChanged(evt: Record<string, unknown>): void {
    const t = evt.assistant_thread as Record<string, unknown> | undefined;
    if (!t) return;

    const existing = this.threads.get(t.thread_ts as string);
    if (!existing) return;

    const ctx = t.context as { channel_id?: string; team_id?: string } | undefined;
    if (ctx?.channel_id) {
      existing.context = {
        channelId: ctx.channel_id,
        teamId: ctx.team_id ?? "",
      };
    }
  }

  private async onMessage(evt: Record<string, unknown>): Promise<void> {
    const classified = classifyMessage(
      evt,
      this.botUserId,
      this.getTrackedThreadIds(),
      this.config.isOwnedThread,
    );
    if (!classified.relevant) return;

    const { threadTs, channel, userId, text, isChannelMention, messageTs } = classified;

    // Track thread if new
    if (!this.threads.has(threadTs)) {
      this.threads.set(threadTs, {
        channelId: channel,
        threadTs,
        userId,
      });
    }

    // Allowlist check — silently drop unauthorized users
    if (!isUserAllowed(this.allowlist, userId)) return;

    // React with eyes to acknowledge
    void this.addReaction(channel, messageTs, "eyes");
    const pending = this.pendingEyes.get(threadTs) ?? [];
    pending.push({ channel, messageTs });
    this.pendingEyes.set(threadTs, pending);

    // Resolve user name
    const userName = await this.resolveUser(userId);

    // Emit inbound message
    this.inboundHandler?.({
      source: "slack",
      threadId: threadTs,
      channel,
      userId,
      userName,
      text,
      timestamp: messageTs,
      ...(isChannelMention ? { isChannelMention: true } : {}),
    });
  }

  private onMemberJoined(evt: Record<string, unknown>): void {
    const parsed = parseMemberJoinedChannel(evt, this.botUserId);
    if (!parsed || !parsed.isSelf) return;

    this.inboundHandler?.({
      source: "slack",
      threadId: "",
      channel: parsed.channel,
      userId: "system",
      text: `Bot was added to channel ${parsed.channel}`,
      timestamp: String(Date.now() / 1000),
    });
  }

  // ─── Slack API helpers ─────────────────────────────────

  private async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await callSlack("reactions.add", this.config.botToken, {
        channel,
        timestamp: ts,
        name: emoji,
      });
    } catch {
      /* already_reacted or non-critical */
    }
  }

  private async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await callSlack("reactions.remove", this.config.botToken, {
        channel,
        timestamp: ts,
        name: emoji,
      });
    } catch {
      /* not_reacted or non-critical */
    }
  }

  private async resolveUser(userId: string): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await callSlack("users.info", this.config.botToken, {
        user: userId,
      });
      const u = res.user as { real_name?: string; name?: string };
      const name = u.real_name ?? u.name ?? userId;
      this.userNames.set(userId, name);
      return name;
    } catch {
      /* non-critical — return raw userId */
      return userId;
    }
  }

  private async clearThreadStatus(channelId: string, threadTs: string): Promise<void> {
    try {
      await callSlack("assistant.threads.setStatus", this.config.botToken, {
        channel_id: channelId,
        thread_ts: threadTs,
        status: "",
      });
    } catch {
      /* non-critical */
    }
  }

  private async setSuggestedPrompts(channelId: string, threadTs: string): Promise<void> {
    const prompts = this.config.suggestedPrompts ?? [
      { title: "Status", message: "What are you working on right now?" },
      { title: "Help", message: "I need help with something in the codebase" },
      { title: "Review", message: "Summarise the recent changes" },
    ];
    try {
      await callSlack("assistant.threads.setSuggestedPrompts", this.config.botToken, {
        channel_id: channelId,
        thread_ts: threadTs,
        prompts,
      });
    } catch {
      /* non-critical */
    }
  }

  // ─── Reconnect ─────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectSocketMode();
    }, RECONNECT_DELAY_MS);
  }
}

// ─── Utility ─────────────────────────────────────────────

function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
