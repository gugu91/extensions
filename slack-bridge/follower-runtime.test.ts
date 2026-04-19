import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createFollowerRuntime,
  type FollowerRuntimeDeps,
  type FollowerRuntimeFailureEvent,
} from "./follower-runtime.js";

function createCtx(): ExtensionContext {
  return {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
      setStatus: vi.fn(),
    },
    sessionManager: {
      getSessionFile: () => "/tmp/follower-runtime-test.json",
      getLeafId: () => "leaf-1",
      getEntries: () => [],
      getHeader: () => null,
    },
  } as unknown as ExtensionContext;
}

function createDeps(overrides: Partial<FollowerRuntimeDeps> = {}): FollowerRuntimeDeps {
  return {
    getSettings: () => ({}),
    refreshSettings: vi.fn(),
    getPinetEnabled: () => true,
    getAgentIdentity: () => ({ name: "Worker", emoji: "🐧" }),
    getAgentStableId: () => "stable-worker",
    getAgentOwnerToken: () => "owner-token",
    setAgentOwnerToken: vi.fn(),
    getDesiredAgentStatus: () => "idle",
    getAgentAliases: () => [],
    getThreads: () => new Map(),
    getLastDmChannel: () => null,
    setLastDmChannel: vi.fn(),
    pushInboxMessages: vi.fn(),
    getAgentMetadata: async () => ({}),
    applyRegistrationIdentity: vi.fn(),
    applySkinUpdate: vi.fn(),
    persistState: vi.fn(),
    updateBadge: vi.fn(),
    maybeDrainInboxIfIdle: vi.fn(() => false),
    requestRemoteControl: vi.fn(),
    deferControlAck: vi.fn(),
    runRemoteControl: vi.fn(),
    deliverFollowUpMessage: vi.fn(() => false),
    setExtStatus: vi.fn(),
    noteRuntimeFailure: vi.fn(),
    clearRuntimeFailure: vi.fn(),
    getRuntimeFailure: () => null,
    handleTerminalReconnectFailure: vi.fn(),
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    deliveryState: {
      queuedButUndeliveredIds: new Set<number>(),
      deliveredAwaitingAckIds: new Set<number>(),
      ackInFlightIds: new Set<number>(),
    },
    ...overrides,
  };
}

describe("createFollowerRuntime types", () => {
  it("accepts structured follower runtime failure events", () => {
    const event: FollowerRuntimeFailureEvent = {
      kind: "poll_error",
      message: "socket unavailable",
      retryable: true,
      nextStep: "Follower will keep polling automatically.",
      error: new Error("socket unavailable"),
    };

    const deps = createDeps({
      noteRuntimeFailure: vi.fn((_, received) => {
        expect(received).toEqual(event);
      }),
    });

    deps.noteRuntimeFailure(createCtx(), event);
    expect(deps.noteRuntimeFailure).toHaveBeenCalledTimes(1);
  });

  it("constructs the runtime with explicit failure hooks", () => {
    const runtime = createFollowerRuntime(createDeps());
    expect(runtime.getClientRef()).toBeNull();
  });
});
