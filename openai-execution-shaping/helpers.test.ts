import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";
import {
  buildAutoContinueMessage,
  buildExecutionShapingPrompt,
  classifyContinuationNeed,
  countAssistantToolCalls,
  extractAssistantText,
  isTargetModel,
  normalizeModelId,
} from "./helpers.js";

describe("resolveConfig", () => {
  it("defaults to disabled experimental behavior", () => {
    const config = resolveConfig(null);

    expect(config.enabled).toBe(false);
    expect(config.providers).toEqual(["openai", "openai-codex"]);
    expect(config.modelRegexSource).toBe("^gpt-5");
    expect(config.promptOverlayEnabled).toBe(true);
    expect(config.autoContinueEnabled).toBe(true);
    expect(config.maxAutoContinueTurns).toBe(1);
  });

  it("normalizes custom config and clamps max auto-continue turns", () => {
    const config = resolveConfig(
      {
        enabled: true,
        providers: ["openai-codex"],
        modelRegex: "gpt-5\\.4",
        autoContinue: { enabled: true, maxTurns: 9 },
        promptOverlay: { enabled: false },
        debug: true,
      },
      "/tmp/settings.json#openai-execution-shaping",
    );

    expect(config.enabled).toBe(true);
    expect(config.providers).toEqual(["openai-codex"]);
    expect(config.modelRegex.test("gpt-5.4")).toBe(true);
    expect(config.maxAutoContinueTurns).toBe(5);
    expect(config.promptOverlayEnabled).toBe(false);
    expect(config.debug).toBe(true);
    expect(config.sourcePath).toBe("/tmp/settings.json#openai-execution-shaping");
  });
});

describe("target model matching", () => {
  const enabledConfig = resolveConfig({ enabled: true });

  it("matches targeted OpenAI GPT-5 models", () => {
    expect(isTargetModel({ provider: "openai", id: "gpt-5.4" }, enabledConfig)).toBe(true);
    expect(
      isTargetModel({ provider: "openai-codex", id: "openai-codex/gpt-5.4" }, enabledConfig),
    ).toBe(true);
  });

  it("does not match non-target providers or models", () => {
    expect(isTargetModel({ provider: "anthropic", id: "claude-sonnet-4-5" }, enabledConfig)).toBe(
      false,
    );
    expect(isTargetModel({ provider: "openai", id: "gpt-4.1" }, enabledConfig)).toBe(false);
  });

  it("normalizes provider-prefixed model ids", () => {
    expect(normalizeModelId("openai/gpt-5.4", "openai")).toBe("gpt-5.4");
    expect(normalizeModelId("openai-codex:gpt-5.4", "openai-codex")).toBe("gpt-5.4");
  });
});

describe("assistant drift detection", () => {
  it("extracts text and tool calls from assistant messages", () => {
    const message = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "text", text: "I will inspect the repo first." },
        { type: "toolCall", text: undefined },
      ],
    };

    expect(extractAssistantText(message)).toBe("I will inspect the repo first.");
    expect(countAssistantToolCalls(message)).toBe(1);
  });

  it("requests auto-continue for plan-only continuation intent", () => {
    const decision = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "I'll inspect the repository structure and then update the files.",
          },
        ],
      },
      toolResultCount: 0,
      usedAutoContinueTurns: 0,
      maxAutoContinueTurns: 1,
    });

    expect(decision).toEqual({ shouldContinue: true, reason: "continuation-intent" });
  });

  it("requests auto-continue for approval-handoff drift", () => {
    const decision = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "I can start by checking the config and the files. Let me know if you'd like me to continue.",
          },
        ],
      },
      toolResultCount: 0,
      usedAutoContinueTurns: 0,
      maxAutoContinueTurns: 1,
    });

    expect(decision).toEqual({ shouldContinue: true, reason: "approval-handoff" });
  });

  it("does not auto-continue after tool progress or completion language", () => {
    const withToolProgress = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "I'll inspect the repository structure and then update the files.",
          },
        ],
      },
      toolResultCount: 1,
      usedAutoContinueTurns: 0,
      maxAutoContinueTurns: 1,
    });

    const completed = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Done. I updated the files and verified the fix." }],
      },
      toolResultCount: 0,
      usedAutoContinueTurns: 0,
      maxAutoContinueTurns: 1,
    });

    expect(withToolProgress.shouldContinue).toBe(false);
    expect(withToolProgress.reason).toBe("has-tool-results");
    expect(completed.shouldContinue).toBe(false);
    expect(completed.reason).toBe("completion-language");
  });

  it("does not auto-continue genuine blockers or exhausted budgets", () => {
    const blocker = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "Which file should I edit first?" }],
      },
      toolResultCount: 0,
      usedAutoContinueTurns: 0,
      maxAutoContinueTurns: 1,
    });

    const exhausted = classifyContinuationNeed({
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "I'll inspect the repository structure and then update the files.",
          },
        ],
      },
      toolResultCount: 0,
      usedAutoContinueTurns: 1,
      maxAutoContinueTurns: 1,
    });

    expect(blocker.shouldContinue).toBe(false);
    expect(blocker.reason).toBe("blocker-or-clarification");
    expect(exhausted.shouldContinue).toBe(false);
    expect(exhausted.reason).toBe("budget-exhausted");
  });
});

describe("prompt text", () => {
  it("builds the execution-shaping overlay and continuation message", () => {
    const overlay = buildExecutionShapingPrompt();
    const continueMessage = buildAutoContinueMessage();

    expect(overlay).toContain("Commentary-only turns are incomplete");
    expect(overlay).toContain("Do not stop after one exploratory step");
    expect(continueMessage).toContain("Continue.");
    expect(continueMessage).toContain("Commentary-only replies are incomplete");
  });
});
