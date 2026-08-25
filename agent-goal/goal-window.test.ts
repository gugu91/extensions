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
    const window = new GoalWindow(goal, claim, theme, vi.fn(), vi.fn(), () =>
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
    expect(lines.join("\n")).toContain("p pause · b budget · c complete");
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

  it.each(["q", "Q", "\u001b", "\u0003"])("closes for %j", (input) => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);

    window.handleInput(input);

    expect(onAction).toHaveBeenCalledWith("close");
  });

  it.each([
    ["p", "pause"],
    ["P", "pause"],
  ] as const)("routes %s to %s", (input, action) => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);

    window.handleInput(input);

    expect(onAction).toHaveBeenCalledWith(action);
  });

  it("edits turn and token budgets without closing the overlay", () => {
    const onAction = vi.fn();
    const requestRender = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction, requestRender);

    window.handleInput("b");
    expect(window.render(52).join("\n")).toContain("Edit budget");
    expect(window.render(52).join("\n")).toContain("› Turns  8");

    window.handleInput("1");
    window.handleInput("\t");
    window.handleInput("60000");
    window.handleInput("\r");

    expect(onAction).toHaveBeenCalledWith({
      type: "budget",
      maxIterations: 1,
      maxTokens: 60_000,
    });
    expect(requestRender).toHaveBeenCalledTimes(4);
  });

  it("validates budget input and cancels editing with escape", () => {
    const onAction = vi.fn();
    const requestRender = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction, requestRender);

    window.handleInput("b");
    window.handleInput("\u007f");
    window.handleInput("\r");

    expect(window.render(52).join("\n")).toContain("Turns must be a positive integer");
    window.handleInput("\u001b");
    expect(window.render(52).join("\n")).toContain("b budget");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders runtime budget errors inside the reopened overlay", () => {
    const window = new GoalWindow(
      goal,
      undefined,
      theme,
      vi.fn(),
      vi.fn(),
      Date.now,
      "Goal maxIterations cannot exceed the configured limit",
    );

    expect(window.render(52).join("\n")).toContain("Goal maxIterations cannot exceed the configur");
  });

  it("offers resume for paused and blocked goals", () => {
    const onPausedAction = vi.fn();
    const onBlockedAction = vi.fn();
    new GoalWindow({ ...goal, status: "paused" }, undefined, theme, onPausedAction).handleInput(
      "r",
    );
    new GoalWindow({ ...goal, status: "blocked" }, undefined, theme, onBlockedAction).handleInput(
      "r",
    );

    expect(onPausedAction).toHaveBeenCalledWith("resume");
    expect(onBlockedAction).toHaveBeenCalledWith("resume");
  });

  it.each([
    ["c", "complete"],
    ["x", "clear"],
  ] as const)("requires confirmation before %s", (input, action) => {
    const onAction = vi.fn();
    const requestRender = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction, requestRender);

    window.handleInput(input);

    expect(onAction).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(window.render(52).join("\n")).toContain(`${input} again to confirm ${action}`);

    window.handleInput(input);

    expect(onAction).toHaveBeenCalledWith(action);
  });

  it("cancels a pending destructive action with escape", () => {
    const onAction = vi.fn();
    const requestRender = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction, requestRender);

    window.handleInput("x");
    window.handleInput("\u001b");

    expect(onAction).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(window.render(52).join("\n")).toContain("x clear");
  });

  it("ignores unavailable and unrelated actions", () => {
    const onAction = vi.fn();
    const window = new GoalWindow(goal, undefined, theme, onAction);

    window.handleInput("r");
    window.handleInput("z");

    expect(onAction).not.toHaveBeenCalled();
  });
});
