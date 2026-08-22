export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";

export interface GoalBudget {
  maxIterations: number;
  maxTokens?: number;
  maxRuntimeMs?: number;
}

export interface GoalUsage {
  iterations: number;
  tokens: number;
}

export interface GoalEvaluationRecord {
  id: string;
  outcome: GoalEvaluation["outcome"];
  reason: string;
  at: string;
}

export interface AgentGoal {
  id: string;
  scopeId: string;
  objective: string;
  status: GoalStatus;
  blockedReason?: string;
  budget: GoalBudget;
  usage: GoalUsage;
  lastSettledAt?: string;
  lastEvaluation?: GoalEvaluationRecord;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type GoalEvaluation =
  | { outcome: "continue"; reason: string }
  | { outcome: "complete"; reason: string }
  | { outcome: "blocked"; reason: string };

export interface GoalTerminalCandidate {
  outcome: "complete" | "blocked";
  reason: string;
}

export interface GoalTerminalCandidateRecord extends GoalTerminalCandidate {
  scopeId: string;
  goalId: string;
  goalVersion: number;
  candidateId: string;
  createdAt: string;
}

export interface GoalProgress {
  latestOutput: string;
  tokenDelta?: number;
  terminalCandidate?: GoalTerminalCandidate;
}

export type GoalContinuationClaimState = "claimed" | "deferred" | "started";

export interface GoalPendingEvaluation {
  scopeId: string;
  goalId: string;
  goalVersion: number;
  evaluationId: string;
  progress: GoalProgress;
  attempt: number;
  availableAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalContinuationClaim {
  scopeId: string;
  goalId: string;
  goalVersion: number;
  claimId: string;
  state: GoalContinuationClaimState;
  reason: string;
  attempt: number;
  availableAt: string;
  expiresAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalStorage {
  get(scopeId: string): Promise<AgentGoal | undefined>;
  create(goal: AgentGoal): Promise<void>;
  replace(goal: AgentGoal, expectedVersion: number): Promise<boolean>;
  delete(scopeId: string, expectedVersion: number): Promise<boolean>;
  getPendingEvaluation(scopeId: string): Promise<GoalPendingEvaluation | undefined>;
  putPendingEvaluation(pending: GoalPendingEvaluation): Promise<boolean>;
  deletePendingEvaluation(scopeId: string, expectedEvaluationId: string): Promise<boolean>;
  getTerminalCandidate(scopeId: string): Promise<GoalTerminalCandidateRecord | undefined>;
  putTerminalCandidate(candidate: GoalTerminalCandidateRecord): Promise<boolean>;
  deleteTerminalCandidate(scopeId: string, expectedCandidateId: string): Promise<boolean>;
  getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined>;
  createContinuationClaim(claim: GoalContinuationClaim): Promise<boolean>;
  replaceContinuationClaim(claim: GoalContinuationClaim, expectedClaimId: string): Promise<boolean>;
  deleteContinuationClaim(scopeId: string, expectedClaimId: string): Promise<boolean>;
  close(): void;
}

export interface GoalEvaluator {
  evaluate(goal: AgentGoal, progress: GoalProgress): Promise<GoalEvaluation>;
}

export type GoalContinuationResult =
  | { status: "started"; continuationId?: string }
  | { status: "busy" | "unavailable" | "rejected"; reason: string; retryAfterMs?: number };

export interface GoalContinuationRequest {
  claimId: string;
  idempotencyKey: string;
  expectedGoalVersion: number;
  reason: string;
}

export interface GoalContinuation {
  continueIfIdle(
    goal: AgentGoal,
    request: GoalContinuationRequest,
  ): Promise<GoalContinuationResult>;
}

export interface GoalRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type GoalEvent =
  | { type: "goal.created"; goal: AgentGoal }
  | { type: "goal.status_changed"; goal: AgentGoal; previousStatus: GoalStatus }
  | { type: "goal.progress_accounted"; goal: AgentGoal; tokenDelta: number }
  | { type: "goal.evaluated"; goal: AgentGoal; evaluation: GoalEvaluation }
  | { type: "goal.auto_continued"; goal: AgentGoal }
  | {
      type: "goal.terminal_candidate_requested";
      goal: AgentGoal;
      candidate: GoalTerminalCandidateRecord;
    }
  | { type: "goal.continuation_claimed"; goal: AgentGoal; claim: GoalContinuationClaim }
  | { type: "goal.continuation_started"; goal: AgentGoal; claim: GoalContinuationClaim }
  | { type: "goal.continuation_deferred"; goal: AgentGoal; claim: GoalContinuationClaim }
  | {
      type: "goal.retry_scheduled";
      scopeId: string;
      goalId: string;
      operation: "evaluator" | "continuation";
      attempt: number;
      availableAt: string;
      error: string;
      claimId?: string;
    }
  | {
      type: "goal.retry_exhausted";
      scopeId: string;
      goalId: string;
      operation: "evaluator" | "continuation";
      attempt: number;
      error: string;
      claimId?: string;
    }
  | { type: "goal.recovered"; goal: AgentGoal }
  | { type: "goal.cleared"; goal: AgentGoal }
  | { type: "goal.error"; operation: string; error: string };

export interface GoalEventSink {
  record(event: GoalEvent): Promise<void> | void;
}
