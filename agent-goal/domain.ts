export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface AgentGoal {
  id: string;
  scopeId: string;
  objective: string;
  status: GoalStatus;
  blockedReason?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type GoalEvaluation =
  | { outcome: "continue"; reason: string }
  | { outcome: "complete"; reason: string }
  | { outcome: "blocked"; reason: string };

export interface GoalProgress {
  latestOutput: string;
}

export interface GoalStorage {
  get(scopeId: string): Promise<AgentGoal | undefined>;
  create(goal: AgentGoal): Promise<void>;
  replace(goal: AgentGoal, expectedVersion: number): Promise<boolean>;
  delete(scopeId: string, expectedVersion: number): Promise<boolean>;
  close(): void;
}

export interface GoalEvaluator {
  evaluate(goal: AgentGoal, progress: GoalProgress): Promise<GoalEvaluation>;
}

export type GoalContinuationResult = "started" | "busy" | "unavailable";

export interface GoalContinuation {
  continue(goal: AgentGoal, reason: string): Promise<GoalContinuationResult>;
}
