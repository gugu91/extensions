import {
  addSlackReaction,
  buildSlackThreadRuntimeScope,
  classifyMessage,
  clearSlackThreadStatus,
  extractAppHomeOpened,
  extractThreadContextChanged,
  extractThreadStarted,
  fetchSlackMessageByTs,
  isSlackUserAllowed,
  removeSlackReaction,
  resolveSlackUserName,
  setSlackSuggestedPrompts,
  SlackSocketModeClient,
  type ParsedAppHomeOpened,
  type ParsedThreadContextChanged,
  type ParsedThreadStarted,
} from "../../slack-access.js";
import {
  createAbortableOperationTracker,
  callSlackAPI,
  isAbortError,
  buildAllowlist,
} from "../../helpers.js";
import {
  buildReactionTriggerMessage,
  normalizeReactionName,
  resolveReactionCommands,
  type ReactionCommandSettings,
} from "../../reaction-triggers.js";
import { TtlCache, TtlSet } from "../../ttl-cache.js";
import {
  SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
  SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
} from "../../slack-access.js";
import type { InboundMessage, OutboundMessage, MessageAdapter } from "./types.js";

export {
  classifyMessage,
  extractAppHomeOpened,
  extractThreadStarted,
  parseMemberJoinedChannel,
  parseSocketFrame,
  RECONNECT_DELAY_MS,
} from "../../slack-access.js";

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  allowedUsers?: string[];
  allowAllWorkspaceUsers?: boolean;
  suggestedPrompts?: { title: string; message: string }[];
  reactionCommands?: ReactionCommandSettings;
  /** Check whether a thread_ts belongs to a known thread in the broker DB. */
  isKnownThread?: (threadTs: string) => boolean;
  /** Persist thread metadata in the broker DB without claiming ownership. */
  rememberKnownThread?: (threadTs: string, channelId: string) => void;
  /** Best-effort callback for Home tab opens. */
  onAppHomeOpened?: (event: ParsedAppHomeOpened) => Promise<void> | void;
}

interface SlackThreadInfo {
  channelId: string;
  threadTs: string;
  userId: string;
  context?: ParsedThreadStarted["context"];
}

export class SlackAdapter implements MessageAdapter {
  readonly name = "slack";

  private readonly config: SlackAdapterConfig;
  private readonly allowlist: Set<string> | null;
  private slackRequests = createAbortableOperationTracker();
  private botUserId: string | null = null;
  private socketMode: SlackSocketModeClient | null = null;
  private shuttingDown = false;
  private inboundHandler: ((msg: InboundMessage) => void) | null = null;
  private readonly reactionCommands: Map<string, { action: string; prompt: string }>;

  private readonly threads = new Map<string, SlackThreadInfo>();
  private readonly userNames = new TtlCache<string, string>({
    maxSize: 2000,
    ttlMs: 60 * 60 * 1000,
  });
  private readonly processedSocketDeliveries = new TtlSet<string>({
    maxSize: SLACK_SOCKET_DELIVERY_DEDUP_MAX_SIZE,
    ttlMs: SLACK_SOCKET_DELIVERY_DEDUP_TTL_MS,
  });
  private readonly pendingEyes = new Map<string, { channel: string; messageTs: string }[]>();

  constructor(config: SlackAdapterConfig) {
    this.config = config;
    this.allowlist = buildAllowlist(
      {
        allowedUsers: config.allowedUsers,
        allowAllWorkspaceUsers: config.allowAllWorkspaceUsers,
      },
      undefined,
      undefined,
    );
    this.reactionCommands = resolveReactionCommands(config.reactionCommands);
  }

