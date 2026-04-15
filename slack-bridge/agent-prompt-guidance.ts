import {
  buildAgentPersonalityGuidelines,
  buildBrokerPromptGuidelines,
  buildPinetSkinPromptGuideline,
  buildWorkerPromptGuidelines,
} from "./helpers.js";
import { buildBrokerToolGuardrailsPrompt } from "./guardrails.js";
import { buildReactionPromptGuidelines } from "./reaction-triggers.js";

export interface BeforeAgentStartEvent {
  systemPrompt: string;
}

export interface AgentPromptGuidanceDeps {
  getIdentityGuidelines: () => string[];
  getAgentName: () => string;
  getAgentEmoji: () => string;
  getActiveSkinTheme: () => string | null;
  getAgentPersonality: () => string | null;
  getBrokerRole: () => "broker" | "follower" | null;
}

export interface AgentPromptGuidance {
  beforeAgentStart: (event: BeforeAgentStartEvent) => Promise<{ systemPrompt: string }>;
}

export function createAgentPromptGuidance(deps: AgentPromptGuidanceDeps): AgentPromptGuidance {
  function buildPromptGuidelines(): string[] {
    const agentName = deps.getAgentName();
    const guidelines = [
      ...deps.getIdentityGuidelines(),
      ...buildAgentPersonalityGuidelines(agentName),
      ...buildReactionPromptGuidelines(),
    ];

    const skinGuideline = buildPinetSkinPromptGuideline(
      deps.getActiveSkinTheme(),
      deps.getAgentPersonality(),
    );
    if (skinGuideline) {
      guidelines.push(skinGuideline);
    }

    if (deps.getBrokerRole() === "broker") {
      guidelines.push(...buildBrokerPromptGuidelines(deps.getAgentEmoji(), agentName));
      guidelines.push(buildBrokerToolGuardrailsPrompt());
    } else if (deps.getBrokerRole() === "follower") {
      guidelines.push(...buildWorkerPromptGuidelines());
    }

    return guidelines;
  }

  async function beforeAgentStart(event: BeforeAgentStartEvent): Promise<{ systemPrompt: string }> {
    return {
      systemPrompt: event.systemPrompt + "\n\n" + buildPromptGuidelines().join("\n"),
    };
  }

  return {
    beforeAgentStart,
  };
}
