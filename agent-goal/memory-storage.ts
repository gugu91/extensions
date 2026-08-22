import type {
  AgentGoal,
  GoalContinuationClaim,
  GoalPendingEvaluation,
  GoalStorage,
  GoalTerminalCandidateRecord,
} from "./domain.js";

function cloneGoal(goal: AgentGoal): AgentGoal {
  return {
    ...goal,
    budget: { ...goal.budget },
    usage: { ...goal.usage },
    lastEvaluation: goal.lastEvaluation ? { ...goal.lastEvaluation } : undefined,
  };
}

export class MemoryGoalStorage implements GoalStorage {
  private readonly goals = new Map<string, AgentGoal>();
  private readonly pendingEvaluations = new Map<string, GoalPendingEvaluation>();
  private readonly terminalCandidates = new Map<string, GoalTerminalCandidateRecord>();
  private readonly claims = new Map<string, GoalContinuationClaim>();

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    const goal = this.goals.get(scopeId);
    return goal ? cloneGoal(goal) : undefined;
  }

  async create(goal: AgentGoal): Promise<void> {
    if (this.goals.has(goal.scopeId)) throw new Error("Goal already exists for this scope");
    this.goals.set(goal.scopeId, cloneGoal(goal));
  }

  async replace(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    const current = this.goals.get(goal.scopeId);
    if (!current || current.version !== expectedVersion || current.id !== goal.id) return false;
    this.goals.set(goal.scopeId, cloneGoal(goal));
    return true;
  }

  async delete(scopeId: string, expectedVersion: number): Promise<boolean> {
    const current = this.goals.get(scopeId);
    if (!current || current.version !== expectedVersion) return false;
    this.pendingEvaluations.delete(scopeId);
    this.terminalCandidates.delete(scopeId);
    this.claims.delete(scopeId);
    return this.goals.delete(scopeId);
  }

  async getPendingEvaluation(scopeId: string): Promise<GoalPendingEvaluation | undefined> {
    const pending = this.pendingEvaluations.get(scopeId);
    return pending
      ? {
          ...pending,
          progress: {
            ...pending.progress,
            terminalCandidate: pending.progress.terminalCandidate
              ? { ...pending.progress.terminalCandidate }
              : undefined,
          },
        }
      : undefined;
  }

  async putPendingEvaluation(pending: GoalPendingEvaluation): Promise<boolean> {
    const goal = this.goals.get(pending.scopeId);
    if (!goal || goal.id !== pending.goalId || goal.version !== pending.goalVersion) return false;
    this.pendingEvaluations.set(pending.scopeId, {
      ...pending,
      progress: {
        ...pending.progress,
        terminalCandidate: pending.progress.terminalCandidate
          ? { ...pending.progress.terminalCandidate }
          : undefined,
      },
    });
    return true;
  }

  async deletePendingEvaluation(scopeId: string, expectedEvaluationId: string): Promise<boolean> {
    const pending = this.pendingEvaluations.get(scopeId);
    if (!pending || pending.evaluationId !== expectedEvaluationId) return false;
    return this.pendingEvaluations.delete(scopeId);
  }

  async getTerminalCandidate(scopeId: string): Promise<GoalTerminalCandidateRecord | undefined> {
    const candidate = this.terminalCandidates.get(scopeId);
    return candidate ? { ...candidate } : undefined;
  }

  async putTerminalCandidate(candidate: GoalTerminalCandidateRecord): Promise<boolean> {
    const goal = this.goals.get(candidate.scopeId);
    if (
      !goal ||
      goal.id !== candidate.goalId ||
      goal.version !== candidate.goalVersion ||
      goal.status !== "active"
    ) {
      return false;
    }
    this.terminalCandidates.set(candidate.scopeId, { ...candidate });
    return true;
  }

  async deleteTerminalCandidate(scopeId: string, expectedCandidateId: string): Promise<boolean> {
    const candidate = this.terminalCandidates.get(scopeId);
    if (!candidate || candidate.candidateId !== expectedCandidateId) return false;
    return this.terminalCandidates.delete(scopeId);
  }

  async getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined> {
    const claim = this.claims.get(scopeId);
    return claim ? { ...claim } : undefined;
  }

  async createContinuationClaim(claim: GoalContinuationClaim): Promise<boolean> {
    const goal = this.goals.get(claim.scopeId);
    if (
      this.claims.has(claim.scopeId) ||
      !goal ||
      goal.id !== claim.goalId ||
      goal.version !== claim.goalVersion ||
      goal.status !== "active"
    ) {
      return false;
    }
    this.claims.set(claim.scopeId, { ...claim });
    return true;
  }

  async replaceContinuationClaim(
    claim: GoalContinuationClaim,
    expectedClaimId: string,
  ): Promise<boolean> {
    const current = this.claims.get(claim.scopeId);
    if (!current || current.claimId !== expectedClaimId) return false;
    this.claims.set(claim.scopeId, { ...claim });
    return true;
  }

  async deleteContinuationClaim(scopeId: string, expectedClaimId: string): Promise<boolean> {
    const current = this.claims.get(scopeId);
    if (!current || current.claimId !== expectedClaimId) return false;
    return this.claims.delete(scopeId);
  }

  close(): void {}
}
