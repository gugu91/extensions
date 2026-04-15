import type { ThreadOwnerHint } from "./broker/router.js";
import { resolveSlackThreadOwnerHint, type SlackCall } from "./slack-access.js";
import { TtlCache } from "./ttl-cache.js";

export interface BrokerThreadOwnerHintsDeps {
  slack: SlackCall;
  getBotToken: () => string;
}

export interface BrokerThreadOwnerHints {
  resolveBrokerThreadOwnerHint: (
    channel: string,
    threadTs: string,
  ) => Promise<ThreadOwnerHint | null>;
}

export function createBrokerThreadOwnerHints(
  deps: BrokerThreadOwnerHintsDeps,
): BrokerThreadOwnerHints {
  const brokerThreadOwnerHintCache = new TtlCache<string, ThreadOwnerHint>({
    maxSize: 2000,
    ttlMs: 60 * 1000,
  });

  async function resolveBrokerThreadOwnerHint(
    channel: string,
    threadTs: string,
  ): Promise<ThreadOwnerHint | null> {
    return resolveSlackThreadOwnerHint({
      slack: deps.slack,
      token: deps.getBotToken(),
      channel,
      threadTs,
      cache: brokerThreadOwnerHintCache,
    });
  }

  return {
    resolveBrokerThreadOwnerHint,
  };
}
