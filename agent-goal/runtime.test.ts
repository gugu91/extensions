import { describe, expect, it, vi } from "vitest";
import type {
  AgentGoal,
  GoalContinuation,
  GoalEvaluator,
  GoalEvent,
  GoalWakeScheduler,
} from "./domain.js";
import { MemoryGoalStorage } from "./memory-storage.js";
import { GoalRuntime } from "./runtime.js";

const startedContinuation = (): GoalContinuation => ({
  continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }),
});

describe("GoalRuntime", () => {
  it("creates one bounded active goal per scope", async () => {
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
      () => new Date("2026-01-01T00:00:00.000Z"),
      { defaultBudget: { maxIterations: 8, maxTokens: 50_000 } },
    );

    const goal = await runtime.create("session-1", "  ship the feature  ");

    expect(goal).toMatchObject({
      scopeId: "session-1",
      objective: "ship the feature",
      status: "active",
      budget: { maxIterations: 8, maxTokens: 50_000 },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
    });
    await expect(runtime.create("session-1", "another goal")).rejects.toThrow("already has a goal");
    await expect(
      runtime.create("invalid-token-budget", "ship", {
        maxIterations: 1,
        maxTokens: Number.NaN,
      }),
    ).rejects.toThrow("maxTokens");
    await expect(
      runtime.create("invalid-runtime-budget", "ship", {
        maxIterations: 1,
        maxRuntimeMs: -1,
      }),
    ).rejects.toThrow("maxRuntimeMs");
  });

  it("evaluates ordinary settled progress and continues when work remains", async () => {
    const continuation = startedContinuation();
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "tests remain" }),
    };
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "implementation done", tokenDelta: 120 });

    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
    expect(await runtime.get("session-1")).toMatchObject({
      status: "active",
      usage: { iterations: 1, tokens: 120 },
      lastEvaluation: { outcome: "continue", reason: "tests remain" },
      version: 2,
    });
    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { iterations: 1, tokens: 120 } }),
      expect.objectContaining({ latestOutput: "implementation done", tokenDelta: 120 }),
    );
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({ state: "started" });
    await runtime.recover("session-1");
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("continues when independent evaluation rejects a terminal claim", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "tests are missing" }),
    } satisfies GoalEvaluator;
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", {
      latestOutput: "I think this is done",
      terminalCandidate: { outcome: "complete", reason: "implementation exists" },
    });

    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(await runtime.get("session-1")).toMatchObject({ status: "active" });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("evaluates every settlement regardless of the legacy checkpoint interval", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "checkpoint passed" }),
    } satisfies GoalEvaluator;
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      { evaluationInterval: 2 },
    );
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "turn one" });
    await runtime.acknowledgeContinuation("session-1");
    await runtime.settle("session-1", { latestOutput: "turn two" });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(["complete", "blocked"] as const)(
    "persists a %s evaluation without continuing",
    async (outcome) => {
      const continuation = startedContinuation();
      const runtime = new GoalRuntime(
        new MemoryGoalStorage(),
        { evaluate: vi.fn().mockResolvedValue({ outcome, reason: "evaluation reason" }) },
        continuation,
      );
      await runtime.create("session-1", "ship");

      await runtime.settle("session-1", {
        latestOutput: "done",
        terminalCandidate: { outcome, reason: "worker evidence" },
      });

      expect(await runtime.get("session-1")).toMatchObject({
        status: outcome,
        version: 2,
        ...(outcome === "blocked" ? { blockedReason: "evaluation reason" } : {}),
      });
      expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    },
  );

  it("evaluates the final allowed iteration but prevents another continuation", async () => {
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "continue", reason: "more work" }),
    } satisfies GoalEvaluator;
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation, undefined, {
      defaultBudget: { maxIterations: 1 },
    });
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", { latestOutput: "first turn" });

    expect(await runtime.get("session-1")).toMatchObject({
      status: "budget_limited",
      usage: { iterations: 1 },
    });
    expect(evaluator.evaluate).toHaveBeenCalledOnce();
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
  });

  it("re-evaluates the latest progress instead of applying an older result", async () => {
    let evaluationStarted: (() => void) | undefined;
    let resolveEvaluation: ((value: { outcome: "continue"; reason: string }) => void) | undefined;
    const started = new Promise<void>((resolve) => {
      evaluationStarted = resolve;
    });
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveEvaluation = resolve;
              evaluationStarted?.();
            }),
        )
        .mockResolvedValueOnce({ outcome: "complete", reason: "latest turn completed the goal" }),
    };
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(new MemoryGoalStorage(), evaluator, continuation);
    await runtime.create("session-1", "ship");

    const first = runtime.settle("session-1", {
      latestOutput: "first turn",
      tokenDelta: 10,
      terminalCandidate: { outcome: "complete", reason: "first claim" },
    });
    await started;
    await runtime.settle("session-1", {
      latestOutput: "latest completed turn",
      tokenDelta: 20,
      terminalCandidate: { outcome: "complete", reason: "latest claim" },
    });
    resolveEvaluation?.({ outcome: "continue", reason: "stale result" });
    await first;

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 30 },
    });
  });

  it("does not let stale evaluator exhaustion block newer pending work", async () => {
    let signalCommitStarted: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      signalCommitStarted = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    class PausingStorage extends MemoryGoalStorage {
      private pauseNextCommit = true;

      override async commitEvaluation(
        goal: AgentGoal,
        expectedGoalVersion: number,
        expectedEvaluationId: string,
      ): Promise<boolean> {
        if (this.pauseNextCommit) {
          this.pauseNextCommit = false;
          signalCommitStarted?.();
          await commitRelease;
        }
        return super.commitEvaluation(goal, expectedGoalVersion, expectedEvaluationId);
      }
    }
    const evaluator: GoalEvaluator = {
      evaluate: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce({ outcome: "complete", reason: "newer turn verified" }),
    };
    const runtime = new GoalRuntime(
      new PausingStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      { retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
    );
    await runtime.create("session-1", "ship");

    const first = runtime.settle("session-1", {
      latestOutput: "first claim",
      tokenDelta: 10,
      terminalCandidate: { outcome: "complete", reason: "first claim" },
    });
    await commitStarted;
    await runtime.settle("session-1", {
      latestOutput: "newer verified work",
      tokenDelta: 20,
      terminalCandidate: { outcome: "complete", reason: "newer claim" },
    });
    releaseCommit?.();
    await first;

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 2, tokens: 30 },
    });
  });

  it("persists a terminal candidate until settled evaluation consumes it", async () => {
    const storage = new MemoryGoalStorage();
    const first = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    await first.create("session-1", "ship");
    await first.requestTerminalCandidate("session-1", {
      outcome: "complete",
      reason: "all acceptance checks pass",
    });
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }),
    } satisfies GoalEvaluator;
    const recovered = new GoalRuntime(storage, evaluator, startedContinuation());

    await recovered.settle("session-1", { latestOutput: "verified output" });

    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({
        terminalCandidate: {
          outcome: "complete",
          reason: "all acceptance checks pass",
        },
      }),
    );
    expect(await storage.getTerminalCandidate("session-1")).toBeUndefined();
    expect(await recovered.get("session-1")).toMatchObject({ status: "complete" });
  });

  it("recovers a durable pending evaluation before continuing", async () => {
    const storage = new MemoryGoalStorage();
    const first = new GoalRuntime(storage, { evaluate: vi.fn() }, startedContinuation());
    const goal = await first.create("session-1", "ship");
    await storage.putPendingEvaluation({
      scopeId: goal.scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      evaluationId: "evaluation-1",
      iterationsDelta: 1,
      progress: {
        latestOutput: "completed",
        tokenDelta: 50,
        terminalCandidate: { outcome: "complete", reason: "verified locally" },
      },
      attempt: 1,
      availableAt: goal.createdAt,
      lastError: "temporary failure",
      createdAt: goal.createdAt,
      updatedAt: goal.createdAt,
    });
    const continuation = startedContinuation();
    const recovered = new GoalRuntime(
      storage,
      { evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }) },
      continuation,
    );

    await recovered.recover("session-1");

    expect(await recovered.get("session-1")).toMatchObject({
      status: "complete",
      usage: { iterations: 1, tokens: 50 },
      lastEvaluation: { id: "evaluation-1", outcome: "complete" },
    });
    expect(continuation.continueIfIdle).not.toHaveBeenCalled();
    expect(await storage.getPendingEvaluation("session-1")).toBeUndefined();
  });

  it("retries evaluator failures and blocks after bounded exhaustion", async () => {
    const events: GoalEvent[] = [];
    const evaluator = { evaluate: vi.fn().mockRejectedValue(new Error("offline")) };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      evaluator,
      startedContinuation(),
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: vi.fn().mockResolvedValue(undefined),
        eventSink: { record: (event) => void events.push(event) },
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.settle("session-1", {
      latestOutput: "work",
      terminalCandidate: { outcome: "complete", reason: "claimed done" },
    });

    expect(evaluator.evaluate).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "blocked",
      blockedReason: "evaluator failed after 2 attempts: offline",
    });
    expect(events.some(({ type }) => type === "goal.retry_exhausted")).toBe(true);
  });

  it("retries continuation failures and blocks after bounded exhaustion", async () => {
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({ status: "unavailable", reason: "offline" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: vi.fn().mockResolvedValue(undefined),
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");

    expect(continuation.continueIfIdle).toHaveBeenCalledTimes(2);
    expect(await runtime.get("session-1")).toMatchObject({
      status: "blocked",
      blockedReason: "continuation failed after 2 attempts: offline",
    });
    expect(await runtime.getContinuationClaim("session-1")).toBeUndefined();
  });

  it("removes a stale claim before continuing a newer active goal version", async () => {
    const storage = new MemoryGoalStorage();
    const continuation = startedContinuation();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation);
    const goal = await runtime.create("session-1", "ship");
    expect(
      await storage.createContinuationClaim({
        scopeId: goal.scopeId,
        goalId: goal.id,
        goalVersion: goal.version,
        claimId: "stale-claim",
        state: "started",
        reason: "old version",
        attempt: 1,
        availableAt: goal.createdAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
      }),
    ).toBe(true);
    expect(
      await storage.replace(
        { ...goal, version: 2, updatedAt: "2026-01-01T00:01:00.000Z" },
        goal.version,
      ),
    ).toBe(true);

    await runtime.start("session-1");

    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      goalVersion: 2,
      state: "started",
    });
  });

  it("does not let stale continuation retry exhaustion block a newer goal version", async () => {
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({ status: "unavailable", reason: "offline" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      undefined,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        delay: async () => {
          await runtime.setStatus("session-1", "paused");
        },
      },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");

    expect(await runtime.get("session-1")).toMatchObject({ status: "paused", version: 2 });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
  });

  it("automatically wakes a busy continuation when its deferral is due", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let wake: (() => void) | undefined;
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => {
        wake = callback;
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi
        .fn()
        .mockResolvedValueOnce({ status: "busy", reason: "user turn", retryAfterMs: 100 })
        .mockResolvedValueOnce({ status: "started" }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      { wakeScheduler },
    );
    await runtime.create("session-1", "ship");

    await runtime.start("session-1");
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({ state: "deferred" });
    expect(wakeScheduler.schedule).toHaveBeenCalledWith(
      "session-1",
      "2026-01-01T00:00:00.100Z",
      expect.any(Function),
    );

    now = new Date("2026-01-01T00:00:00.101Z");
    wake?.();
    await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(2));
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      state: "started",
      attempt: 1,
    });
  });

  it("does not exhaust continuation retries while the goal session stays busy", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    let wake: (() => void) | undefined;
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn((_scopeId, _wakeAt, callback) => {
        wake = callback;
      }),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockResolvedValue({
        status: "busy",
        reason: "settlement callback still owns the session",
        retryAfterMs: 100,
      }),
    };
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      continuation,
      () => now,
      {
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
        wakeScheduler,
      },
    );
    await runtime.create("session-1", "ship");
    await runtime.start("session-1");

    for (let index = 0; index < 4; index += 1) {
      now = new Date(now.getTime() + 101);
      wake?.();
      await vi.waitFor(() => expect(continuation.continueIfIdle).toHaveBeenCalledTimes(index + 2));
    }

    expect(await runtime.get("session-1")).toMatchObject({ status: "active" });
    expect(await runtime.getContinuationClaim("session-1")).toMatchObject({
      state: "deferred",
      attempt: 0,
    });
  });

  it("does not schedule a wake after shutdown races an in-flight continuation", async () => {
    let signalContinuationStarted: (() => void) | undefined;
    let resolveContinuation:
      | ((result: { status: "busy"; reason: string; retryAfterMs: number }) => void)
      | undefined;
    const continuationStarted = new Promise<void>((resolve) => {
      signalContinuationStarted = resolve;
    });
    const wakeScheduler: GoalWakeScheduler = {
      schedule: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    const continuation: GoalContinuation = {
      continueIfIdle: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveContinuation = resolve;
            signalContinuationStarted?.();
          }),
      ),
    };
    const storage = new MemoryGoalStorage();
    const runtime = new GoalRuntime(storage, { evaluate: vi.fn() }, continuation, undefined, {
      wakeScheduler,
    });
    await runtime.create("session-1", "ship");

    const start = runtime.start("session-1");
    await continuationStarted;
    runtime.close(false);
    resolveContinuation?.({ status: "busy", reason: "user turn", retryAfterMs: 100 });
    await start;

    expect(wakeScheduler.close).toHaveBeenCalledOnce();
    expect(wakeScheduler.schedule).not.toHaveBeenCalled();
  });

  it("enforces status transitions and clears continuation claims", async () => {
    const runtime = new GoalRuntime(
      new MemoryGoalStorage(),
      { evaluate: vi.fn() },
      startedContinuation(),
    );
    await runtime.create("session-1", "ship");
    await runtime.start("session-1");

    await expect(runtime.setStatus("session-1", "active")).rejects.toThrow(
      "Cannot change a active goal to active",
    );
    await runtime.setStatus("session-1", "complete");
    expect(await runtime.getContinuationClaim("session-1")).toBeUndefined();
    await expect(runtime.setStatus("session-1", "active")).rejects.toThrow(
      "Cannot change a complete goal to active",
    );
  });
});
