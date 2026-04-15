import { describe, expect, it, vi } from "vitest";
import {
  createPinetRemoteControlAcks,
  type PinetRemoteControlAcksDeps,
} from "./pinet-remote-control-acks.js";

function createDeps(overrides: Partial<PinetRemoteControlAcksDeps> = {}) {
  let brokerConnected = true;
  const queueBrokerInboxIds = vi.fn();
  const markBrokerInboxIdsDelivered = vi.fn();
  const queueFollowerInboxIds = vi.fn();
  const markFollowerInboxIdsDelivered = vi.fn();
  const flushDeliveredFollowerAcks = vi.fn();

  const deps: PinetRemoteControlAcksDeps = {
    queueBrokerInboxIds,
    isBrokerConnected: () => brokerConnected,
    markBrokerInboxIdsDelivered,
    queueFollowerInboxIds,
    markFollowerInboxIdsDelivered,
    flushDeliveredFollowerAcks,
    ...overrides,
  };

  return {
    deps,
    queueBrokerInboxIds,
    markBrokerInboxIdsDelivered,
    queueFollowerInboxIds,
    markFollowerInboxIdsDelivered,
    flushDeliveredFollowerAcks,
    setBrokerConnected: (connected: boolean) => {
      brokerConnected = connected;
    },
  };
}

describe("createPinetRemoteControlAcks", () => {
  it("queues and flushes broker control acks when the broker is connected", () => {
    const { deps, queueBrokerInboxIds, markBrokerInboxIdsDelivered } = createDeps();
    const pinetRemoteControlAcks = createPinetRemoteControlAcks(deps);

    pinetRemoteControlAcks.deferBrokerControlAck("reload", 11);
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");

    expect(queueBrokerInboxIds).toHaveBeenCalledWith([11]);
    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledTimes(1);
    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledWith([11]);
  });

  it("retains broker control acks until the broker is connected", () => {
    const { deps, setBrokerConnected, markBrokerInboxIdsDelivered } = createDeps();
    setBrokerConnected(false);
    const pinetRemoteControlAcks = createPinetRemoteControlAcks(deps);

    pinetRemoteControlAcks.deferBrokerControlAck("exit", 21);
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("exit");
    expect(markBrokerInboxIdsDelivered).not.toHaveBeenCalled();

    setBrokerConnected(true);
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("exit");
    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledWith([21]);
  });

  it("queues and flushes follower control acks through follower delivery", () => {
    const {
      deps,
      queueFollowerInboxIds,
      markFollowerInboxIdsDelivered,
      flushDeliveredFollowerAcks,
    } = createDeps();
    const pinetRemoteControlAcks = createPinetRemoteControlAcks(deps);

    pinetRemoteControlAcks.deferFollowerControlAck("reload", 31);
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");

    expect(queueFollowerInboxIds).toHaveBeenCalledWith([31]);
    expect(markFollowerInboxIdsDelivered).toHaveBeenCalledTimes(1);
    expect(markFollowerInboxIdsDelivered).toHaveBeenCalledWith([31]);
    expect(flushDeliveredFollowerAcks).toHaveBeenCalledTimes(1);
  });

  it("keeps broker and follower command buckets isolated", () => {
    const { deps, markBrokerInboxIdsDelivered, markFollowerInboxIdsDelivered } = createDeps();
    const pinetRemoteControlAcks = createPinetRemoteControlAcks(deps);

    pinetRemoteControlAcks.deferBrokerControlAck("reload", 41);
    pinetRemoteControlAcks.deferBrokerControlAck("exit", 42);
    pinetRemoteControlAcks.deferFollowerControlAck("reload", 43);
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");

    expect(markBrokerInboxIdsDelivered).toHaveBeenCalledWith([41]);
    expect(markFollowerInboxIdsDelivered).toHaveBeenCalledWith([43]);

    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("exit");
    expect(markBrokerInboxIdsDelivered).toHaveBeenNthCalledWith(2, [42]);
  });

  it("resets deferred control acks for both broker and follower paths", () => {
    const {
      deps,
      markBrokerInboxIdsDelivered,
      markFollowerInboxIdsDelivered,
      flushDeliveredFollowerAcks,
    } = createDeps();
    const pinetRemoteControlAcks = createPinetRemoteControlAcks(deps);

    pinetRemoteControlAcks.deferBrokerControlAck("reload", 51);
    pinetRemoteControlAcks.deferFollowerControlAck("exit", 52);
    pinetRemoteControlAcks.resetPendingRemoteControlAcks();
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("reload");
    pinetRemoteControlAcks.flushDeferredRemoteControlAcks("exit");

    expect(markBrokerInboxIdsDelivered).not.toHaveBeenCalled();
    expect(markFollowerInboxIdsDelivered).not.toHaveBeenCalled();
    expect(flushDeliveredFollowerAcks).not.toHaveBeenCalled();
  });
});
