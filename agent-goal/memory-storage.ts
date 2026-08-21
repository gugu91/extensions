import type { AgentGoal, GoalStorage } from "./domain.js";

export class MemoryGoalStorage implements GoalStorage {
  private readonly goals = new Map<string, AgentGoal>();

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    const goal = this.goals.get(scopeId);
    return goal ? { ...goal } : undefined;
  }

  async create(goal: AgentGoal): Promise<void> {
    if (this.goals.has(goal.scopeId)) throw new Error("Goal already exists for this scope");
    this.goals.set(goal.scopeId, { ...goal });
  }

  async replace(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    const current = this.goals.get(goal.scopeId);
    if (!current || current.version !== expectedVersion || current.id !== goal.id) return false;
    this.goals.set(goal.scopeId, { ...goal });
    return true;
  }

  async delete(scopeId: string, expectedVersion: number): Promise<boolean> {
    const current = this.goals.get(scopeId);
    if (!current || current.version !== expectedVersion) return false;
    return this.goals.delete(scopeId);
  }

  close(): void {}
}
