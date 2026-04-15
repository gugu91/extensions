export interface PinetMaintenanceDeliveryAgentRecord {
  id: string;
}

export interface PinetMaintenanceDeliveryBrokerDbPort {
  getAgentById: (agentId: string) => PinetMaintenanceDeliveryAgentRecord | null;
  getThread: (threadId: string) => unknown;
  createThread: (threadId: string, source: string, channel: string, owner: string) => void;
  insertMessage: (
    threadId: string,
    source: string,
    direction: "outbound" | "inbound",
    sender: string,
    body: string,
    recipients: string[],
    metadata?: Record<string, unknown>,
  ) => void;
}

export interface PinetMaintenanceDeliverySendMessageOptions {
  deliverAs?: "followUp";
}

export interface PinetMaintenanceDeliveryDeps {
  getActiveBrokerDb: () => PinetMaintenanceDeliveryBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  sendUserMessage: (body: string, options?: PinetMaintenanceDeliverySendMessageOptions) => void;
}

export interface PinetMaintenanceDelivery {
  sendBrokerMaintenanceMessage: (targetAgentId: string, body: string) => void;
  trySendBrokerFollowUp: (body: string, onDelivered: () => void) => void;
}

export function createPinetMaintenanceDelivery(
  deps: PinetMaintenanceDeliveryDeps,
): PinetMaintenanceDelivery {
  function sendBrokerMaintenanceMessage(targetAgentId: string, body: string): void {
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (!db || !selfId) return;
    const target = db.getAgentById(targetAgentId);
    if (!target) return;

    const threadId = `a2a:${selfId}:${target.id}`;
    if (!db.getThread(threadId)) {
      db.createThread(threadId, "agent", "", selfId);
    }

    db.insertMessage(threadId, "agent", "outbound", selfId, body, [target.id], {
      kind: "ralph_loop_nudge",
      targetAgentId,
    });
  }

  function trySendBrokerFollowUp(body: string, onDelivered: () => void): void {
    try {
      deps.sendUserMessage(body, { deliverAs: "followUp" });
      onDelivered();
      return;
    } catch {
      try {
        deps.sendUserMessage(body);
        onDelivered();
      } catch {
        /* best effort */
      }
    }
  }

  return {
    sendBrokerMaintenanceMessage,
    trySendBrokerFollowUp,
  };
}
