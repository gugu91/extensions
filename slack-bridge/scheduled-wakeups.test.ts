import { describe, expect, it } from "vitest";
import {
  buildScheduledWakeupThreadId,
  parseScheduledWakeupDelay,
  resolveScheduledWakeupFireAt,
} from "./scheduled-wakeups.js";

describe("parseScheduledWakeupDelay", () => {
  it("parses simple unit delays", () => {
    expect(parseScheduledWakeupDelay("5m")).toBe(5 * 60_000);
    expect(parseScheduledWakeupDelay("30s")).toBe(30_000);
    expect(parseScheduledWakeupDelay("1d")).toBe(24 * 60 * 60_000);
  });

  it("parses compound delays", () => {
    expect(parseScheduledWakeupDelay("1h30m")).toBe(90 * 60_000);
    expect(parseScheduledWakeupDelay("2h 15m 10s")).toBe(2 * 60 * 60_000 + 15 * 60_000 + 10_000);
  });

  it("rejects invalid or empty delays", () => {
    expect(parseScheduledWakeupDelay("")).toBeNull();
    expect(parseScheduledWakeupDelay("0m")).toBeNull();
    expect(parseScheduledWakeupDelay("five minutes")).toBeNull();
    expect(parseScheduledWakeupDelay("5x")).toBeNull();
    expect(parseScheduledWakeupDelay("m5")).toBeNull();
  });
});

describe("resolveScheduledWakeupFireAt", () => {
  const now = Date.parse("2026-04-02T14:00:00.000Z");

  it("resolves a delay relative to now", () => {
    expect(resolveScheduledWakeupFireAt({ delay: "5m" }, now)).toBe("2026-04-02T14:05:00.000Z");
  });

  it("normalizes explicit timestamps", () => {
    expect(resolveScheduledWakeupFireAt({ at: "2026-04-02T14:10:00Z" }, now)).toBe(
      "2026-04-02T14:10:00.000Z",
    );
  });

  it("requires exactly one scheduling mode", () => {
    expect(() => resolveScheduledWakeupFireAt({}, now)).toThrow(
      "Provide exactly one of delay or at.",
    );
    expect(() =>
      resolveScheduledWakeupFireAt({ delay: "5m", at: "2026-04-02T14:10:00Z" }, now),
    ).toThrow("Provide exactly one of delay or at.");
  });

  it("rejects invalid or past timestamps", () => {
    expect(() => resolveScheduledWakeupFireAt({ delay: "nope" }, now)).toThrow("Invalid delay.");
    expect(() => resolveScheduledWakeupFireAt({ at: "not-a-time" }, now)).toThrow(
      "Invalid timestamp.",
    );
    expect(() => resolveScheduledWakeupFireAt({ at: "2026-04-02T13:59:59Z" }, now)).toThrow(
      "Scheduled wake-up time must be in the future.",
    );
  });
});

describe("buildScheduledWakeupThreadId", () => {
  it("builds a stable self-thread id for wakeups", () => {
    expect(buildScheduledWakeupThreadId("agent-1")).toBe("wakeup:agent-1");
  });
});
