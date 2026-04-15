import { describe, expect, it, vi } from "vitest";
import {
  createAgentPromptGuidance,
  type AgentPromptGuidanceDeps,
} from "./agent-prompt-guidance.js";

function createDeps(overrides: Partial<AgentPromptGuidanceDeps> = {}): AgentPromptGuidanceDeps {
  return {
    getIdentityGuidelines: () => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"],
    getAgentName: () => "Cobalt Olive Crane",
    getAgentEmoji: () => "🦩",
    getActiveSkinTheme: () => null,
    getAgentPersonality: () => null,
    getBrokerRole: () => null,
    ...overrides,
  };
}

describe("createAgentPromptGuidance", () => {
  it("appends identity, personality, and reaction guidance for non-mesh sessions", async () => {
    const getIdentityGuidelines = vi.fn(() => ["IDENTITY 1", "IDENTITY 2", "IDENTITY 3"]);
    const guidance = createAgentPromptGuidance(
      createDeps({
        getIdentityGuidelines,
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(getIdentityGuidelines).toHaveBeenCalledTimes(1);
    expect(result.systemPrompt).toContain("BASE\n\nIDENTITY 1\nIDENTITY 2\nIDENTITY 3");
    expect(result.systemPrompt).toContain("COMMUNICATION STYLE:");
    expect(result.systemPrompt).toContain("For `Cobalt Olive Crane`, aim for a");
    expect(result.systemPrompt).toContain("Reaction-triggered requests may appear");
    expect(result.systemPrompt).not.toContain("PINET SKIN (");
    expect(result.systemPrompt).not.toContain("Pinet BROKER");
    expect(result.systemPrompt).not.toContain("TASK WORKFLOW:");
    expect(result.systemPrompt.indexOf("IDENTITY 1")).toBeLessThan(
      result.systemPrompt.indexOf("COMMUNICATION STYLE:"),
    );
    expect(result.systemPrompt.indexOf("COMMUNICATION STYLE:")).toBeLessThan(
      result.systemPrompt.indexOf("Reaction-triggered requests may appear"),
    );
  });

  it("includes the skin guideline only when both theme and personality are available", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getActiveSkinTheme: () => "ocean-mist",
        getAgentPersonality: () => "steady, elegant, observant",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("PINET SKIN (");
    expect(result.systemPrompt).toContain("steady, elegant, observant");
  });

  it("adds broker-specific prompt guidance and tool guardrails for the broker role", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "broker",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain("You are 🦩 Cobalt Olive Crane, the Pinet BROKER.");
    expect(result.systemPrompt).toContain("🚫 BROKER TOOL RESTRICTION:");
    expect(result.systemPrompt).not.toContain("TASK WORKFLOW:");
  });

  it("adds worker workflow guidance for follower runtimes", async () => {
    const guidance = createAgentPromptGuidance(
      createDeps({
        getBrokerRole: () => "follower",
      }),
    );

    const result = await guidance.beforeAgentStart({ systemPrompt: "BASE" });

    expect(result.systemPrompt).toContain(
      "TASK WORKFLOW: When you receive work, follow these steps:",
    );
    expect(result.systemPrompt).toContain("REPLY TOOL RULES:");
    expect(result.systemPrompt).not.toContain("Pinet BROKER");
    expect(result.systemPrompt).not.toContain("🚫 BROKER TOOL RESTRICTION:");
  });
});
