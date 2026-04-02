import { describe, expect, it } from "vitest";
import {
  createBrokerDeliveryState,
  getBrokerInboxIds,
  isBrokerInboxIdTracked,
  markBrokerInboxIdsHandled,
  queueBrokerInboxIds,
  resetBrokerDeliveryState,
} from "./broker-delivery.js";

describe("broker delivery state", () => {
  it("tracks broker inbox ids until they are handled", () => {
    const state = createBrokerDeliveryState();

    queueBrokerInboxIds(state, [101, 102]);
    expect(isBrokerInboxIdTracked(state, 101)).toBe(true);
    expect(isBrokerInboxIdTracked(state, 102)).toBe(true);

    markBrokerInboxIdsHandled(state, [101]);
    expect(isBrokerInboxIdTracked(state, 101)).toBe(false);
    expect(isBrokerInboxIdTracked(state, 102)).toBe(true);
  });

  it("deduplicates broker inbox ids extracted from pending messages", () => {
    expect(
      getBrokerInboxIds([
        {
          channel: "",
          threadTs: "a2a:1",
          userId: "broker",
          text: "one",
          timestamp: "2026-04-02T14:05:00.000Z",
          brokerInboxId: 201,
        },
        {
          channel: "",
          threadTs: "a2a:1",
          userId: "broker",
          text: "two",
          timestamp: "2026-04-02T14:05:01.000Z",
          brokerInboxId: 201,
        },
        {
          channel: "C1",
          threadTs: "1712073599.123456",
          userId: "U1",
          text: "human",
          timestamp: "2026-04-02T14:05:02.000Z",
        },
      ]),
    ).toEqual([201]);
  });

  it("resets broker delivery state", () => {
    const state = createBrokerDeliveryState();

    queueBrokerInboxIds(state, [301]);
    resetBrokerDeliveryState(state);

    expect(isBrokerInboxIdTracked(state, 301)).toBe(false);
  });
});
