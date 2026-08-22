import { randomUUID } from "node:crypto";
import type {
  AgentGoal,
  GoalBudget,
  GoalContinuation,
  GoalContinuationClaim,
  GoalEvaluation,
  GoalEvaluator,
  GoalEvent,
  GoalEventSink,
  GoalPendingEvaluation,
  GoalProgress,
  GoalRetryPolicy,
  GoalStatus,
  GoalStorage,
  GoalTerminalCandidate,
  GoalTerminalCandidateRecord,
} from "./domain.js";

const DEFAULT_BUDGET: GoalBudget = { maxIterations: 25 };
const DEFAULT_RETRY_POLICY: GoalRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
};

export interface GoalRuntimeOptions {
  defaultBudget?: GoalBudget;
  retryPolicy?: GoalRetryPolicy;
  eventSink?: GoalEventSink;
  claimTtlMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
  evaluationInterval?: number;
}

export class GoalRuntime {
  private readonly evaluatingScopes = new Set<string>();
  private readonly latestSettlements = new Map<string, { id: string; progress: GoalProgress }>();
  private readonly budget: GoalBudget;
  private readonly retryPolicy: GoalRetryPolicy;
  private readonly eventSink?: GoalEventSink;
  private readonly claimTtlMs: number;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly evaluationInterval: number;

  constructor(
    private readonly storage: GoalStorage,
    private readonly evaluator: GoalEvaluator,
    private readonly continuation: GoalContinuation,
    private readonly now: () => Date = () => new Date(),
    options: GoalRuntimeOptions = {},
  ) {
    this.budget = options.defaultBudget ?? DEFAULT_BUDGET;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.eventSink = options.eventSink;
    this.claimTtlMs = options.claimTtlMs ?? 5 * 60_000;
    this.evaluationInterval = options.evaluationInterval ?? 0;
    if (!Number.isInteger(this.evaluationInterval) || this.evaluationInterval < 0) {
      throw new Error("Goal evaluationInterval must be a non-negative integer");
    }
    this.delay =
      options.delay ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    return this.storage.get(scopeId);
  }

  async getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined> {
    return this.storage.getContinuationClaim(scopeId);
  }

  async getTerminalCandidate(scopeId: string): Promise<GoalTerminalCandidateRecord | undefined> {
    return this.storage.getTerminalCandidate(scopeId);
  }

  async create(scopeId: string, objective: string, budget = this.budget): Promise<AgentGoal> {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) throw new Error("Goal objective cannot be empty");
    if (!Number.isInteger(budget.maxIterations) || budget.maxIterations <= 0) {
      throw new Error("Goal maxIterations must be a positive integer");
    }
    if (
      budget.maxTokens !== undefined &&
      (!Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0)
    ) {
      throw new Error("Goal maxTokens must be a positive finite number");
    }
    if (
      budget.maxRuntimeMs !== undefined &&
      (!Number.isFinite(budget.maxRuntimeMs) || budget.maxRuntimeMs <= 0)
    ) {
      throw new Error("Goal maxRuntimeMs must be a positive finite number");
    }
    if (await this.storage.get(scopeId)) {
      throw new Error("This session already has a goal; clear it before creating another");
    }

    const timestamp = this.now().toISOString();
    const goal: AgentGoal = {
      id: randomUUID(),
      scopeId,
      objective: trimmedObjective,
      status: "active",
      budget: { ...budget },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.storage.create(goal);
    await this.record({ type: "goal.created", goal });
    return goal;
  }

