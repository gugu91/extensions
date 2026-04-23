import type { RuntimeScopeCarrier } from "@gugu910/pi-transport-core";
import type { ThreadOwnerHint } from "./broker/router.js";
import { resolveSlackThreadOwnerHint, type SlackCall } from "./slack-access.js";

export interface BrokerThreadOwnerHintsDeps {
  slack: SlackCall;
  resolveBotToken: (scope: RuntimeScopeCarrier | null | undefined) => string | null;
}

export interface BrokerThreadOwnerHints {
  resolveBrokerThreadOwnerHint: (
    channel: string,
    threadTs: string,
    scope?: RuntimeScopeCarrier | null,
  ) => Promise<ThreadOwnerHint | null>;
}

export function createBrokerThreadOwnerHints(
  deps: BrokerThreadOwnerHintsDeps,
): BrokerThreadOwnerHints {
  async function resolveBrokerThreadOwnerHint(
    channel: string,
    threadTs: string,
    scope?: RuntimeScopeCarrier | null,
  ): Promise<ThreadOwnerHint | null> {
    const token = deps.resolveBotToken(scope ?? null);
    if (!token) {
      return null;
    }

    return resolveSlackThreadOwnerHint({
      slack: deps.slack,
      token,
      channel,
      threadTs,
    });
  }

  return {
    resolveBrokerThreadOwnerHint,
  };
}
