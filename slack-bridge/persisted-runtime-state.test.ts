import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildPinetOwnerToken } from "./helpers.js";
import {
  createPersistedRuntimeState,
  type PersistedRuntimeStateDeps,
  type PersistedState,
} from "./persisted-runtime-state.js";
import type { SinglePlayerThreadInfo } from "./single-player-runtime.js";

interface MutableRuntimeState {
  lastDmChannel: string | null;
  agentName: string;
  agentEmoji: string;
  agentStableId: string;
  brokerStableId: string;
  brokerRole: "broker" | "follower" | null;
  activeSkinTheme: string | null;
  agentPersonality: string | null;
  agentOwnerToken: string;
  controlPlaneCanvasId: string | null;
  controlPlaneCanvasChannelId: string | null;
}

function createDeps(
  overrides: {
    state?: Partial<MutableRuntimeState>;
    threads?: Map<string, SinglePlayerThreadInfo>;
    userNames?: Map<string, string>;
    agentAliases?: Set<string>;
    settings?: PersistedRuntimeStateDeps["getSettings"];
    formatError?: PersistedRuntimeStateDeps["formatError"];
  } = {},
) {
  const state: MutableRuntimeState = {
    lastDmChannel: "D_CURRENT",
    agentName: "Cobalt Olive Crane",
    agentEmoji: "🦩",
    agentStableId: "agent-stable-current",
    brokerStableId: "broker-stable-current",
    brokerRole: null,
    activeSkinTheme: "cobalt",
    agentPersonality: "steady",
    agentOwnerToken: "owner:current",
    controlPlaneCanvasId: "CANVAS_CURRENT",
    controlPlaneCanvasChannelId: "C_CURRENT",
    ...overrides.state,
  };
  const threads =
    overrides.threads ??
    new Map<string, SinglePlayerThreadInfo>([
      [
        "100.1",
        {
          channelId: "D_CURRENT",
          threadTs: "100.1",
          userId: "U_CURRENT",
          owner: "owner:current",
        },
      ],
    ]);
  const userNames = overrides.userNames ?? new Map<string, string>([["U_CURRENT", "Current User"]]);
  const agentAliases = overrides.agentAliases ?? new Set<string>(["Current Alias"]);
  const appendEntry = vi.fn<(customType: string, data?: unknown) => void>();
  const restoreControlPlaneCanvasRuntimeState = vi.fn(
    ({ canvasId, channelId }: { canvasId: string | null; channelId: string | null }) => {
      state.controlPlaneCanvasId = canvasId;
      state.controlPlaneCanvasChannelId = channelId;
    },
  );

  const deps: PersistedRuntimeStateDeps = {
    pi: {
      appendEntry: (customType, data) => {
        appendEntry(customType, data);
      },
    },
    threads,
    userNames,
    getLastDmChannel: () => state.lastDmChannel,
    setLastDmChannel: (channelId) => {
      state.lastDmChannel = channelId;
    },
    getAgentName: () => state.agentName,
    setAgentName: (name) => {
      state.agentName = name;
    },
    getAgentEmoji: () => state.agentEmoji,
    setAgentEmoji: (emoji) => {
      state.agentEmoji = emoji;
    },
    getAgentStableId: () => state.agentStableId,
    setAgentStableId: (stableId) => {
      state.agentStableId = stableId;
    },
    getBrokerStableId: () => state.brokerStableId,
    setBrokerStableId: (stableId) => {
      state.brokerStableId = stableId;
    },
    getBrokerRole: () => state.brokerRole,
    getActiveSkinTheme: () => state.activeSkinTheme,
    setActiveSkinTheme: (theme) => {
      state.activeSkinTheme = theme;
    },
    getAgentPersonality: () => state.agentPersonality,
    setAgentPersonality: (personality) => {
      state.agentPersonality = personality;
    },
    agentAliases,
    setAgentOwnerToken: (ownerToken) => {
      state.agentOwnerToken = ownerToken;
    },
    getSettings: overrides.settings ?? (() => ({})),
    getControlPlaneCanvasRuntimeId: () => state.controlPlaneCanvasId,
    getControlPlaneCanvasRuntimeChannelId: () => state.controlPlaneCanvasChannelId,
    restoreControlPlaneCanvasRuntimeState,
    formatError:
      overrides.formatError ??
      ((error) => (error instanceof Error ? error.message : String(error))),
  };

  return {
    deps,
    state,
    threads,
    userNames,
    agentAliases,
    appendEntry,
    restoreControlPlaneCanvasRuntimeState,
  };
}