  async setStatus(
    scopeId: string,
    status: Extract<GoalStatus, "active" | "paused" | "complete">,
  ): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    const transitionAllowed =
      (status === "active" && (current.status === "paused" || current.status === "blocked")) ||
      (status === "paused" && current.status === "active") ||
      (status === "complete" && current.status !== "complete");
    if (!transitionAllowed) throw new Error(`Cannot change a ${current.status} goal to ${status}`);
    const next: AgentGoal = {
      ...current,
      status,
      blockedReason: undefined,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.replace(next, current.version))) {
      throw new Error("Goal changed while its status was being updated; retry the command");
    }
    const pending = await this.storage.getPendingEvaluation(scopeId);
    if (pending) await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
    const candidate = await this.storage.getTerminalCandidate(scopeId);
    if (candidate) await this.storage.deleteTerminalCandidate(scopeId, candidate.candidateId);
    const claim = await this.storage.getContinuationClaim(scopeId);
    if (claim) await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
    await this.record({ type: "goal.status_changed", goal: next, previousStatus: current.status });
    return next;
  }

  async clear(scopeId: string): Promise<boolean> {
    const current = await this.storage.get(scopeId);
    if (!current) return false;
    const deleted = await this.storage.delete(scopeId, current.version);
    if (deleted) await this.record({ type: "goal.cleared", goal: current });
    return deleted;
  }

  async requestTerminalCandidate(
    scopeId: string,
    candidate: GoalTerminalCandidate,
  ): Promise<GoalTerminalCandidateRecord> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status !== "active") {
      throw new Error(`Cannot request a terminal decision for a ${goal.status} goal`);
    }
    const reason = candidate.reason.trim();
    if (!reason) throw new Error("A terminal goal candidate requires a concrete reason");
    const record: GoalTerminalCandidateRecord = {
      ...candidate,
      reason,
      scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      candidateId: randomUUID(),
      createdAt: this.now().toISOString(),
    };
    if (!(await this.storage.putTerminalCandidate(record))) {
      throw new Error("Goal changed while its terminal candidate was being recorded; retry");
    }
    await this.record({ type: "goal.terminal_candidate_requested", goal, candidate: record });
    return record;
  }

  async start(scopeId: string, reason = "Begin working toward the new goal."): Promise<void> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status !== "active") throw new Error(`Cannot start a ${goal.status} goal`);
    if (this.budgetExhausted(goal)) {
      await this.markBudgetLimited(goal);
      return;
    }
    await this.continueWithClaim(goal, reason);
  }

  async acknowledgeContinuation(scopeId: string): Promise<void> {
    const claim = await this.storage.getContinuationClaim(scopeId);
    if (claim) await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
  }

  async recover(scopeId: string): Promise<void> {
    if (await this.storage.getPendingEvaluation(scopeId))
      await this.processPendingEvaluation(scopeId);
    const goal = await this.storage.get(scopeId);
    if (!goal || goal.status !== "active") return;
    if (this.budgetExhausted(goal)) {
      await this.markBudgetLimited(goal);
      return;
    }
    let claim = await this.storage.getContinuationClaim(scopeId);
    const now = this.now().getTime();
    if (claim && (claim.goalId !== goal.id || claim.goalVersion !== goal.version)) {
      await this.storage.deleteContinuationClaim(scopeId, claim.claimId);
      claim = undefined;
    }
    if (claim) {
      const claimIsLive = Date.parse(claim.expiresAt) > now;
      if (claimIsLive && claim.state !== "deferred") return;
      if (claimIsLive && Date.parse(claim.availableAt) > now) return;
      await this.record({ type: "goal.recovered", goal });
      await this.runContinuationClaim(goal, claim);
      return;
    }
    await this.record({ type: "goal.recovered", goal });
    await this.continueWithClaim(goal, "Resume the persisted active goal.");
  }

  async settle(scopeId: string, progress: GoalProgress): Promise<void> {
    const settlementId = randomUUID();
    this.latestSettlements.set(scopeId, { id: settlementId, progress });
    const ownsEvaluation = !this.evaluatingScopes.has(scopeId);
    if (ownsEvaluation) this.evaluatingScopes.add(scopeId);
    try {
      const goal = await this.storage.get(scopeId);
      if (!goal || goal.status !== "active") return;
      await this.acknowledgeContinuation(scopeId);
      const latest = this.latestSettlements.get(scopeId);
      if (!latest) return;
      let durableCandidate = await this.storage.getTerminalCandidate(scopeId);
      if (
        durableCandidate &&
        (durableCandidate.goalId !== goal.id || durableCandidate.goalVersion !== goal.version)
      ) {
        await this.storage.deleteTerminalCandidate(scopeId, durableCandidate.candidateId);
        durableCandidate = undefined;
      }
      const timestamp = this.now().toISOString();
      const pending: GoalPendingEvaluation = {
        scopeId,
        goalId: goal.id,
        goalVersion: goal.version,
        evaluationId: latest.id,
        progress: {
          ...latest.progress,
          tokenDelta: Math.max(0, latest.progress.tokenDelta ?? 0),
          terminalCandidate:
            latest.progress.terminalCandidate ??
            (durableCandidate
              ? { outcome: durableCandidate.outcome, reason: durableCandidate.reason }
              : undefined),
        },
        attempt: 0,
        availableAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      if (!(await this.storage.putPendingEvaluation(pending))) return;
      if (durableCandidate) {
        await this.storage.deleteTerminalCandidate(scopeId, durableCandidate.candidateId);
      }
      if (!ownsEvaluation) return;
      await this.processPendingEvaluation(scopeId, true);
    } finally {
      if (this.latestSettlements.get(scopeId)?.id === settlementId) {
        this.latestSettlements.delete(scopeId);
      }
      if (ownsEvaluation) {
        this.evaluatingScopes.delete(scopeId);
        if (await this.storage.getPendingEvaluation(scopeId)) {
          await this.processPendingEvaluation(scopeId);
        }
      }
    }
  }

  private async processPendingEvaluation(scopeId: string, ownsEvaluation = false): Promise<void> {
    if (!ownsEvaluation) {
      if (this.evaluatingScopes.has(scopeId)) return;
      this.evaluatingScopes.add(scopeId);
    }
    try {
      while (true) {
        const pending = await this.storage.getPendingEvaluation(scopeId);
        if (!pending) return;
        const goal = await this.storage.get(scopeId);
        if (!goal || goal.status !== "active") {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          return;
        }
        if (goal.lastEvaluation?.id === pending.evaluationId) {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          if (goal.lastEvaluation.outcome === "continue" && !this.budgetExhausted(goal)) {
            await this.continueWithClaim(goal, goal.lastEvaluation.reason);
          }
          continue;
        }
        if (goal.id !== pending.goalId || goal.version !== pending.goalVersion) {
          await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
          continue;
        }
        const waitMs = Date.parse(pending.availableAt) - this.now().getTime();
        if (waitMs > 0) await this.delay(waitMs);

        const accountedUsage = {
          iterations: goal.usage.iterations + 1,
          tokens: goal.usage.tokens + (pending.progress.tokenDelta ?? 0),
        };
        const projectedGoal: AgentGoal = { ...goal, usage: accountedUsage };
        const evaluatorRequired =
          pending.progress.terminalCandidate !== undefined ||
          this.budgetExhausted(projectedGoal) ||
          (this.evaluationInterval > 0 &&
            accountedUsage.iterations % this.evaluationInterval === 0);
        let evaluation: GoalEvaluation = {
          outcome: "continue",
          reason: "The worker stopped without requesting a terminal goal decision.",
        };
        try {
          if (evaluatorRequired) {
            evaluation = await this.evaluator.evaluate(goal, pending.progress);
          }
        } catch (error) {
          const latestPending = await this.storage.getPendingEvaluation(scopeId);
          if (!latestPending || latestPending.evaluationId !== pending.evaluationId) continue;
          const failure = error instanceof Error ? error : new Error(String(error));
          const attempt = pending.attempt + 1;
          if (attempt >= this.retryPolicy.maxAttempts) {
            await this.blockAfterRetryExhaustion(goal, "evaluator", failure, attempt, undefined);
            await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
            return;
          }
          const retryAt = new Date(this.now().getTime() + this.retryDelay(attempt)).toISOString();
          const retry: GoalPendingEvaluation = {
            ...pending,
            attempt,
            availableAt: retryAt,
            lastError: failure.message,
            updatedAt: this.now().toISOString(),
          };
          if (!(await this.storage.putPendingEvaluation(retry))) return;
          await this.record({
            type: "goal.retry_scheduled",
            scopeId,
            goalId: goal.id,
            operation: "evaluator",
            attempt,
            availableAt: retryAt,
            error: failure.message,
          });
          continue;
        }

        const latestPending = await this.storage.getPendingEvaluation(scopeId);
        if (!latestPending || latestPending.evaluationId !== pending.evaluationId) continue;
        const evaluatedAt = this.now().toISOString();
        const evaluated: AgentGoal = {
          ...goal,
          status: evaluation.outcome === "continue" ? "active" : evaluation.outcome,
          blockedReason: evaluation.outcome === "blocked" ? evaluation.reason : undefined,
          usage: accountedUsage,
          lastSettledAt: evaluatedAt,
          lastEvaluation: { id: pending.evaluationId, ...evaluation, at: evaluatedAt },
          version: goal.version + 1,
          updatedAt: evaluatedAt,
        };
        const next =
          evaluation.outcome === "continue" && this.budgetExhausted(evaluated)
            ? {
                ...evaluated,
                status: "budget_limited" as const,
                blockedReason: "Goal continuation budget exhausted",
              }
            : evaluated;
        if (!(await this.storage.replace(next, goal.version))) continue;
        await this.storage.deletePendingEvaluation(scopeId, pending.evaluationId);
        await this.record({
          type: "goal.progress_accounted",
          goal: next,
          tokenDelta: pending.progress.tokenDelta ?? 0,
        });
        if (evaluatorRequired) {
          await this.record({ type: "goal.evaluated", goal: next, evaluation });
        } else {
          await this.record({ type: "goal.auto_continued", goal: next });
        }
        if (next.status === "active") await this.continueWithClaim(next, evaluation.reason);
        else
          await this.record({
            type: "goal.status_changed",
            goal: next,
            previousStatus: goal.status,
          });
      }
    } finally {
      if (!ownsEvaluation) {
        this.evaluatingScopes.delete(scopeId);
        if (await this.storage.getPendingEvaluation(scopeId)) {
          await this.processPendingEvaluation(scopeId);
        }
      }
    }
  }

  private async continueWithClaim(goal: AgentGoal, reason: string): Promise<void> {
    const existingClaim = await this.storage.getContinuationClaim(goal.scopeId);
    if (existingClaim) {
      if (existingClaim.goalId === goal.id && existingClaim.goalVersion === goal.version) return;
      await this.storage.deleteContinuationClaim(goal.scopeId, existingClaim.claimId);
    }
    const timestamp = this.now().toISOString();
    const claim: GoalContinuationClaim = {
      scopeId: goal.scopeId,
      goalId: goal.id,
      goalVersion: goal.version,
      claimId: randomUUID(),
      state: "claimed",
      reason,
      attempt: 0,
      availableAt: timestamp,
      expiresAt: new Date(this.now().getTime() + this.claimTtlMs).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await this.storage.createContinuationClaim(claim))) return;
    await this.record({ type: "goal.continuation_claimed", goal, claim });
    await this.runContinuationClaim(goal, claim);
  }

  private async runContinuationClaim(goal: AgentGoal, claim: GoalContinuationClaim): Promise<void> {
    for (let attempt = claim.attempt + 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const currentGoal = await this.storage.get(goal.scopeId);
      const currentClaim = await this.storage.getContinuationClaim(goal.scopeId);
      if (
        !currentGoal ||
        currentGoal.id !== goal.id ||
        currentGoal.version !== goal.version ||
        currentGoal.status !== "active" ||
        currentClaim?.claimId !== claim.claimId
      ) {
        if (currentClaim?.claimId === claim.claimId) {
          await this.storage.deleteContinuationClaim(goal.scopeId, claim.claimId);
        }
        return;
      }
      const waitMs = Date.parse(claim.availableAt) - this.now().getTime();
      if (waitMs > 0) await this.delay(waitMs);
      claim.attempt = attempt;
      let result;
      try {
        result = await this.continuation.continueIfIdle(goal, {
          claimId: claim.claimId,
          idempotencyKey: `${goal.id}:${goal.version}`,
          expectedGoalVersion: goal.version,
          reason: claim.reason,
        });
      } catch (error) {
        result = {
          status: "unavailable" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.status === "started") {
        claim.state = "started";
        claim.lastError = undefined;
        claim.updatedAt = this.now().toISOString();
        if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
        await this.record({ type: "goal.continuation_started", goal, claim });
        return;
      }
      const retryDelay = result.retryAfterMs ?? this.retryDelay(attempt);
      claim.state = "deferred";
      claim.lastError = result.reason;
      claim.availableAt = new Date(this.now().getTime() + retryDelay).toISOString();
      claim.updatedAt = this.now().toISOString();
      if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
      if (result.status === "busy") {
        await this.record({ type: "goal.continuation_deferred", goal, claim });
        return;
      }
      if (attempt < this.retryPolicy.maxAttempts) {
        await this.record({
          type: "goal.retry_scheduled",
          scopeId: goal.scopeId,
          goalId: goal.id,
          operation: "continuation",
          attempt,
          availableAt: claim.availableAt,
          error: result.reason,
          claimId: claim.claimId,
        });
        await this.delay(retryDelay);
        claim.state = "claimed";
        claim.updatedAt = this.now().toISOString();
        if (!(await this.storage.replaceContinuationClaim(claim, claim.claimId))) return;
      }
    }
    await this.blockAfterRetryExhaustion(
      goal,
      "continuation",
      new Error(claim.lastError ?? "Continuation unavailable"),
      claim.attempt,
      claim.claimId,
    );
  }

  private async blockAfterRetryExhaustion(
    goal: AgentGoal,
    operation: "evaluator" | "continuation",
    error: Error,
    attempt: number,
    claimId: string | undefined,
  ): Promise<void> {
    const current = await this.storage.get(goal.scopeId);
    if (
      !current ||
      current.id !== goal.id ||
      current.version !== goal.version ||
      current.status !== "active"
    ) {
      return;
    }
    if (claimId) {
      const claim = await this.storage.getContinuationClaim(goal.scopeId);
      if (claim?.claimId !== claimId) return;
    }
    const next: AgentGoal = {
      ...current,
      status: "blocked",
      blockedReason: `${operation} failed after ${attempt} attempts: ${error.message}`,
      version: current.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (!(await this.storage.replace(next, current.version))) return;
    if (claimId) await this.storage.deleteContinuationClaim(goal.scopeId, claimId);
    await this.record({
      type: "goal.retry_exhausted",
      scopeId: goal.scopeId,
      goalId: goal.id,
      operation,
      attempt,
      error: error.message,
      claimId,
    });
    await this.record({ type: "goal.status_changed", goal: next, previousStatus: current.status });
  }

  private budgetExhausted(goal: AgentGoal): boolean {
    return (
      goal.usage.iterations >= goal.budget.maxIterations ||
      (goal.budget.maxTokens !== undefined && goal.usage.tokens >= goal.budget.maxTokens) ||
      (goal.budget.maxRuntimeMs !== undefined &&
        this.now().getTime() - Date.parse(goal.createdAt) >= goal.budget.maxRuntimeMs)
    );
  }

  private async markBudgetLimited(goal: AgentGoal): Promise<void> {
    const next: AgentGoal = {
      ...goal,
      status: "budget_limited",
      blockedReason: "Goal continuation budget exhausted",
      version: goal.version + 1,
      updatedAt: this.now().toISOString(),
    };
    if (await this.storage.replace(next, goal.version)) {
      await this.record({ type: "goal.status_changed", goal: next, previousStatus: goal.status });
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryPolicy.baseDelayMs * 2 ** (attempt - 1), this.retryPolicy.maxDelayMs);
  }

  private async record(event: GoalEvent): Promise<void> {
    try {
      await this.eventSink?.record(event);
    } catch {
      // Event sinks are observational and must not own goal lifecycle progress.
    }
  }

  private async requireGoal(scopeId: string): Promise<AgentGoal> {
    const goal = await this.storage.get(scopeId);
    if (!goal) throw new Error("This session has no goal");
    return goal;
  }
}
