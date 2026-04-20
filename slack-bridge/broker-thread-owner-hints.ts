import type { ThreadOwnerHint } from "./broker/router.js";
import { resolveSlackThreadOwnerHint, type SlackCall } from "./slack-access.js";

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
  async function resolveBrokerThreadOwnerHint(
    channel: string,
    threadTs: string,
  ): Promise<ThreadOwnerHint | null> {
    return resolveSlackThreadOwnerHint({
      slack: deps.slack,
      token: deps.getBotToken(),
      channel,
      threadTs,
    });
  }

  return {
    resolveBrokerThreadOwnerHint,
  };
}
