import { randomUUID } from "node:crypto";
import type {
  AgentGoal,
  GoalContinuation,
  GoalEvaluator,
  GoalProgress,
  GoalStatus,
  GoalStorage,
} from "./domain.js";

export class GoalRuntime {
  private readonly evaluatingScopes = new Set<string>();

  constructor(
    private readonly storage: GoalStorage,
    private readonly evaluator: GoalEvaluator,
    private readonly continuation: GoalContinuation,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    return this.storage.get(scopeId);
  }

  async create(scopeId: string, objective: string): Promise<AgentGoal> {
    const trimmedObjective = objective.trim();
    if (!trimmedObjective) throw new Error("Goal objective cannot be empty");
    if (await this.storage.get(scopeId)) {
      throw new Error("This session already has a goal; clear it before creating another");
    }

    const timestamp = this.now().toISOString();
    const goal: AgentGoal = {
      id: randomUUID(),
      scopeId,
      objective: trimmedObjective,
      status: "active",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.storage.create(goal);
    return goal;
  }

  async setStatus(
    scopeId: string,
    status: Extract<GoalStatus, "active" | "paused" | "complete">,
  ): Promise<AgentGoal> {
    const current = await this.requireGoal(scopeId);
    if (current.status === status) return current;
    const transitionAllowed =
      (status === "active" && (current.status === "paused" || current.status === "blocked")) ||
      (status === "paused" && current.status === "active") ||
      (status === "complete" && current.status !== "complete");
    if (!transitionAllowed) {
      throw new Error(`Cannot change a ${current.status} goal to ${status}`);
    }
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
    return next;
  }

  async clear(scopeId: string): Promise<boolean> {
    const current = await this.storage.get(scopeId);
    if (!current) return false;
    return this.storage.delete(scopeId, current.version);
  }

  async start(scopeId: string, reason = "Begin working toward the new goal."): Promise<void> {
    const goal = await this.requireGoal(scopeId);
    if (goal.status !== "active") throw new Error(`Cannot start a ${goal.status} goal`);
    await this.continuation.continue(goal, reason);
  }

  async settle(scopeId: string, progress: GoalProgress): Promise<void> {
    if (this.evaluatingScopes.has(scopeId)) return;
    this.evaluatingScopes.add(scopeId);
    try {
      const goal = await this.storage.get(scopeId);
      if (!goal || goal.status !== "active") return;

      const evaluation = await this.evaluator.evaluate(goal, progress);
      const current = await this.storage.get(scopeId);
      if (!current || current.id !== goal.id || current.version !== goal.version) return;

      if (evaluation.outcome === "continue") {
        await this.continuation.continue(current, evaluation.reason);
        return;
      }

      const next: AgentGoal = {
        ...current,
        status: evaluation.outcome,
        blockedReason: evaluation.outcome === "blocked" ? evaluation.reason : undefined,
        version: current.version + 1,
        updatedAt: this.now().toISOString(),
      };
      await this.storage.replace(next, current.version);
    } finally {
      this.evaluatingScopes.delete(scopeId);
    }
  }

  private async requireGoal(scopeId: string): Promise<AgentGoal> {
    const goal = await this.storage.get(scopeId);
    if (!goal) throw new Error("This session has no goal");
    return goal;
  }
}
