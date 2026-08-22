import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentGoal, GoalContinuationClaim } from "./domain.js";
import { GoalWindow } from "./goal-window.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  objective:
    "Ship a focused goal window that remains readable even when the objective is longer than one line.",
  status: "active",
  budget: { maxIterations: 8, maxTokens: 50_000, maxRuntimeMs: 3_600_000 },
  usage: { iterations: 3, tokens: 12_430 },
  lastEvaluation: {
    id: "evaluation-1",
    outcome: "continue",
    reason: "Interaction tests remain",
    at: "2026-01-01T00:10:00.000Z",
  },
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:10:00.000Z",
};

const claim: GoalContinuationClaim = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 4,
  claimId: "claim-1",
  state: "deferred",
  reason: "session busy",
  attempt: 2,
  availableAt: "2026-01-01T00:10:01.000Z",
  expiresAt: "2026-01-01T00:11:00.000Z",
  createdAt: "2026-01-01T00:10:00.000Z",
  updatedAt: "2026-01-01T00:10:00.000Z",
};

describe("GoalWindow", () => {
  it("renders compact goal state and keeps every line within the available width", () => {
    const window = new GoalWindow(goal, claim, theme, vi.fn(), () =>
      Date.parse("2026-01-01T00:15:00.000Z"),
    );

    const lines = window.render(52);

    expect(lines.join("\n")).toContain("● ACTIVE");
    expect(lines.join("\n")).toContain("Turns");
    expect(lines.join("\n")).toContain("3/8");
    expect(lines.join("\n")).toContain("12.4k/50k");
    expect(lines.join("\n")).toContain("15m/60m");
    expect(lines.join("\n")).toContain("Latest Interaction tests remain");
    expect(lines.join("\n")).toContain("Continuation deferred · attempt 2");
    expect(lines.every((line) => visibleWidth(line) <= 52)).toBe(true);
  });

  it("renders a useful empty state", () => {
    const lines = new GoalWindow(undefined, undefined, theme, vi.fn()).render(40);

    expect(lines.join("\n")).toContain("No goal for this session.");
    expect(lines.join("\n")).toContain("/goal <objective> to begin");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "honors the strict line-width contract at width %i",
    (width) => {
      const lines = new GoalWindow(goal, claim, theme, vi.fn()).render(width);

      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it.each(["q", "Q", "\u001b", "\r", "\u0003"])("closes for %j", (input) => {
    const onClose = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onClose);

    window.handleInput(input);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores unrelated input", () => {
    const onClose = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onClose);

    window.handleInput("x");

    expect(onClose).not.toHaveBeenCalled();
  });
});
