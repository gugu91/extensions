import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompactionGate } from "./compaction-gate.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createCompactionGate", () => {
  it("fails closed until compaction completion, then accepts delivery", async () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const deliver = vi.fn();
    const gate = createCompactionGate(onRelease);

    gate.begin();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(gate.tryDeliver(deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();

    gate.end();
    expect(gate.tryDeliver(deliver)).toBe(false);
    await vi.runAllTimersAsync();

    expect(onRelease).toHaveBeenCalledOnce();
    expect(gate.tryDeliver(deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("releases aborted compaction asynchronously", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const onRelease = vi.fn();
    const gate = createCompactionGate(onRelease);

    gate.begin(controller.signal);
    controller.abort();
    expect(gate.isActive()).toBe(true);
    await vi.runAllTimersAsync();

    expect(gate.isActive()).toBe(false);
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it("cancels a pending release on reset", async () => {
    vi.useFakeTimers();
    const onRelease = vi.fn();
    const gate = createCompactionGate(onRelease);

    gate.begin();
    gate.end();
    gate.reset();
    await vi.runAllTimersAsync();

    expect(gate.isActive()).toBe(false);
    expect(onRelease).not.toHaveBeenCalled();
  });
});
