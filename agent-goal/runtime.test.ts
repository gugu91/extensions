import { describe, expect, it, vi } from "vitest";
import type { GoalContinuation, GoalEvaluator } from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { GoalRuntime } from "./runtime.js";

describe("GoalRuntime", () => {
  it("creates one active goal per scope", async () => {
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(
      storage,
      { evaluate: vi.fn() },
      { continue: vi.fn() },
      () => new Date("2026-01-01T00:00:00.000Z"),
    );

    const goal = await runtime.create("session-1", "  ship the feature  ");

    expect(goal).toMatchObject({
      scopeId: "session-1",
      objective: "ship the feature",
      status: "active",
      version: 1,
    });
    await expect(runtime.create("session-1", "another goal")).rejects.toThrow("already has a goal");
  });

  it("continues an unmet goal", async () => {
    const continuation = {
      continue: vi.fn().mockResolvedValue("started"),
    } satisfies GoalContinuation;
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      {
        evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "tests remain" }),
      },
      continuation,
    );
    const goal = await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "implementation done" });

    expect(continuation.continue).toHaveBeenCalledWith(goal, "tests remain");
    expect((await runtime.get("session-1"))?.status).toBe("active");
  });

  it.each(["complete", "blocked"] as const)(
    "persists a %s evaluation without continuing",
    async (outcome) => {
      const continuation = { continue: vi.fn() } satisfies GoalContinuation;
      const runtime = new GoalRuntime(
        new MemoryGoalStorage(),
        { evaluate: vi.fn().mockResolvedValue({ outcome, reason: "evaluation reason" }) },
        continuation,
      );
      await runtime.create("session-1", "ship");

      await runtime.settle("session-1", { latestOutput: "done" });

      expect(await runtime.get("session-1")).toMatchObject({
        status: outcome,
        version: 2,
        ...(outcome === "blocked" ? { blockedReason: "evaluation reason" } : {}),
      });
      expect(continuation.continue).not.toHaveBeenCalled();
    },
  );

  it("enforces status transitions", async () => {
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      {
        continue: vi.fn(),
      },
    );
    await runtime.create("session-1", "ship");

    await expect(runtime.setStatus("session-1", "active")).resolves.toMatchObject({ version: 1 });
    await runtime.setStatus("session-1", "complete");
    await expect(runtime.setStatus("session-1", "active")).rejects.toThrow(
      "Cannot change a complete goal to active",
    );
  });

  it("does not evaluate paused or terminal goals", async () => {
    const evaluator = { evaluate: vi.fn() } satisfies GoalEvaluator;
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, { continue: vi.fn() });
    await runtime.create("paused", "ship");
    await runtime.setStatus("paused", "paused");
    await runtime.create("complete", "ship");
    await runtime.setStatus("complete", "complete");

    await runtime.settle("paused", { latestOutput: "ignored" });
    await runtime.settle("complete", { latestOutput: "ignored" });

    expect(evaluator.evaluate).not.toHaveBeenCalled();
  });

  it("prevents duplicate evaluations for the same scope", async () => {
    let resolveEvaluation: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const evaluator: GoalEvaluator = {
      evaluate: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveEvaluation = resolve;
        }),
      ),
    };
    const continuation = {
      continue: vi.fn().mockResolvedValue("started"),
    } satisfies GoalContinuation;
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    const first = runtime.settle("session-1", { latestOutput: "first" });
    await runtime.settle("session-1", { latestOutput: "duplicate" });
    resolveEvaluation?.({ outcome: "continue", reason: "keep going" });
    await first;

    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(continuation.continue).toHaveBeenCalledOnce();
  });

  it("discards stale evaluator results", async () => {
    let resolveEvaluation: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      {
        evaluate: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            resolveEvaluation = resolve;
          }),
        ),
      },
      { continue: vi.fn() },
    );
    await runtime.create("session-1", "ship");

    const settlement = runtime.settle("session-1", { latestOutput: "working" });
    await runtime.setStatus("session-1", "paused");
    resolveEvaluation?.({ outcome: "continue", reason: "stale" });
    await settlement;

    expect((await runtime.get("session-1"))?.status).toBe("paused");
  });
});
