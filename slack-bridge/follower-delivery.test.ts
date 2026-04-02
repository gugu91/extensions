import { describe, expect, it } from "vitest";
import {
  createFollowerDeliveryState,
  drainFollowerAckBatches,
  getFollowerShutdownAckIds,
  hasDeliveredFollowerInboxIds,
  isFollowerInboxIdTracked,
  markFollowerAckBatchFailed,
  markFollowerAckBatchSucceeded,
  markFollowerInboxIdsDelivered,
  queueFollowerInboxIds,
  resetFollowerDeliveryState,
  takeFollowerAckBatch,
} from "./follower-delivery.js";

describe("follower delivery state", () => {
  it("keeps queued messages out of shutdown ACKs", () => {
    const state = createFollowerDeliveryState();

    queueFollowerInboxIds(state, [101, 102]);
    markFollowerInboxIdsDelivered(state, [201]);

    expect(getFollowerShutdownAckIds(state)).toEqual([201]);
    expect(isFollowerInboxIdTracked(state, 101)).toBe(true);
    expect(isFollowerInboxIdTracked(state, 102)).toBe(true);
    expect(isFollowerInboxIdTracked(state, 201)).toBe(true);
  });

  it("keeps IDs tracked while ACK is in flight and clears them only on success", () => {
    const state = createFollowerDeliveryState();

    queueFollowerInboxIds(state, [301]);
    markFollowerInboxIdsDelivered(state, [301]);

    const batch = takeFollowerAckBatch(state);
    expect(batch).toEqual([301]);
    expect(isFollowerInboxIdTracked(state, 301)).toBe(true);
    expect(hasDeliveredFollowerInboxIds(state)).toBe(false);

    markFollowerAckBatchSucceeded(state, batch);
    expect(isFollowerInboxIdTracked(state, 301)).toBe(false);
  });

  it("restores delivered IDs after an ACK failure so they can be retried", () => {
    const state = createFollowerDeliveryState();

    queueFollowerInboxIds(state, [401, 402]);
    markFollowerInboxIdsDelivered(state, [401, 402]);

    const batch = takeFollowerAckBatch(state);
    markFollowerAckBatchFailed(state, batch);

    expect(hasDeliveredFollowerInboxIds(state)).toBe(true);
    expect(takeFollowerAckBatch(state)).toEqual([401, 402]);
  });

  it("waits for chained ACK batches before resolving", async () => {
    const state = createFollowerDeliveryState();

    markFollowerInboxIdsDelivered(state, [601]);

    const batches: number[][] = [];
    let releaseFirstBatch!: () => void;
    const firstBatchReleased = new Promise<void>((resolve) => {
      releaseFirstBatch = () => resolve();
    });

    const drainPromise = drainFollowerAckBatches(state, async (ids) => {
      batches.push(ids);
      if (ids[0] === 601) {
        markFollowerInboxIdsDelivered(state, [602]);
        await firstBatchReleased;
      }
    });

    await Promise.resolve();
    expect(isFollowerInboxIdTracked(state, 602)).toBe(true);

    releaseFirstBatch();
    await drainPromise;

    expect(batches).toEqual([[601], [602]]);
    expect(isFollowerInboxIdTracked(state, 601)).toBe(false);
    expect(isFollowerInboxIdTracked(state, 602)).toBe(false);
  });

  it("resets all follower delivery state", () => {
    const state = createFollowerDeliveryState();

    queueFollowerInboxIds(state, [501]);
    markFollowerInboxIdsDelivered(state, [502]);
    const batch = takeFollowerAckBatch(state);
    expect(batch).toEqual([502]);

    resetFollowerDeliveryState(state);
    expect(isFollowerInboxIdTracked(state, 501)).toBe(false);
    expect(isFollowerInboxIdTracked(state, 502)).toBe(false);
    expect(hasDeliveredFollowerInboxIds(state)).toBe(false);
  });
});
