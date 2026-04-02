export interface FollowerDeliveryState {
  queuedButUndeliveredIds: Set<number>;
  deliveredAwaitingAckIds: Set<number>;
  ackInFlightIds: Set<number>;
}

export function createFollowerDeliveryState(): FollowerDeliveryState {
  return {
    queuedButUndeliveredIds: new Set<number>(),
    deliveredAwaitingAckIds: new Set<number>(),
    ackInFlightIds: new Set<number>(),
  };
}

export function resetFollowerDeliveryState(state: FollowerDeliveryState): void {
  state.queuedButUndeliveredIds.clear();
  state.deliveredAwaitingAckIds.clear();
  state.ackInFlightIds.clear();
}

export function isFollowerInboxIdTracked(state: FollowerDeliveryState, inboxId: number): boolean {
  return (
    state.queuedButUndeliveredIds.has(inboxId) ||
    state.deliveredAwaitingAckIds.has(inboxId) ||
    state.ackInFlightIds.has(inboxId)
  );
}

export function queueFollowerInboxIds(
  state: FollowerDeliveryState,
  inboxIds: Iterable<number>,
): void {
  for (const inboxId of inboxIds) {
    state.queuedButUndeliveredIds.add(inboxId);
  }
}

export function markFollowerInboxIdsDelivered(
  state: FollowerDeliveryState,
  inboxIds: Iterable<number>,
): void {
  for (const inboxId of inboxIds) {
    state.queuedButUndeliveredIds.delete(inboxId);
    state.deliveredAwaitingAckIds.add(inboxId);
  }
}

export function hasDeliveredFollowerInboxIds(state: FollowerDeliveryState): boolean {
  return state.deliveredAwaitingAckIds.size > 0;
}

export function takeFollowerAckBatch(state: FollowerDeliveryState): number[] {
  const batch = [...state.deliveredAwaitingAckIds];
  for (const inboxId of batch) {
    state.deliveredAwaitingAckIds.delete(inboxId);
    state.ackInFlightIds.add(inboxId);
  }
  return batch;
}

export function markFollowerAckBatchSucceeded(
  state: FollowerDeliveryState,
  inboxIds: Iterable<number>,
): void {
  for (const inboxId of inboxIds) {
    state.ackInFlightIds.delete(inboxId);
  }
}

export function markFollowerAckBatchFailed(
  state: FollowerDeliveryState,
  inboxIds: Iterable<number>,
): void {
  for (const inboxId of inboxIds) {
    if (state.ackInFlightIds.delete(inboxId)) {
      state.deliveredAwaitingAckIds.add(inboxId);
    }
  }
}

export async function drainFollowerAckBatches(
  state: FollowerDeliveryState,
  ackBatch: (inboxIds: number[]) => Promise<void>,
): Promise<void> {
  while (true) {
    const batch = takeFollowerAckBatch(state);
    if (batch.length === 0) {
      return;
    }

    try {
      await ackBatch(batch);
      markFollowerAckBatchSucceeded(state, batch);
    } catch {
      markFollowerAckBatchFailed(state, batch);
      return;
    }
  }
}

export function getFollowerShutdownAckIds(state: FollowerDeliveryState): number[] {
  return [...state.deliveredAwaitingAckIds];
}
