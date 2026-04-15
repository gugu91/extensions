import { describe, expect, it, vi } from "vitest";
import {
  createPinetMeshSkin,
  type PinetMeshSkinAgentRecord,
  type PinetMeshSkinBrokerDbPort,
  type PinetMeshSkinDeps,
} from "./pinet-skin.js";

function createDeps(overrides: Partial<PinetMeshSkinDeps> = {}) {
  let activeSkinTheme: string | null = null;
  const agents: PinetMeshSkinAgentRecord[] = [
    {
      id: "broker-1",
      stableId: "stable-broker-1",
      metadata: { role: "broker", existing: "broker-meta" },
    },
    {
      id: "worker-1",
      stableId: "stable-worker-1",
      metadata: { role: "worker", existing: "worker-meta" },
    },
  ];
  const setSetting = vi.fn();
  const updateAgentIdentity = vi.fn(
    (
      id: string,
      update: {
        name: string;
        emoji: string;
        metadata: Record<string, unknown>;
      },
    ) => ({ id, name: update.name, emoji: update.emoji }),
  );
  const db: PinetMeshSkinBrokerDbPort = {
    setSetting,
    getAgents: () => agents,
    updateAgentIdentity,
  };
  const applyLocalAgentIdentity = vi.fn();
  const dispatchDirectAgentMessage = vi.fn();
  const persistState = vi.fn();

  const deps: PinetMeshSkinDeps = {
    getBrokerRole: () => "broker",
    getActiveBrokerDb: () => db,
    getActiveBrokerSelfId: () => "broker-1",
    pinetSkinSettingKey: "pinet.skinTheme",
    setActiveSkinTheme: (theme) => {
      activeSkinTheme = theme;
    },
    getMeshRoleFromMetadata: (metadata, fallback) =>
      metadata?.role === "broker" ? "broker" : fallback,
    buildSkinMetadata: (metadata, personality) => ({
      ...(metadata ?? {}),
      ...(activeSkinTheme ? { skinTheme: activeSkinTheme } : {}),
      personality,
    }),
    applyLocalAgentIdentity,
    getAgentName: () => "Broker Crane",
    dispatchDirectAgentMessage,
    persistState,
    ...overrides,
  };

  return {
    deps,
    setSetting,
    updateAgentIdentity,
    applyLocalAgentIdentity,
    dispatchDirectAgentMessage,
    persistState,
    getActiveSkinTheme: () => activeSkinTheme,
  };
}

describe("createPinetMeshSkin", () => {
  it("rejects non-broker callers", () => {
    const { deps } = createDeps({
      getBrokerRole: () => "follower",
    });
    const pinetMeshSkin = createPinetMeshSkin(deps);

    expect(() => pinetMeshSkin.applyMeshSkin("cyberpunk neon")).toThrow(
      "/pinet-skin can only run on the active broker.",
    );
  });

  it("rejects empty themes", () => {
    const { deps } = createDeps();
    const pinetMeshSkin = createPinetMeshSkin(deps);

    expect(() => pinetMeshSkin.applyMeshSkin("   ")).toThrow("Usage: /pinet-skin <theme>");
  });

  it("requires the broker identity to be available", () => {
    const { deps } = createDeps({
      getActiveBrokerSelfId: () => null,
    });
    const pinetMeshSkin = createPinetMeshSkin(deps);

    expect(() => pinetMeshSkin.applyMeshSkin("cyberpunk neon")).toThrow(
      "Broker agent identity is unavailable.",
    );
  });

  it("applies the mesh skin, updates local identity, and notifies other agents", () => {
    const {
      deps,
      setSetting,
      updateAgentIdentity,
      applyLocalAgentIdentity,
      dispatchDirectAgentMessage,
      persistState,
      getActiveSkinTheme,
    } = createDeps();
    const pinetMeshSkin = createPinetMeshSkin(deps);

    const result = pinetMeshSkin.applyMeshSkin("  cyberpunk neon  ");

    expect(result.theme).toBe("cyberpunk neon");
    expect(result.updatedAgents).toHaveLength(2);
    expect(getActiveSkinTheme()).toBe("cyberpunk neon");
    expect(setSetting).toHaveBeenCalledWith("pinet.skinTheme", "cyberpunk neon");
    expect(updateAgentIdentity).toHaveBeenCalledTimes(2);
    expect(updateAgentIdentity).toHaveBeenNthCalledWith(
      1,
      "broker-1",
      expect.objectContaining({
        name: expect.any(String),
        emoji: expect.any(String),
        metadata: expect.objectContaining({
          role: "broker",
          existing: "broker-meta",
          skinTheme: "cyberpunk neon",
          personality: expect.any(String),
        }),
      }),
    );
    expect(updateAgentIdentity).toHaveBeenNthCalledWith(
      2,
      "worker-1",
      expect.objectContaining({
        name: expect.any(String),
        emoji: expect.any(String),
        metadata: expect.objectContaining({
          role: "worker",
          existing: "worker-meta",
          skinTheme: "cyberpunk neon",
          personality: expect.any(String),
        }),
      }),
    );
    expect(applyLocalAgentIdentity).toHaveBeenCalledWith(
      result.updatedAgents[0],
      expect.any(String),
      expect.any(String),
    );
    expect(dispatchDirectAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAgentId: "broker-1",
        senderAgentName: "Broker Crane",
        target: "worker-1",
        body: "Mesh skin changed to cyberpunk neon",
        metadata: expect.objectContaining({
          kind: "pinet_skin",
          theme: "cyberpunk neon",
          name: result.updatedAgents[1],
          emoji: expect.any(String),
          personality: expect.any(String),
        }),
      }),
    );
    expect(persistState).toHaveBeenCalledTimes(1);
  });
});
