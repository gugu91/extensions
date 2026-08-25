import { describe, expect, it } from "vitest";
import type { AgentGoal } from "./domain.js";
import { formatGoalDashboard, formatGoalStatus } from "./dashboard.js";

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  objective: "Ship the standalone goal loop",
  status: "active",
  budget: { maxIterations: 8, maxTokens: 50_000, maxRuntimeMs: 3_600_000 },
  usage: { iterations: 3, tokens: 12_430 },
  lastEvaluation: {
    id: "evaluation-1",
    outcome: "continue",
    reason: "tests remain",
    at: "2026-01-01T00:00:00.000Z",
  },
  version: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("goal dashboard", () => {
  it("formats compact footer and detailed headless state", () => {
    expect(formatGoalStatus(goal)).toBe("goal: active · 3/8 turns · 12430/50000 tok");
    expect(formatGoalDashboard(goal)).toEqual([
      "Goal · active · v4",
      "Ship the standalone goal loop",
      "Turns 3/8 · Tokens 12430/50000 · Runtime limit 60m",
      "Last CONTINUE: tests remain",
      "/goal budget turns=<n> tokens=<n> · pause · resume · complete · clear · hide",
    ]);
  });
});
