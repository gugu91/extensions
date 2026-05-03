import {
  buildPinetSkinAssignment,
  buildPinetSkinMetadata,
  normalizePinetSkinTheme,
  type PinetSkinStatusVocabulary,
} from "./helpers.js";

export interface PinetMeshSkinAgentRecord {
  id: string;
  stableId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PinetMeshSkinUpdatedAgentRecord {
  id: string;
  name: string;
  emoji: string;
}

export interface PinetMeshSkinBrokerDbPort {
  setSetting: (key: string, value: string) => void;
  getAgents: () => PinetMeshSkinAgentRecord[];
  updateAgentIdentity: (
    agentId: string,
    update: {
      name: string;
      emoji: string;
      metadata: Record<string, unknown>;
    },
  ) => PinetMeshSkinUpdatedAgentRecord | null;
}

export interface PinetMeshSkinDispatchInput {
  senderAgentId: string;
  senderAgentName: string;
  target: string;
  body: string;
  metadata: Record<string, unknown>;
}

export interface PinetMeshSkinDeps {
  getBrokerRole: () => "broker" | "follower" | null;
  getActiveBrokerDb: () => PinetMeshSkinBrokerDbPort | null;
  getActiveBrokerSelfId: () => string | null;
  pinetSkinSettingKey: string;
  setActiveSkinTheme: (theme: string) => void;
  getMeshRoleFromMetadata: (
    metadata: Record<string, unknown> | undefined,
    fallback: "broker" | "worker",
  ) => "broker" | "worker";
  buildSkinMetadata: (
    metadata: Record<string, unknown> | undefined,
    personality: string,
    statusVocabulary?: PinetSkinStatusVocabulary,
  ) => Record<string, unknown>;
  applyLocalAgentIdentity: (
    nextName: string,
    nextEmoji: string,
    nextPersonality: string | null,
  ) => void;
  getAgentName: () => string;
  dispatchDirectAgentMessage: (input: PinetMeshSkinDispatchInput) => void;
  persistState: () => void;
}

export interface PinetMeshSkin {
  applyMeshSkin: (themeInput: string) => { theme: string; updatedAgents: string[] };
}

export function createPinetMeshSkin(deps: PinetMeshSkinDeps): PinetMeshSkin {
  function applyMeshSkin(themeInput: string): { theme: string; updatedAgents: string[] } {
    const db = deps.getActiveBrokerDb();
    const selfId = deps.getActiveBrokerSelfId();
    if (deps.getBrokerRole() !== "broker" || !db) {
      throw new Error("/pinet-skin can only run on the active broker.");
    }

    const theme = normalizePinetSkinTheme(themeInput);
    if (!theme) {
      throw new Error("Usage: /pinet-skin <theme>");
    }

    if (!selfId) {
      throw new Error("Broker agent identity is unavailable.");
    }

    deps.setActiveSkinTheme(theme);
    db.setSetting(deps.pinetSkinSettingKey, theme);

    const updatedAgents: string[] = [];
    for (const agent of db.getAgents()) {
      const role =
        agent.id === selfId
          ? "broker"
          : deps.getMeshRoleFromMetadata(agent.metadata ?? undefined, "worker");
      const assignment = buildPinetSkinAssignment({
        theme,
        role,
        seed: agent.stableId ?? agent.id,
      });
      const updated = db.updateAgentIdentity(agent.id, {
        name: assignment.name,
        emoji: assignment.emoji,
        metadata: deps.buildSkinMetadata(
          agent.metadata ?? undefined,
          assignment.personality,
          assignment.statusVocabulary,
        ),
      });
      if (!updated) {
        continue;
      }

      if (agent.id === selfId) {
        deps.applyLocalAgentIdentity(updated.name, updated.emoji, assignment.personality);
      } else {
        deps.dispatchDirectAgentMessage({
          senderAgentId: selfId,
          senderAgentName: deps.getAgentName(),
          target: updated.id,
          body: `Mesh skin changed to ${theme}`,
          metadata: buildPinetSkinMetadata({
            theme,
            name: updated.name,
            emoji: updated.emoji,
            personality: assignment.personality,
            statusVocabulary: assignment.statusVocabulary,
          }),
        });
      }

      updatedAgents.push(updated.name);
    }

    deps.persistState();
    return { theme, updatedAgents };
  }

  return {
    applyMeshSkin,
  };
}
