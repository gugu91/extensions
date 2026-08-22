import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentGoal,
  GoalContinuationClaim,
  GoalPendingEvaluation,
  GoalTerminalCandidateRecord,
} from "./domain.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";

const tempDirectories: string[] = [];

const goal: AgentGoal = {
  id: "goal-1",
  scopeId: "session-1",
  objective: "ship",
  status: "active",
  budget: { maxIterations: 10, maxTokens: 50_000 },
  usage: { iterations: 2, tokens: 1_200 },
  lastEvaluation: {
    id: "evaluation-1",
    outcome: "continue",
    reason: "tests remain",
    at: "2026-01-01T00:01:00.000Z",
  },
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const pending: GoalPendingEvaluation = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  evaluationId: "evaluation-2",
  progress: {
    latestOutput: "work",
    tokenDelta: 200,
    terminalCandidate: { outcome: "complete", reason: "all checks pass" },
  },
  attempt: 1,
  availableAt: "2026-01-01T00:02:00.000Z",
  lastError: "offline",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

const candidate: GoalTerminalCandidateRecord = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  candidateId: "candidate-1",
  outcome: "complete",
  reason: "all checks pass",
  createdAt: "2026-01-01T00:01:00.000Z",
};

const claim: GoalContinuationClaim = {
  scopeId: "session-1",
  goalId: "goal-1",
  goalVersion: 3,
  claimId: "claim-1",
  state: "deferred",
  reason: "busy",
  attempt: 1,
  availableAt: "2026-01-01T00:02:00.000Z",
  expiresAt: "2026-01-01T00:07:00.000Z",
  createdAt: "2026-01-01T00:01:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteGoalStorage", () => {
  it("persists goals and continuation claims across storage instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const path = join(directory, "nested", "goals.sqlite");

    const first = new SqliteGoalStorage(path);
    await first.create(goal);
    expect(await first.putPendingEvaluation(pending)).toBe(true);
    expect(await first.putTerminalCandidate(candidate)).toBe(true);
    expect(await first.createContinuationClaim(claim)).toBe(true);
    first.close();
    const second = new SqliteGoalStorage(path);

    expect(await second.get("session-1")).toEqual(goal);
    expect(await second.getPendingEvaluation("session-1")).toEqual(pending);
    expect(await second.getTerminalCandidate("session-1")).toEqual(candidate);
    expect(await second.getContinuationClaim("session-1")).toEqual(claim);
    expect(await second.deleteContinuationClaim("session-1", claim.claimId)).toBe(true);
    expect(
      await second.createContinuationClaim({
        ...claim,
        claimId: "stale-claim",
        goalVersion: 2,
      }),
    ).toBe(false);
    second.close();
  });

  it("migrates goals created by the initial standalone schema", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const path = join(directory, "goals.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE agent_goals (
        scope_id TEXT PRIMARY KEY NOT NULL,
        id TEXT UNIQUE NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'complete')),
        blocked_reason TEXT,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO agent_goals VALUES
        ('session-1', 'goal-1', 'ship', 'active', NULL, 1,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    const storage = new SqliteGoalStorage(path);
    const migrated = await storage.get("session-1");
    expect(migrated).toMatchObject({
      budget: { maxIterations: 25 },
      usage: { iterations: 0, tokens: 0 },
    });
    expect(
      await storage.replace(
        { ...migrated!, status: "budget_limited", version: migrated!.version + 1 },
        migrated!.version,
      ),
    ).toBe(true);
    storage.close();
  });

  it("uses versions and claim ids to reject stale mutations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    await storage.create(goal);
    await storage.createContinuationClaim(claim);

    expect(await storage.replace({ ...goal, status: "paused", version: 4 }, 99)).toBe(false);
    expect(await storage.delete("session-1", 99)).toBe(false);
    expect(await storage.deleteContinuationClaim("session-1", "stale")).toBe(false);
    expect(await storage.replaceContinuationClaim({ ...claim, state: "started" }, "stale")).toBe(
      false,
    );
    expect(await storage.replaceContinuationClaim({ ...claim, state: "started" }, "claim-1")).toBe(
      true,
    );
    expect(await storage.replace({ ...goal, status: "paused", version: 4 }, 3)).toBe(true);
    expect(await storage.delete("session-1", 4)).toBe(true);
    expect(await storage.get("session-1")).toBeUndefined();
    storage.close();
  });
});
