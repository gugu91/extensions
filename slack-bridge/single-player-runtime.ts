import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isAbortError } from "./helpers.js";
import type { SlackInteractiveInboxEvent } from "./slack-block-kit.js";
import {
  SlackSocketModeClient,
  type ParsedAppHomeOpened,
  type ParsedThreadContextChanged,
  type ParsedThreadStarted,
  type SlackAccessSet,
  type SlackCall,
} from "./slack-access.js";

export interface SinglePlayerRuntimeDeps {
  slack: SlackCall;
  getBotToken: () => string;
  getAppToken: () => string;
  dedup: SlackAccessSet<string>;
  abortSlackRequests: () => Promise<void>;
  isSingleRuntimeActive: () => boolean;
  setExtStatus: (ctx: ExtensionContext, state: "ok" | "reconnecting" | "error" | "off") => void;
  formatError: (error: unknown) => string;
  handleThreadStarted: (event: ParsedThreadStarted) => Promise<void> | void;
  handleThreadContextChanged: (event: ParsedThreadContextChanged) => Promise<void> | void;
  handleAppHomeOpened: (event: ParsedAppHomeOpened, ctx: ExtensionContext) => Promise<void> | void;
  handleMessage: (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<void> | void;
  handleReactionAdded: (
    event: Record<string, unknown>,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  handleMemberJoinedChannel: (
    event: { channel: string; isSelf: boolean },
    ctx: ExtensionContext,
  ) => Promise<void> | void;
  handleInteractive: (
    event: SlackInteractiveInboxEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;
}

export interface SinglePlayerRuntime {
  connect: (ctx: ExtensionContext) => Promise<void>;
  disconnect: () => Promise<void>;
  getBotUserId: () => string | null;
  isConnected: () => boolean;
  isShuttingDown: () => boolean;
  resetShutdownState: () => void;
}

export function createSinglePlayerRuntime(deps: SinglePlayerRuntimeDeps): SinglePlayerRuntime {
  let slackSocket: SlackSocketModeClient | null = null;
  let shuttingDown = false;

  return {
    async connect(ctx: ExtensionContext): Promise<void> {
      shuttingDown = false;

      const socket = new SlackSocketModeClient({
        slack: deps.slack,
        botToken: deps.getBotToken(),
        appToken: deps.getAppToken(),
        resolveBotUserIdOnConnect: false,
        dedup: deps.dedup,
        abortAndWait: deps.abortSlackRequests,
        onOpen: () => deps.setExtStatus(ctx, "ok"),
        onReconnectScheduled: () => {
          if (!shuttingDown && deps.isSingleRuntimeActive()) {
            deps.setExtStatus(ctx, "reconnecting");
          }
        },
        onError: (error) => {
          if (!isAbortError(error)) {
            console.error(`[slack-bridge] Slack access: ${deps.formatError(error)}`);
          }
        },
        onThreadStarted: (event) => deps.handleThreadStarted(event),
        onThreadContextChanged: (event) => deps.handleThreadContextChanged(event),
        onAppHomeOpened: (event) => deps.handleAppHomeOpened(event, ctx),
        onMessage: (event) => deps.handleMessage(event, ctx),
        onReactionAdded: (event) => deps.handleReactionAdded(event, ctx),
        onMemberJoinedChannel: (event) => deps.handleMemberJoinedChannel(event, ctx),
        onInteractive: (event) => deps.handleInteractive(event, ctx),
      });

      slackSocket = socket;
      await socket.connect();
    },

    async disconnect(): Promise<void> {
      shuttingDown = true;
      const socket = slackSocket;
      slackSocket = null;
      if (socket) {
        await socket.disconnect();
        return;
      }
      await deps.abortSlackRequests();
    },

    getBotUserId(): string | null {
      return slackSocket?.getBotUserId() ?? null;
    },

    isConnected(): boolean {
      return slackSocket?.isConnected() ?? false;
    },

    isShuttingDown(): boolean {
      return shuttingDown;
    },

    resetShutdownState(): void {
      shuttingDown = false;
    },
  };
}
