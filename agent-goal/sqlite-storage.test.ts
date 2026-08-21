import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentGoal } from "./domain.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteGoalStorage", () => {
  it("persists goals across storage instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const path = join(directory, "nested", "goals.sqlite");
    const goal: AgentGoal = {
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const first = new SqliteGoalStorage(path);
    await first.create(goal);
    first.close();
    const second = new SqliteGoalStorage(path);

    expect(await second.get("session-1")).toEqual(goal);
    second.close();
  });

  it("uses versions to reject stale replacement and deletion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-goal-"));
    tempDirectories.push(directory);
    const storage = new SqliteGoalStorage(join(directory, "goals.sqlite"));
    const goal: AgentGoal = {
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await storage.create(goal);

    expect(await storage.replace({ ...goal, status: "paused", version: 2 }, 99)).toBe(false);
    expect(await storage.delete("session-1", 99)).toBe(false);
    expect(await storage.replace({ ...goal, status: "paused", version: 2 }, 1)).toBe(true);
    expect(await storage.delete("session-1", 2)).toBe(true);
    expect(await storage.get("session-1")).toBeUndefined();
    storage.close();
  });
});
