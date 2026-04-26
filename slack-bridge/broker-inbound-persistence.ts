import type { BrokerMessage, InboundMessage } from "@gugu910/pi-broker-core/types";

export interface DeliveredInboundPersistenceStore {
  queueDeliveredMessage(
    agentId: string,
    message: InboundMessage,
  ): { message: BrokerMessage; freshDelivery: boolean };
}

export interface DeliveredInboundPersistenceResult {
  message: BrokerMessage;
  freshDelivery: boolean;
}

export function persistDeliveredInboundMessage(
  store: DeliveredInboundPersistenceStore,
  agentId: string,
  message: InboundMessage,
): DeliveredInboundPersistenceResult {
  return store.queueDeliveredMessage(agentId, message);
}
