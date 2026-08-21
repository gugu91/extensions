import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentGoal,
  GoalContinuationClaim,
  GoalEvaluation,
  GoalPendingEvaluation,
  GoalStatus,
  GoalStorage,
} from "./domain.js";

interface GoalRow {
  id: string;
  scope_id: string;
  objective: string;
  status: GoalStatus;
  blocked_reason: string | null;
  max_iterations: number;
  max_tokens: number | null;
  max_runtime_ms: number | null;
  iterations_used: number;
  tokens_used: number;
  last_settled_at: string | null;
  last_evaluation_id: string | null;
  last_evaluation_outcome: GoalEvaluation["outcome"] | null;
  last_evaluation_reason: string | null;
  last_evaluation_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface PendingEvaluationRow {
  scope_id: string;
  goal_id: string;
  goal_version: number;
  evaluation_id: string;
  latest_output: string;
  token_delta: number;
  attempt: number;
  available_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ClaimRow {
  scope_id: string;
  goal_id: string;
  goal_version: number;
  claim_id: string;
  state: GoalContinuationClaim["state"];
  reason: string;
  attempt: number;
  available_at: string;
  expires_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteGoalStorage implements GoalStorage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    const goalTableSql = `CREATE TABLE IF NOT EXISTS agent_goals (
      scope_id TEXT PRIMARY KEY NOT NULL,
      id TEXT UNIQUE NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'budget_limited', 'complete')),
      blocked_reason TEXT,
      max_iterations INTEGER NOT NULL DEFAULT 25,
      max_tokens INTEGER,
      max_runtime_ms INTEGER,
      iterations_used INTEGER NOT NULL DEFAULT 0,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      last_settled_at TEXT,
      last_evaluation_id TEXT,
      last_evaluation_outcome TEXT,
      last_evaluation_reason TEXT,
      last_evaluation_at TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`;
    this.db.exec(`PRAGMA journal_mode = WAL; ${goalTableSql};`);
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(agent_goals)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    );
    for (const [name, definition] of [
      ["max_iterations", "INTEGER NOT NULL DEFAULT 25"],
      ["max_tokens", "INTEGER"],
      ["max_runtime_ms", "INTEGER"],
      ["iterations_used", "INTEGER NOT NULL DEFAULT 0"],
      ["tokens_used", "INTEGER NOT NULL DEFAULT 0"],
      ["last_settled_at", "TEXT"],
      ["last_evaluation_id", "TEXT"],
      ["last_evaluation_outcome", "TEXT"],
      ["last_evaluation_reason", "TEXT"],
      ["last_evaluation_at", "TEXT"],
    ] as const) {
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE agent_goals ADD COLUMN ${name} ${definition}`);
    }
    const tableDefinition = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_goals'")
      .get() as { sql: string };
    if (!tableDefinition.sql.includes("budget_limited")) {
      this.db.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
        DROP TABLE IF EXISTS agent_goal_pending_evaluations;
        DROP TABLE IF EXISTS agent_goal_continuations;
        ALTER TABLE agent_goals RENAME TO agent_goals_legacy;
        ${goalTableSql};
        INSERT INTO agent_goals
          (scope_id, id, objective, status, blocked_reason, max_iterations, max_tokens,
           max_runtime_ms, iterations_used, tokens_used, last_settled_at,
           last_evaluation_id, last_evaluation_outcome, last_evaluation_reason, last_evaluation_at,
           version, created_at, updated_at)
        SELECT scope_id, id, objective, status, blocked_reason, max_iterations, max_tokens,
          max_runtime_ms, iterations_used, tokens_used, last_settled_at,
          last_evaluation_id, last_evaluation_outcome, last_evaluation_reason, last_evaluation_at,
          version, created_at, updated_at
        FROM agent_goals_legacy;
        DROP TABLE agent_goals_legacy;
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
    }
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS agent_goal_pending_evaluations (
        scope_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        evaluation_id TEXT UNIQUE NOT NULL,
        latest_output TEXT NOT NULL,
        token_delta INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_goal_continuations (
        scope_id TEXT PRIMARY KEY NOT NULL,
        goal_id TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        claim_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'deferred', 'started')),
        reason TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        available_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (scope_id) REFERENCES agent_goals(scope_id) ON DELETE CASCADE
      );
    `);
  }

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    const row = this.db.prepare("SELECT * FROM agent_goals WHERE scope_id = ?").get(scopeId) as
      | GoalRow
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      scopeId: row.scope_id,
      objective: row.objective,
      status: row.status,
      blockedReason: row.blocked_reason ?? undefined,
      budget: {
        maxIterations: row.max_iterations,
        maxTokens: row.max_tokens ?? undefined,
        maxRuntimeMs: row.max_runtime_ms ?? undefined,
      },
      usage: { iterations: row.iterations_used, tokens: row.tokens_used },
      lastSettledAt: row.last_settled_at ?? undefined,
      lastEvaluation:
        row.last_evaluation_id &&
        row.last_evaluation_outcome &&
        row.last_evaluation_reason &&
        row.last_evaluation_at
          ? {
              id: row.last_evaluation_id,
              outcome: row.last_evaluation_outcome,
              reason: row.last_evaluation_reason,
              at: row.last_evaluation_at,
            }
          : undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(goal: AgentGoal): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_goals
          (scope_id, id, objective, status, blocked_reason, max_iterations, max_tokens,
           max_runtime_ms, iterations_used, tokens_used, last_settled_at,
           last_evaluation_id, last_evaluation_outcome, last_evaluation_reason, last_evaluation_at,
           version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.scopeId,
        goal.id,
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
        goal.budget.maxIterations,
        goal.budget.maxTokens ?? null,
        goal.budget.maxRuntimeMs ?? null,
        goal.usage.iterations,
        goal.usage.tokens,
        goal.lastSettledAt ?? null,
        goal.lastEvaluation?.id ?? null,
        goal.lastEvaluation?.outcome ?? null,
        goal.lastEvaluation?.reason ?? null,
        goal.lastEvaluation?.at ?? null,
        goal.version,
        goal.createdAt,
        goal.updatedAt,
      );
  }

  async replace(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goals SET objective = ?, status = ?, blocked_reason = ?,
         max_iterations = ?, max_tokens = ?, max_runtime_ms = ?, iterations_used = ?,
         tokens_used = ?, last_settled_at = ?, last_evaluation_id = ?,
         last_evaluation_outcome = ?, last_evaluation_reason = ?, last_evaluation_at = ?,
         version = ?, updated_at = ?
         WHERE scope_id = ? AND id = ? AND version = ?`,
      )
      .run(
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
        goal.budget.maxIterations,
        goal.budget.maxTokens ?? null,
        goal.budget.maxRuntimeMs ?? null,
        goal.usage.iterations,
        goal.usage.tokens,
        goal.lastSettledAt ?? null,
        goal.lastEvaluation?.id ?? null,
        goal.lastEvaluation?.outcome ?? null,
        goal.lastEvaluation?.reason ?? null,
        goal.lastEvaluation?.at ?? null,
        goal.version,
        goal.updatedAt,
        goal.scopeId,
        goal.id,
        expectedVersion,
      );
    return result.changes === 1;
  }

  async delete(scopeId: string, expectedVersion: number): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM agent_goals WHERE scope_id = ? AND version = ?")
      .run(scopeId, expectedVersion);
    return result.changes === 1;
  }

  async getPendingEvaluation(scopeId: string): Promise<GoalPendingEvaluation | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_goal_pending_evaluations WHERE scope_id = ?")
      .get(scopeId) as PendingEvaluationRow | undefined;
    return row
      ? {
          scopeId: row.scope_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          evaluationId: row.evaluation_id,
          progress: { latestOutput: row.latest_output, tokenDelta: row.token_delta },
          attempt: row.attempt,
          availableAt: row.available_at,
          lastError: row.last_error ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async putPendingEvaluation(pending: GoalPendingEvaluation): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO agent_goal_pending_evaluations
         (scope_id, goal_id, goal_version, evaluation_id, latest_output, token_delta,
          attempt, available_at, last_error, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_goals WHERE scope_id = ? AND id = ? AND version = ?
         )
         ON CONFLICT(scope_id) DO UPDATE SET goal_id = excluded.goal_id,
           goal_version = excluded.goal_version, evaluation_id = excluded.evaluation_id,
           latest_output = excluded.latest_output, token_delta = excluded.token_delta,
           attempt = excluded.attempt, available_at = excluded.available_at,
           last_error = excluded.last_error, created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        pending.scopeId,
        pending.goalId,
        pending.goalVersion,
        pending.evaluationId,
        pending.progress.latestOutput,
        pending.progress.tokenDelta ?? 0,
        pending.attempt,
        pending.availableAt,
        pending.lastError ?? null,
        pending.createdAt,
        pending.updatedAt,
        pending.scopeId,
        pending.goalId,
        pending.goalVersion,
      );
    return result.changes === 1;
  }

  async deletePendingEvaluation(scopeId: string, expectedEvaluationId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "DELETE FROM agent_goal_pending_evaluations WHERE scope_id = ? AND evaluation_id = ?",
      )
      .run(scopeId, expectedEvaluationId);
    return result.changes === 1;
  }

  async getContinuationClaim(scopeId: string): Promise<GoalContinuationClaim | undefined> {
    const row = this.db
      .prepare("SELECT * FROM agent_goal_continuations WHERE scope_id = ?")
      .get(scopeId) as ClaimRow | undefined;
    return row
      ? {
          scopeId: row.scope_id,
          goalId: row.goal_id,
          goalVersion: row.goal_version,
          claimId: row.claim_id,
          state: row.state,
          reason: row.reason,
          attempt: row.attempt,
          availableAt: row.available_at,
          expiresAt: row.expires_at,
          lastError: row.last_error ?? undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async createContinuationClaim(claim: GoalContinuationClaim): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_goal_continuations
         (scope_id, goal_id, goal_version, claim_id, state, reason, attempt,
          available_at, expires_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claim.scopeId,
        claim.goalId,
        claim.goalVersion,
        claim.claimId,
        claim.state,
        claim.reason,
        claim.attempt,
        claim.availableAt,
        claim.expiresAt,
        claim.lastError ?? null,
        claim.createdAt,
        claim.updatedAt,
      );
    return result.changes === 1;
  }

  async replaceContinuationClaim(
    claim: GoalContinuationClaim,
    expectedClaimId: string,
  ): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goal_continuations SET goal_id = ?, goal_version = ?, claim_id = ?,
         state = ?, reason = ?, attempt = ?, available_at = ?, expires_at = ?,
         last_error = ?, updated_at = ? WHERE scope_id = ? AND claim_id = ?`,
      )
      .run(
        claim.goalId,
        claim.goalVersion,
        claim.claimId,
        claim.state,
        claim.reason,
        claim.attempt,
        claim.availableAt,
        claim.expiresAt,
        claim.lastError ?? null,
        claim.updatedAt,
        claim.scopeId,
        expectedClaimId,
      );
    return result.changes === 1;
  }

  async deleteContinuationClaim(scopeId: string, expectedClaimId: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM agent_goal_continuations WHERE scope_id = ? AND claim_id = ?")
      .run(scopeId, expectedClaimId);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}
