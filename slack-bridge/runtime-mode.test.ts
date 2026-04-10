import { describe, expect, it } from "vitest";
import {
  isPinetRuntimeMode,
  normalizeSlackBridgeRuntimeMode,
  resolveSlackBridgeStartupRuntimeMode,
} from "./runtime-mode.js";

describe("normalizeSlackBridgeRuntimeMode", () => {
  it("accepts the supported runtime modes", () => {
    expect(normalizeSlackBridgeRuntimeMode("off")).toBe("off");
    expect(normalizeSlackBridgeRuntimeMode("single")).toBe("single");
    expect(normalizeSlackBridgeRuntimeMode("broker")).toBe("broker");
    expect(normalizeSlackBridgeRuntimeMode("follower")).toBe("follower");
  });

  it("normalizes casing and whitespace", () => {
    expect(normalizeSlackBridgeRuntimeMode("  SINGLE ")).toBe("single");
  });

  it("rejects unsupported values", () => {
    expect(normalizeSlackBridgeRuntimeMode("standalone")).toBeNull();
    expect(normalizeSlackBridgeRuntimeMode(undefined)).toBeNull();
  });
});

describe("isPinetRuntimeMode", () => {
  it("identifies broker and follower as Pinet runtimes", () => {
    expect(isPinetRuntimeMode("broker")).toBe(true);
    expect(isPinetRuntimeMode("follower")).toBe(true);
    expect(isPinetRuntimeMode("single")).toBe(false);
    expect(isPinetRuntimeMode("off")).toBe(false);
  });
});

describe("resolveSlackBridgeStartupRuntimeMode", () => {
  it("defaults to off", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({})).toBe("off");
  });

  it("treats autoConnect as the legacy single-player alias", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({ autoConnect: true })).toBe("single");
  });

  it("treats autoFollow as the legacy follower alias when a broker socket exists", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode({ autoFollow: true }, { brokerSocketExists: true }),
    ).toBe("follower");
  });

  it("keeps follower startup off when the broker socket is unavailable", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode({ autoFollow: true }, { brokerSocketExists: false }),
    ).toBe("off");
  });

  it("prefers explicit runtimeMode over legacy compatibility flags", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "single", autoFollow: true, autoConnect: true },
        { brokerSocketExists: true },
      ),
    ).toBe("single");
  });

  it("allows explicit broker mode at startup", () => {
    expect(resolveSlackBridgeStartupRuntimeMode({ runtimeMode: "broker" })).toBe("broker");
  });

  it("downgrades explicit follower mode to off when no broker socket exists", () => {
    expect(
      resolveSlackBridgeStartupRuntimeMode(
        { runtimeMode: "follower" },
        { brokerSocketExists: false },
      ),
    ).toBe("off");
  });
});