  private async callSlack(method: string, token: string, body?: Record<string, unknown>) {
    return this.slackRequests.run((signal) => callSlackAPI(method, token, body, { signal }));
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.slackRequests = createAbortableOperationTracker();
    this.socketMode = new SlackSocketModeClient({
      slack: this.callSlack.bind(this),
      botToken: this.config.botToken,
      appToken: this.config.appToken,
      dedup: this.processedSocketDeliveries,
      abortAndWait: () => this.slackRequests.abortAndWait(),
      onThreadStarted: (event) => this.onThreadStarted(event),
      onThreadContextChanged: (event) => this.onContextChanged(event),
      onMessage: (event) => this.onMessage(event),
      onReactionAdded: (event) => this.onReactionAdded(event),
      onMemberJoinedChannel: (event) => this.onMemberJoined(event),
      onAppHomeOpened: (event) => this.onAppHomeOpened(event),
      onInteractive: (event) => this.emitInteractiveInbound(event),
      onError: (error) => {
        if (!isAbortError(error)) {
          console.error(`[slack-adapter] Socket Mode: ${errorMsg(error)}`);
        }
      },
    });
    await this.socketMode.connect();
    this.botUserId = this.socketMode.getBotUserId();
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    const socketMode = this.socketMode;
    this.socketMode = null;
    if (socketMode) {
      await socketMode.disconnect();
      return;
    }
    await this.slackRequests.abortAndWait();
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
    const scope = msg.scope ?? this.resolveScopeForThread(msg.threadId, msg.channel);

    if (msg.agentName ?? msg.agentOwnerToken ?? msg.metadata ?? msg.scope) {
      body.metadata = {
        event_type: "pi_agent_msg",
        event_payload: {
          ...(msg.agentName ? { agent: msg.agentName } : {}),
          ...(msg.agentOwnerToken ? { agent_owner: msg.agentOwnerToken } : {}),
          ...(msg.agentEmoji ? { emoji: msg.agentEmoji } : {}),
          ...(scope ? { scope } : {}),
          ...msg.metadata,
        },
      };
    }

    await this.callSlack("chat.postMessage", this.config.botToken, body);
    if (this.shuttingDown) return;

    const pending = this.pendingEyes.get(msg.threadId);
    if (pending) {
      for (const entry of pending) {
        void this.removeReaction(entry.channel, entry.messageTs, "eyes");
      }
      this.pendingEyes.delete(msg.threadId);
    }

    void this.clearThreadStatus(msg.channel, msg.threadId);
  }

  getBotUserId(): string | null {
    return this.socketMode?.getBotUserId() ?? this.botUserId;
  }

  getTrackedThreadIds(): Set<string> {
    return new Set(this.threads.keys());
  }

  isConnected(): boolean {
    return this.socketMode?.isConnected() ?? false;
  }

  private resolveScopeForThread(threadTs: string, channelId: string) {
    return buildSlackThreadRuntimeScope({
      channelId,
      context: this.threads.get(threadTs)?.context ?? null,
    });
  }

  private async onThreadStarted(
    event: ParsedThreadStarted | Record<string, unknown>,
  ): Promise<void> {
    if (this.shuttingDown) return;

    const parsed = isParsedThreadStarted(event) ? event : extractThreadStarted(event);
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
    try {
      this.config.rememberKnownThread?.(info.threadTs, info.channelId);
    } catch {
      /* best effort — DB cache sync must not break Slack event handling */
    }
    await this.setSuggestedPrompts(info.channelId, info.threadTs);
  }

  private onContextChanged(event: ParsedThreadContextChanged | Record<string, unknown>): void {
    if (this.shuttingDown) return;

    const parsed = isParsedThreadContextChanged(event) ? event : extractThreadContextChanged(event);
    if (!parsed) return;

    const existing = this.threads.get(parsed.threadTs);
    if (!existing || !parsed.context) return;

    existing.context = parsed.context;
  }

  private async onAppHomeOpened(
    event: ParsedAppHomeOpened | Record<string, unknown>,
  ): Promise<void> {
    if (this.shuttingDown) return;

    const parsed = isParsedAppHomeOpened(event) ? event : extractAppHomeOpened(event);
    if (!parsed || parsed.tab !== "home") {
      return;
    }

    try {
      await this.config.onAppHomeOpened?.(parsed);
    } catch (error) {
      console.error(`[slack-adapter] Home tab callback failed: ${errorMsg(error)}`);
    }
  }