function createContext(
  entries: Array<{ type: string; customType: string; data: PersistedState }> = [],
): ExtensionContext {
  return {
    cwd: "/tmp/project",
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: {
        fg: (_color: string, text: string) => text,
      },
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: () => entries,
      getHeader: () => null,
      getLeafId: () => "leaf-123",
      getSessionFile: () => "/tmp/session.json",
    },
  } as unknown as ExtensionContext;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createPersistedRuntimeState", () => {
  it("persists the current runtime snapshot immediately", () => {
    const { deps, appendEntry } = createDeps({
      state: {
        brokerRole: "broker",
        activeSkinTheme: "oceanic",
        agentPersonality: "calm",
        controlPlaneCanvasId: "CANVAS_RUNTIME",
        controlPlaneCanvasChannelId: "C_RUNTIME",
      },
      threads: new Map([
        [
          "200.1",
          {
            channelId: "D200",
            threadTs: "200.1",
            userId: "U200",
            owner: "owner:200",
          },
        ],
      ]),
      userNames: new Map([["U200", "River User"]]),
      agentAliases: new Set(["Cobalt", "Crane"]),
    });
    const persistedRuntimeState = createPersistedRuntimeState(deps);

    persistedRuntimeState.persistStateNow();

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenCalledWith("slack-bridge-state", {
      threads: [
        [
          "200.1",
          {
            channelId: "D200",
            threadTs: "200.1",
            userId: "U200",
            owner: "owner:200",
          },
        ],
      ],
      lastDmChannel: "D_CURRENT",
      userNames: [["U200", "River User"]],
      agentName: "Cobalt Olive Crane",
      agentEmoji: "🦩",
      agentStableId: "agent-stable-current",
      brokerStableId: "broker-stable-current",
      lastPinetRole: "broker",
      activeSkinTheme: "oceanic",
      agentPersonality: "calm",
      agentAliases: ["Cobalt", "Crane"],
      brokerControlPlaneCanvasId: "CANVAS_RUNTIME",
      brokerControlPlaneCanvasChannelId: "C_RUNTIME",
    });
  });

  it("debounces scheduled persistence and flushes only the latest snapshot", () => {
    vi.useFakeTimers();

    const { deps, state, appendEntry } = createDeps();
    const persistedRuntimeState = createPersistedRuntimeState(deps);

    persistedRuntimeState.persistState();
    state.agentName = "First Rename";
    persistedRuntimeState.persistState();
    state.agentName = "Final Rename";

    vi.advanceTimersByTime(999);
    expect(appendEntry).not.toHaveBeenCalled();

    persistedRuntimeState.flushPersist();
    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenLastCalledWith(
      "slack-bridge-state",
      expect.objectContaining({ agentName: "Final Rename" }),
    );

    vi.advanceTimersByTime(5_000);
    expect(appendEntry).toHaveBeenCalledTimes(1);

    persistedRuntimeState.flushPersist();
    expect(appendEntry).toHaveBeenCalledTimes(1);
  });

  it("restores persisted runtime state, preserves existing live data, and re-persists normalized state", () => {
    const {
      deps,
      state,
      threads,
      userNames,
      agentAliases,
      appendEntry,
      restoreControlPlaneCanvasRuntimeState,
    } = createDeps({
      state: {
        lastDmChannel: "D_EXISTING",
        agentName: "Current Crane",
        agentEmoji: "🪿",
        agentStableId: "agent-stable-live",
        brokerStableId: "broker-stable-live",
        agentOwnerToken: "owner:live",
        activeSkinTheme: null,
        agentPersonality: null,
        controlPlaneCanvasId: "CANVAS_FALLBACK",
        controlPlaneCanvasChannelId: "C_FALLBACK",
      },
    });
    const persistedRuntimeState = createPersistedRuntimeState(deps);
    const savedState: PersistedState = {
      threads: [
        [
          "100.1",
          {
            channelId: "D_SAVED",
            threadTs: "100.1",
            userId: "U_SAVED",
            owner: "owner:saved-ignored",
          },
        ],
        [
          "200.1",
          {
            channelId: "D_200",
            threadTs: "200.1",
            userId: "U_200",
            owner: "owner:200",
          },
        ],
      ],
      lastDmChannel: "D_SAVED",
      userNames: [
        ["U_CURRENT", "Saved Name Ignored"],
        ["U_200", "Saved User"],
      ],
      agentName: "Saved Crane",
      agentEmoji: "🦩",
      agentStableId: "agent-stable-saved",
      brokerStableId: "broker-stable-saved",
      lastPinetRole: "broker",
      activeSkinTheme: "midnight",
      agentPersonality: "observant",
      agentAliases: ["Saved Alias", "Night Crane"],
      brokerControlPlaneCanvasId: "  CANVAS_SAVED  ",
      brokerControlPlaneCanvasChannelId: "   ",
    };

    persistedRuntimeState.restorePersistedRuntimeState(
      createContext([
        { type: "custom", customType: "other-state", data: {} as PersistedState },
        { type: "custom", customType: "slack-bridge-state", data: savedState },
      ]),
    );

    expect(state.agentName).toBe("Saved Crane");
    expect(state.agentEmoji).toBe("🦩");
    expect(state.agentStableId).toBe("agent-stable-saved");
    expect(state.brokerStableId).toBe("broker-stable-saved");
    expect(state.agentOwnerToken).toBe(buildPinetOwnerToken("broker-stable-saved"));
    expect(state.activeSkinTheme).toBe("midnight");
    expect(state.agentPersonality).toBe("observant");
    expect([...agentAliases]).toEqual(["Saved Alias", "Night Crane"]);

    expect(threads.get("100.1")?.owner).toBe("owner:current");
    expect(threads.get("200.1")).toEqual({
      channelId: "D_200",
      threadTs: "200.1",
      userId: "U_200",
      owner: "owner:200",
    });
    expect(state.lastDmChannel).toBe("D_EXISTING");
    expect(userNames.get("U_CURRENT")).toBe("Current User");
    expect(userNames.get("U_200")).toBe("Saved User");

    expect(restoreControlPlaneCanvasRuntimeState).toHaveBeenCalledWith({
      canvasId: "CANVAS_SAVED",
      channelId: "C_FALLBACK",
    });
    expect(state.controlPlaneCanvasId).toBe("CANVAS_SAVED");
    expect(state.controlPlaneCanvasChannelId).toBe("C_FALLBACK");

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(appendEntry).toHaveBeenLastCalledWith("slack-bridge-state", {
      threads: [
        [
          "100.1",
          {
            channelId: "D_CURRENT",
            threadTs: "100.1",
            userId: "U_CURRENT",
            owner: "owner:current",
          },
        ],
        [
          "200.1",
          {
            channelId: "D_200",
            threadTs: "200.1",
            userId: "U_200",
            owner: "owner:200",
          },
        ],
      ],
      lastDmChannel: "D_EXISTING",
      userNames: [
        ["U_CURRENT", "Current User"],
        ["U_200", "Saved User"],
      ],
      agentName: "Saved Crane",
      agentEmoji: "🦩",
      agentStableId: "agent-stable-saved",
      brokerStableId: "broker-stable-saved",
      lastPinetRole: "worker",
      activeSkinTheme: "midnight",
      agentPersonality: "observant",
      agentAliases: ["Saved Alias", "Night Crane"],
      brokerControlPlaneCanvasId: "CANVAS_SAVED",
      brokerControlPlaneCanvasChannelId: "C_FALLBACK",
    });
  });
});
