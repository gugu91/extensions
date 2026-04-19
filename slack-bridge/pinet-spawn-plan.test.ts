import { describe, expect, it } from "vitest";
import { buildPinetFollowerSpawnPlan } from "./pinet-spawn-plan.js";

describe("buildPinetFollowerSpawnPlan", () => {
  it("builds a default single-worker launcher plan", () => {
    const plan = buildPinetFollowerSpawnPlan({
      cwd: "/repo/extensions/.worktrees/feat-406",
      socketPath: "/tmp/pinet.sock",
    });

    expect(plan.count).toBe(1);
    expect(plan.launcherScriptPath).toBe(".pi/tmp/pinet-follow-pinet-follower.sh");
    expect(plan.logDir).toBe(".pi/tmp/pinet-follow-pinet-follower-logs");
    expect(plan.summary).toContain("Launch 1 real Pinet follower");
    expect(plan.commands[0]).toBe('mkdir -p ".pi/tmp/pinet-follow-pinet-follower-logs"');
    expect(plan.commands.join("\n")).toContain(
      'pi --broker-socket="/tmp/pinet.sock" --command /pinet-follow',
    );
    expect(plan.commands.join("\n")).toContain("for N in $(seq 1 1)");
  });

  it("sanitizes branch names into worktree and launcher paths", () => {
    const plan = buildPinetFollowerSpawnPlan({
      cwd: "/repo/extensions/.worktrees/feat-406",
      branch: " refs/heads/feat/406-broker-worker-spawn ",
      count: 3,
    });

    expect(plan.branch).toBe("feat/406-broker-worker-spawn");
    expect(plan.launcherScriptPath).toBe(".pi/tmp/pinet-follow-feat-406-broker-worker-spawn.sh");
    expect(plan.logDir).toBe(".pi/tmp/pinet-follow-feat-406-broker-worker-spawn-logs");
    expect(plan.summary).toContain("Launch 3 real Pinet followers");
    expect(plan.commands.join("\n")).toContain(
      "git worktree add .worktrees/feat-406-broker-worker-spawn-worker-$N -b feat/406-broker-worker-spawn-worker-$N",
    );
    expect(plan.commands.join("\n")).toContain("for N in $(seq 1 3)");
  });

  it("clamps invalid counts to one worker", () => {
    expect(
      buildPinetFollowerSpawnPlan({
        cwd: "/repo",
        count: 0,
      }).count,
    ).toBe(1);

    expect(
      buildPinetFollowerSpawnPlan({
        cwd: "/repo",
        count: Number.NaN,
      }).count,
    ).toBe(1);
  });
});
