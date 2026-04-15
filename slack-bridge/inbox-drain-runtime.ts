import { getBrokerInboxIds } from "./broker-delivery.js";
import { markFollowerInboxIdsDelivered, type FollowerDeliveryState } from "./follower-delivery.js";
import { formatInboxMessages, type InboxMessage } from "./helpers.js";

export interface InboxDrainRuntimeDeps {
  sendUserMessage: (text: string, options?: { deliverAs?: "followUp" }) => void;
  takeInboxMessages: () => InboxMessage[];
  restoreInboxMessages: (messages: InboxMessage[]) => void;
  updateBadge: () => void;
  reportStatus: (status: "working" | "idle") => Promise<void>;
  userNames: { get: (key: string) => string | undefined };
  getSecurityPrompt: () => string;
  deliverTrackedSlackFollowUpMessage: (options: {
    prompt: string;
    messages: Pick<InboxMessage, "threadTs">[];
  }) => boolean;
  getBrokerRole: () => "broker" | "follower" | null;
  hasFollowerClient: () => boolean;
  flushFollowerDeliveredAcks: () => Promise<void>;
  markBrokerInboxIdsDelivered: (inboxIds: number[]) => void;
  getFollowerDeliveryState: () => FollowerDeliveryState;
  shouldPauseDrain?: () => boolean;
  onInboxDelivered?: (messages: InboxMessage[]) => void;
}

export interface InboxDrainRuntime {
  deliverFollowUpMessage: (text: string) => boolean;
  flushDeliveredFollowerAcks: () => Promise<void>;
  drainInbox: () => void;
}

export function createInboxDrainRuntime(deps: InboxDrainRuntimeDeps): InboxDrainRuntime {
  function deliverFollowUpMessage(text: string): boolean {
    try {
      deps.sendUserMessage(text, { deliverAs: "followUp" });
      return true;
    } catch {
      try {
        deps.sendUserMessage(text);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function flushDeliveredFollowerAcks(): Promise<void> {
    if (deps.getBrokerRole() !== "follower" || !deps.hasFollowerClient()) {
      return;
    }

    await deps.flushFollowerDeliveredAcks();
  }

  function drainInbox(): void {
    if (deps.shouldPauseDrain?.()) {
      return;
    }

    const pending = deps.takeInboxMessages();
    if (pending.length === 0) {
      return;
    }

    const brokerInboxIds = getBrokerInboxIds(pending);
    deps.updateBadge();
    void deps.reportStatus("working").catch(() => {
      /* best effort */
    });

    let prompt = formatInboxMessages(pending, deps.userNames);
    const securityPrompt = deps.getSecurityPrompt();
    if (securityPrompt) {
      prompt = `${securityPrompt}\n\n${prompt}`;
    }

    if (
      deps.deliverTrackedSlackFollowUpMessage({
        prompt,
        messages: pending,
      })
    ) {
      deps.onInboxDelivered?.(pending);
      if (brokerInboxIds.length > 0) {
        if (deps.getBrokerRole() === "follower") {
          markFollowerInboxIdsDelivered(deps.getFollowerDeliveryState(), brokerInboxIds);
          void flushDeliveredFollowerAcks();
        } else if (deps.getBrokerRole() === "broker") {
          try {
            deps.markBrokerInboxIdsDelivered(brokerInboxIds);
          } catch {
            /* best effort */
          }
        }
      }
      return;
    }

    deps.restoreInboxMessages(pending);
    deps.updateBadge();
  }

  return {
    deliverFollowUpMessage,
    flushDeliveredFollowerAcks,
    drainInbox,
  };
}