  private async fetchMessageByTs(
    channel: string,
    messageTs: string,
  ): Promise<Record<string, unknown> | null> {
    return fetchSlackMessageByTs({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      messageTs,
    });
  }

  private async onReactionAdded(evt: Record<string, unknown>): Promise<void> {
    if (this.shuttingDown) return;

    const item = evt.item as { type?: string; channel?: string; ts?: string } | undefined;
    const userId = evt.user as string | undefined;
    const rawReaction = evt.reaction as string | undefined;
    if (!item || item.type !== "message" || !item.channel || !item.ts || !userId || !rawReaction) {
      return;
    }

    if (userId === this.botUserId) return;

    let reactionName: string;
    try {
      reactionName = normalizeReactionName(rawReaction);
    } catch {
      return;
    }

    const command = this.reactionCommands.get(reactionName);
    if (!command || !isSlackUserAllowed(this.allowlist, userId)) {
      return;
    }

    try {
      const reactedMessage = await this.fetchMessageByTs(item.channel, item.ts);
      if (!reactedMessage) {
        throw new Error(`Unable to fetch reacted message ${item.ts} in channel ${item.channel}`);
      }

      const threadTs =
        (reactedMessage.thread_ts as string | undefined) ??
        (reactedMessage.ts as string | undefined) ??
        item.ts;

      if (!this.threads.has(threadTs)) {
        this.threads.set(threadTs, {
          channelId: item.channel,
          threadTs,
          userId: (reactedMessage.user as string | undefined) ?? userId,
        });
        try {
          this.config.rememberKnownThread?.(threadTs, item.channel);
        } catch {
          /* best effort — DB cache sync must not break reaction handling */
        }
      }

      const reactorName = await this.resolveUser(userId);
      if (this.shuttingDown) return;
      const reactedMessageAuthorId =
        (reactedMessage.user as string | undefined) ?? (evt.item_user as string | undefined);
      const reactedMessageAuthor = reactedMessageAuthorId
        ? await this.resolveUser(reactedMessageAuthorId)
        : (reactedMessage.bot_id as string | undefined)
          ? "bot"
          : "unknown";
      if (this.shuttingDown) return;

      const reactedMessageText =
        typeof reactedMessage.text === "string" && reactedMessage.text.trim().length > 0
          ? reactedMessage.text
          : "(no text)";

      const threadInfo = this.threads.get(threadTs);
      this.inboundHandler?.({
        source: "slack",
        threadId: threadTs,
        channel: item.channel,
        userId,
        userName: reactorName,
        text: buildReactionTriggerMessage({
          reactionName,
          command,
          reactorName,
          channel: item.channel,
          threadTs,
          messageTs: item.ts,
          reactedMessageText,
          reactedMessageAuthor,
        }),
        timestamp: (evt.event_ts as string) ?? item.ts,
        scope: buildSlackThreadRuntimeScope({
          channelId: item.channel,
          context: threadInfo?.context,
        }),
      });

      await this.addReaction(item.channel, item.ts, "white_check_mark");
    } catch (error) {
      console.error(`[slack-adapter] reaction trigger failed: ${errorMsg(error)}`);
      await this.addReaction(item.channel, item.ts, "x");
    }
  }

