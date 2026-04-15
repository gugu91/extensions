import { resolveFollowerThreadChannel as resolveFollowerThreadChannelState } from "./helpers.js";
import {
  addSlackReaction,
  clearSlackThreadStatus,
  fetchSlackMessageByTs as fetchSlackMessageByTsFromSlack,
  removeSlackReaction,
  resolveSlackChannelId,
  resolveSlackUserName,
  setSlackSuggestedPrompts,
  type SlackAccessCache,
  type SlackCall,
  type SlackSuggestedPrompt,
} from "./slack-access.js";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";

export interface SlackRuntimeAccessDeps {
  slack: SlackCall;
  getBotToken: () => string;
  userNames: SlackAccessCache<string, string>;
  channelCache: SlackAccessCache<string, string>;
  persistState: () => void;
  isSinglePlayerShuttingDown: () => boolean;
  getSuggestedPrompts: () => SlackSuggestedPrompt[] | undefined;
  getAgentName: () => string;
  getThreads: () => Map<string, SinglePlayerThreadInfo>;
  getBrokerRole: () => "broker" | "follower" | null;
  resolveBrokerThreadChannel?: (threadTs: string) => string | null;
  resolveFollowerThreadChannel?: (threadTs: string) => Promise<string | null>;
}

export interface SlackRuntimeAccess {
  addReaction: (channel: string, ts: string, emoji: string) => Promise<void>;
  removeReaction: (channel: string, ts: string, emoji: string) => Promise<void>;
  resolveUser: (userId: string) => Promise<string>;
  rememberChannel: (name: string, channelId: string) => void;
  resolveChannel: (nameOrId: string) => Promise<string>;
  resolveFollowerReplyChannel: (threadTs: string | undefined) => Promise<string | null>;
  clearThreadStatus: (channelId: string, threadTs: string) => Promise<void>;
  setSuggestedPrompts: (channelId: string, threadTs: string) => Promise<void>;
  fetchSlackMessageByTs: (
    channel: string,
    messageTs: string,
  ) => Promise<Record<string, unknown> | null>;
}

export function createSlackRuntimeAccess(deps: SlackRuntimeAccessDeps): SlackRuntimeAccess {
  return {
    addReaction: async (channel: string, ts: string, emoji: string): Promise<void> => {
      await addSlackReaction({
        slack: deps.slack,
        token: deps.getBotToken(),
        channel,
        timestamp: ts,
        emoji,
      });
    },

    removeReaction: async (channel: string, ts: string, emoji: string): Promise<void> => {
      await removeSlackReaction({
        slack: deps.slack,
        token: deps.getBotToken(),
        channel,
        timestamp: ts,
        emoji,
      });
    },

    resolveUser: async (userId: string): Promise<string> => {
      const hadCachedUser = deps.userNames.get(userId) != null;
      const name = await resolveSlackUserName({
        slack: deps.slack,
        token: deps.getBotToken(),
        userId,
        cache: deps.userNames,
        shouldUseResult: () => !deps.isSinglePlayerShuttingDown(),
      });
      if (!hadCachedUser && deps.userNames.get(userId) != null) {
        deps.persistState();
      }
      return name;
    },

    rememberChannel: (name: string, channelId: string): void => {
      deps.channelCache.set(name.replace(/^#/, ""), channelId);
    },

    resolveChannel: async (nameOrId: string): Promise<string> => {
      return resolveSlackChannelId({
        slack: deps.slack,
        token: deps.getBotToken(),
        nameOrId,
        cache: deps.channelCache,
      });
    },

    resolveFollowerReplyChannel: async (threadTs: string | undefined): Promise<string | null> => {
      if (!threadTs) {
        return null;
      }

      const threads = deps.getThreads();
      const existingThread = threads.get(threadTs);
      const brokerRole = deps.getBrokerRole();
      const resolveThread =
        brokerRole === "broker"
          ? async (nextThreadTs: string) => deps.resolveBrokerThreadChannel?.(nextThreadTs) ?? null
          : brokerRole === "follower"
            ? deps.resolveFollowerThreadChannel
            : undefined;
      const resolved = await resolveFollowerThreadChannelState(
        threadTs,
        existingThread,
        resolveThread,
      );

      if (resolved.threadUpdate && resolved.changed) {
        threads.set(threadTs, {
          ...(existingThread ?? {}),
          ...resolved.threadUpdate,
        });
        deps.persistState();
      }

      return resolved.channelId;
    },

    clearThreadStatus: async (channelId: string, threadTs: string): Promise<void> => {
      await clearSlackThreadStatus({
        slack: deps.slack,
        token: deps.getBotToken(),
        channelId,
        threadTs,
      });
    },

    setSuggestedPrompts: async (channelId: string, threadTs: string): Promise<void> => {
      const prompts = deps.getSuggestedPrompts() ?? [
        {
          title: "Status",
          message: `Hey ${deps.getAgentName()}, what are you working on right now?`,
        },
        {
          title: "Help",
          message: `${deps.getAgentName()}, I need help with something in the codebase`,
        },
        { title: "Review", message: `${deps.getAgentName()}, summarise the recent changes` },
      ];
      await setSlackSuggestedPrompts({
        slack: deps.slack,
        token: deps.getBotToken(),
        channelId,
        threadTs,
        prompts,
      });
    },

    fetchSlackMessageByTs: async (
      channel: string,
      messageTs: string,
    ): Promise<Record<string, unknown> | null> => {
      return fetchSlackMessageByTsFromSlack({
        slack: deps.slack,
        token: deps.getBotToken(),
        channel,
        messageTs,
      });
    },
  };
}
