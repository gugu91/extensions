import { describe, expect, it, vi } from "vitest";
import {
  createCompactionGate,
  type CompactionGateDeps,
  type CompactionGateReleaseReason,
  type CompactionGateTimerHandle,
} from "./compaction-gate.js";

interface Harness {
  gate: ReturnType<typeof createCompactionGate>;
  onRelease: ReturnType<typeof vi.fn>;
  /** Run all deferred release callbacks scheduled so far. */
  flushScheduled: () => void;
  /** Fire the pending failsafe timer, if armed. */
  fireFailsafe: () => void;
  clearedTimers: CompactionGateTimerHandle[];
}

function createHarness(overrides: Partial<CompactionGateDeps> = {}): Harness {
  const onRelease = vi.fn<(held: string[], reason: CompactionGateReleaseReason) => void>();
  const scheduled: Array<() => void> = [];
  const timers = new Map<number, () => void>();
  const clearedTimers: CompactionGateTimerHandle[] = [];
  let nextTimer = 1;

  const gate = createCompactionGate({
    onRelease,
    scheduleRelease: (fn) => {
      scheduled.push(fn);
    },
    setTimer: (fn) => {
      const handle = nextTimer++;
      timers.set(handle, fn);
      return handle;
    },
    clearTimer: (handle) => {
      clearedTimers.push(handle);
      timers.delete(handle as number);
    },
    ...overrides,
  });

  return {
    gate,
    onRelease,
    flushScheduled: () => {
      while (scheduled.length > 0) {
        scheduled.shift()?.();
      }
    },
    fireFailsafe: () => {
      for (const [handle, fn] of [...timers]) {
        timers.delete(handle);
        fn();
      }
    },
    clearedTimers,
  };
}

describe("createCompactionGate", () => {
  it("does not hold messages when no compaction is active", () => {
    const { gate } = createHarness();
    expect(gate.isCompacting()).toBe(false);
    expect(gate.holdMessage("hello")).toBe(false);
    expect(gate.heldCount()).toBe(0);
  });

  it("holds messages during a compaction window and releases them on endHold", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    expect(gate.isCompacting()).toBe(true);
    expect(gate.holdMessage("first")).toBe(true);
    expect(gate.holdMessage("second")).toBe(true);

    gate.endHold("compacted");
    // Release is deferred: still compacting until the scheduled callback runs,
    // so synchronous session_compact handlers cannot deliver inside compact().
    expect(gate.isCompacting()).toBe(true);
    expect(onRelease).not.toHaveBeenCalled();

    flushScheduled();
    expect(gate.isCompacting()).toBe(false);
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith(["first", "second"], "compacted");
    expect(gate.heldCount()).toBe(0);
  });

  it("keeps holding messages that arrive between endHold and the deferred release", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.endHold("compacted");
    expect(gate.holdMessage("late")).toBe(true);
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith(["late"], "compacted");
  });

  it("releases with an empty batch so callers can drain the inbox", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.endHold("compacted");
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith([], "compacted");
  });

  it("only releases once for duplicate endHold calls", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.holdMessage("once");
    gate.endHold("compacted");
    gate.endHold("aborted");
    flushScheduled();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledWith(["once"], "compacted");
  });

  it("ignores endHold when no hold is active", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.endHold("compacted");
    flushScheduled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("releases when the compaction abort signal fires", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    const controller = new AbortController();
    gate.beginHold({ signal: controller.signal });
    gate.holdMessage("held");

    controller.abort();
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith(["held"], "aborted");
  });

  it("releases immediately when the signal is already aborted", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    const controller = new AbortController();
    controller.abort();
    gate.beginHold({ signal: controller.signal });
    flushScheduled();
    expect(gate.isCompacting()).toBe(false);
    expect(onRelease).toHaveBeenCalledWith([], "aborted");
  });

  it("releases via the failsafe timer when compaction never reports back", () => {
    const { gate, onRelease, flushScheduled, fireFailsafe } = createHarness();
    gate.beginHold();
    gate.holdMessage("stranded");
    fireFailsafe();
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith(["stranded"], "timeout");
  });

  it("clears the failsafe timer once the hold ends", () => {
    const { gate, onRelease, flushScheduled, fireFailsafe, clearedTimers } = createHarness();
    gate.beginHold();
    gate.endHold("compacted");
    flushScheduled();
    expect(clearedTimers.length).toBeGreaterThan(0);
    fireFailsafe();
    flushScheduled();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("carries held messages into a new hold that begins before the release runs", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.holdMessage("carried");
    gate.endHold("compacted");
    // A new compaction starts before the deferred release executed.
    gate.beginHold();
    flushScheduled();
    expect(onRelease).not.toHaveBeenCalled();
    expect(gate.isCompacting()).toBe(true);
    expect(gate.heldCount()).toBe(1);

    gate.endHold("compacted");
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith(["carried"], "compacted");
  });

  it("ignores a stale abort signal from a previous hold", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    const first = new AbortController();
    gate.beginHold({ signal: first.signal });
    gate.beginHold();
    gate.holdMessage("current");

    first.abort();
    flushScheduled();
    expect(onRelease).not.toHaveBeenCalled();
    expect(gate.isCompacting()).toBe(true);

    gate.endHold("compacted");
    flushScheduled();
    expect(onRelease).toHaveBeenCalledWith(["current"], "compacted");
  });

  it("ignores a stale failsafe timer from a previous hold", () => {
    const onRelease = vi.fn();
    const scheduled: Array<() => void> = [];
    const timerFns: Array<() => void> = [];
    const gate = createCompactionGate({
      onRelease,
      scheduleRelease: (fn) => {
        scheduled.push(fn);
      },
      setTimer: (fn) => {
        timerFns.push(fn);
        return timerFns.length;
      },
      // Simulate an environment where cleared timers still fire.
      clearTimer: () => {},
    });

    gate.beginHold();
    gate.beginHold();
    gate.holdMessage("current");

    timerFns[0]!(); // stale failsafe from the first hold
    while (scheduled.length > 0) scheduled.shift()?.();
    expect(onRelease).not.toHaveBeenCalled();
    expect(gate.isCompacting()).toBe(true);

    gate.endHold("compacted");
    while (scheduled.length > 0) scheduled.shift()?.();
    expect(onRelease).toHaveBeenCalledWith(["current"], "compacted");
  });

  it("discard drops held messages without releasing them", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.holdMessage("dropped");
    const dropped = gate.discard();
    expect(dropped).toEqual(["dropped"]);
    expect(gate.isCompacting()).toBe(false);
    flushScheduled();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("discard cancels a pending deferred release", () => {
    const { gate, onRelease, flushScheduled } = createHarness();
    gate.beginHold();
    gate.holdMessage("dropped");
    gate.endHold("compacted");
    const dropped = gate.discard();
    expect(dropped).toEqual(["dropped"]);
    flushScheduled();
    expect(onRelease).not.toHaveBeenCalled();
  });
});