  private async onMessage(evt: Record<string, unknown>): Promise<void> {
    if (this.shuttingDown) return;

    const classified = classifyMessage(
      evt,
      this.botUserId,
      this.getTrackedThreadIds(),
      this.config.isKnownThread,
    );
    if (!classified.relevant) return;

    const { threadTs, channel, userId, text, isChannelMention, messageTs, metadata } = classified;

    if (!this.threads.has(threadTs)) {
      this.threads.set(threadTs, {
        channelId: channel,
        threadTs,
        userId,
      });
    }

    if (!isSlackUserAllowed(this.allowlist, userId)) return;

    void this.addReaction(channel, messageTs, "eyes");
    const pending = this.pendingEyes.get(threadTs) ?? [];
    pending.push({ channel, messageTs });
    this.pendingEyes.set(threadTs, pending);

    const userName = await this.resolveUser(userId);
    if (this.shuttingDown) return;

    const threadInfo = this.threads.get(threadTs);
    this.inboundHandler?.({
      source: "slack",
      threadId: threadTs,
      channel,
      userId,
      userName,
      text,
      timestamp: messageTs,
      scope: buildSlackThreadRuntimeScope({
        channelId: channel,
        context: threadInfo?.context,
      }),
      ...(isChannelMention ? { isChannelMention: true } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  private async emitInteractiveInbound(normalized: {
    channel: string;
    threadTs: string;
    userId: string;
    text: string;
    timestamp: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    if (!this.threads.has(normalized.threadTs)) {
      this.threads.set(normalized.threadTs, {
        channelId: normalized.channel,
        threadTs: normalized.threadTs,
        userId: normalized.userId,
      });
    }

    try {
      this.config.rememberKnownThread?.(normalized.threadTs, normalized.channel);
    } catch {
      /* best effort — DB cache sync must not break Slack event handling */
    }

    if (!isSlackUserAllowed(this.allowlist, normalized.userId)) return;

    const userName = await this.resolveUser(normalized.userId);
    if (this.shuttingDown) return;

    const threadInfo = this.threads.get(normalized.threadTs);
    this.inboundHandler?.({
      source: "slack",
      threadId: normalized.threadTs,
      channel: normalized.channel,
      userId: normalized.userId,
      userName,
      text: normalized.text,
      timestamp: normalized.timestamp,
      metadata: normalized.metadata,
      scope: buildSlackThreadRuntimeScope({
        channelId: normalized.channel,
        context: threadInfo?.context,
      }),
    });
  }

  private onMemberJoined(event: { channel: string; isSelf: boolean }): void {
    if (!event.isSelf) return;

    this.inboundHandler?.({
      source: "slack",
      threadId: "",
      channel: event.channel,
      userId: "system",
      text: `Bot was added to channel ${event.channel}`,
      timestamp: String(Date.now() / 1000),
      scope: buildSlackThreadRuntimeScope({ channelId: event.channel }),
    });
  }

  private async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await addSlackReaction({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  private async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    await removeSlackReaction({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channel,
      timestamp: ts,
      emoji,
    });
  }

  private async resolveUser(userId: string): Promise<string> {
    return resolveSlackUserName({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      userId,
      cache: this.userNames,
      shouldUseResult: () => !this.shuttingDown,
    });
  }

  private async clearThreadStatus(channelId: string, threadTs: string): Promise<void> {
    await clearSlackThreadStatus({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channelId,
      threadTs,
    });
  }

  private async setSuggestedPrompts(channelId: string, threadTs: string): Promise<void> {
    const prompts = this.config.suggestedPrompts ?? [
      { title: "Status", message: "What are you working on right now?" },
      { title: "Help", message: "I need help with something in the codebase" },
      { title: "Review", message: "Summarise the recent changes" },
    ];
    await setSlackSuggestedPrompts({
      slack: this.callSlack.bind(this),
      token: this.config.botToken,
      channelId,
      threadTs,
      prompts,
    });
  }
}

function isParsedThreadStarted(
  value: ParsedThreadStarted | Record<string, unknown>,
): value is ParsedThreadStarted {
  return (
    typeof value.channelId === "string" &&
    typeof value.threadTs === "string" &&
    typeof value.userId === "string"
  );
}

function isParsedThreadContextChanged(
  value: ParsedThreadContextChanged | Record<string, unknown>,
): value is ParsedThreadContextChanged {
  return typeof value.threadTs === "string";
}

function isParsedAppHomeOpened(
  value: ParsedAppHomeOpened | Record<string, unknown>,
): value is ParsedAppHomeOpened {
  return typeof value.userId === "string" && typeof value.tab === "string";
}

function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
