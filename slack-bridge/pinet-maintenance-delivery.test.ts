import { describe, expect, it, vi } from "vitest";
import {
  createPinetMaintenanceDelivery,
  type PinetMaintenanceDeliveryAgentRecord,
  type PinetMaintenanceDeliveryBrokerDbPort,
  type PinetMaintenanceDeliveryDeps,
} from "./pinet-maintenance-delivery.js";

function createDeps(overrides: Partial<PinetMaintenanceDeliveryDeps> = {}) {
  const agents = new Map<string, PinetMaintenanceDeliveryAgentRecord>([
    ["worker-1", { id: "worker-1" }],
  ]);
  const threads = new Map<string, { id: string }>();
  const createThread = vi.fn((threadId: string) => {
    threads.set(threadId, { id: threadId });
  });
  const insertMessage = vi.fn();
  const sendUserMessage = vi.fn();

  const db: PinetMaintenanceDeliveryBrokerDbPort = {
    getAgentById: (agentId) => agents.get(agentId) ?? null,
    getThread: (threadId) => threads.get(threadId) ?? null,
    createThread,
    insertMessage,
  };

  const deps: PinetMaintenanceDeliveryDeps = {
    getActiveBrokerDb: () => db,
    getActiveBrokerSelfId: () => "broker-1",
    sendUserMessage,
    ...overrides,
  };

  return {
    deps,
    db,
    agents,
    threads,
    createThread,
    insertMessage,
    sendUserMessage,
  };
}

describe("createPinetMaintenanceDelivery", () => {
  it("creates a broker thread when needed and inserts a maintenance nudge", () => {
    const { deps, createThread, insertMessage, threads } = createDeps();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("worker-1", "Heads up");

    expect(createThread).toHaveBeenCalledWith("a2a:broker-1:worker-1", "agent", "", "broker-1");
    expect(threads.has("a2a:broker-1:worker-1")).toBe(true);
    expect(insertMessage).toHaveBeenCalledWith(
      "a2a:broker-1:worker-1",
      "agent",
      "outbound",
      "broker-1",
      "Heads up",
      ["worker-1"],
      {
        kind: "ralph_loop_nudge",
        targetAgentId: "worker-1",
      },
    );
  });

  it("reuses an existing broker thread and skips unknown targets", () => {
    const { deps, createThread, insertMessage, threads } = createDeps();
    threads.set("a2a:broker-1:worker-1", { id: "a2a:broker-1:worker-1" });
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("worker-1", "Follow up");
    pinetMaintenanceDelivery.sendBrokerMaintenanceMessage("missing-worker", "Ignored");

    expect(createThread).not.toHaveBeenCalled();
    expect(insertMessage).toHaveBeenCalledTimes(1);
    expect(insertMessage).toHaveBeenCalledWith(
      "a2a:broker-1:worker-1",
      "agent",
      "outbound",
      "broker-1",
      "Follow up",
      ["worker-1"],
      {
        kind: "ralph_loop_nudge",
        targetAgentId: "worker-1",
      },
    );
  });

  it("prefers follow-up delivery and marks the callback as delivered", () => {
    const { deps, sendUserMessage } = createDeps();
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith("Maintenance report", {
      deliverAs: "followUp",
    });
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain delivery when follow-up delivery throws", () => {
    const { deps, sendUserMessage } = createDeps();
    sendUserMessage.mockImplementationOnce(() => {
      throw new Error("followUp failed");
    });
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered);

    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "Maintenance report", {
      deliverAs: "followUp",
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Maintenance report");
    expect(onDelivered).toHaveBeenCalledTimes(1);
  });

  it("keeps follow-up delivery best effort when both delivery attempts fail", () => {
    const { deps, sendUserMessage } = createDeps();
    sendUserMessage.mockImplementation(() => {
      throw new Error("delivery failed");
    });
    const onDelivered = vi.fn();
    const pinetMaintenanceDelivery = createPinetMaintenanceDelivery(deps);

    expect(() =>
      pinetMaintenanceDelivery.trySendBrokerFollowUp("Maintenance report", onDelivered),
    ).not.toThrow();
    expect(sendUserMessage).toHaveBeenNthCalledWith(1, "Maintenance report", {
      deliverAs: "followUp",
    });
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Maintenance report");
    expect(onDelivered).not.toHaveBeenCalled();
  });
});
