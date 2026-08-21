import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentGoal, GoalStatus, GoalStorage } from "./domain.js";

interface GoalRow {
  id: string;
  scope_id: string;
  objective: string;
  status: GoalStatus;
  blocked_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export class SqliteGoalStorage implements GoalStorage {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agent_goals (
        scope_id TEXT PRIMARY KEY NOT NULL,
        id TEXT UNIQUE NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'complete')),
        blocked_reason TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async get(scopeId: string): Promise<AgentGoal | undefined> {
    const row = this.db
      .prepare(
        `SELECT id, scope_id, objective, status, blocked_reason, version, created_at, updated_at
         FROM agent_goals WHERE scope_id = ?`,
      )
      .get(scopeId) as GoalRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      scopeId: row.scope_id,
      objective: row.objective,
      status: row.status,
      blockedReason: row.blocked_reason ?? undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async create(goal: AgentGoal): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_goals
          (scope_id, id, objective, status, blocked_reason, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goal.scopeId,
        goal.id,
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
        goal.version,
        goal.createdAt,
        goal.updatedAt,
      );
  }

  async replace(goal: AgentGoal, expectedVersion: number): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE agent_goals
         SET objective = ?, status = ?, blocked_reason = ?, version = ?, updated_at = ?
         WHERE scope_id = ? AND id = ? AND version = ?`,
      )
      .run(
        goal.objective,
        goal.status,
        goal.blockedReason ?? null,
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

  close(): void {
    this.db.close();
  }
}
