import { describe, expect, it, vi } from "vitest";
import type { AgentInfo, TaskAssignmentInfo } from "./broker/types.js";
import {
  buildTaskAssignmentReport,
  extractTaskAssignmentsFromMessage,
  getPendingTaskAssignmentReport,
  hasTaskAssignmentStatusChange,
  resolveTaskAssignments,
  type CommandRunner,
} from "./task-assignments.js";

function makeAssignment(
  overrides: Partial<TaskAssignmentInfo> &
    Pick<TaskAssignmentInfo, "id" | "agentId" | "issueNumber">,
): TaskAssignmentInfo {
  return {
    id: overrides.id,
    agentId: overrides.agentId,
    issueNumber: overrides.issueNumber,
    branch: overrides.branch ?? null,
    prNumber: overrides.prNumber ?? null,
    status: overrides.status ?? "assigned",
    threadId: overrides.threadId ?? `a2a:broker:${overrides.agentId}`,
    sourceMessageId: overrides.sourceMessageId ?? null,
    createdAt: overrides.createdAt ?? "2026-04-02T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-02T10:00:00.000Z",
  };
}

function makeAgent(
  id: string,
  name: string,
  emoji: string,
): Pick<AgentInfo, "emoji" | "name"> & { id: string } {
  return { id, name, emoji };
}

describe("extractTaskAssignmentsFromMessage", () => {
  it("extracts the issue number and worktree branch from a broker task message", () => {
    const message = [
      "Issue #114 — RALPH loop should report worker task completion status to broker.",
      "Create a worktree: `git worktree add .worktrees/feat-114-v2 -b feat/ralph-completion-v2`.",
      "Create a PR targeting main.",
    ].join("\n");

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      { issueNumber: 114, branch: "feat/ralph-completion-v2" },
    ]);
  });

  it("ignores PR references when extracting task assignments", () => {
    const message = "Please follow up on Issue #114. Related PR #171 already exists.";

    expect(extractTaskAssignmentsFromMessage(message)).toEqual([
      { issueNumber: 114, branch: null },
    ]);
  });
});

describe("resolveTaskAssignments", () => {
  it("keeps assignments at no commits / no PR when nothing has happened", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      throw new Error("missing ref");
    });

    const [assignment] = await resolveTaskAssignments(
      [makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/ralph" })],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("assigned");
    expect(assignment.nextPrNumber).toBeNull();
    expect(hasTaskAssignmentStatusChange(assignment)).toBe(false);
  });

  it("detects pushed commits before a PR exists", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "git" && args[0] === "rev-parse" && args.at(-1) === "feat/ralph") {
        return { stdout: "feat/ralph\n" };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: "2\n" };
      }
      if (file === "gh") {
        return { stdout: "[]\n" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/ralph" })],
      "/repo",
      runner,
    );

    expect(assignment.branchAheadCount).toBe(2);
    expect(assignment.nextStatus).toBe("branch_pushed");
    expect(assignment.nextPrNumber).toBeNull();
    expect(hasTaskAssignmentStatusChange(assignment)).toBe(true);
  });

  it("detects open and merged PRs from GitHub", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "git" && args[0] === "rev-parse") {
        return { stdout: `${args.at(-1)}\n` };
      }
      if (file === "git" && args[0] === "rev-list") {
        return { stdout: "3\n" };
      }
      if (file === "gh" && args.includes("feat/open-pr")) {
        return {
          stdout: JSON.stringify([
            { number: 201, state: "OPEN", mergedAt: null, headRefName: "feat/open-pr" },
          ]),
        };
      }
      if (file === "gh" && args.includes("feat/merged-pr")) {
        return {
          stdout: JSON.stringify([
            {
              number: 202,
              state: "CLOSED",
              mergedAt: "2026-04-02T12:00:00.000Z",
              headRefName: "feat/merged-pr",
            },
          ]),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const assignments = await resolveTaskAssignments(
      [
        makeAssignment({ id: 1, agentId: "worker-1", issueNumber: 114, branch: "feat/open-pr" }),
        makeAssignment({ id: 2, agentId: "worker-2", issueNumber: 115, branch: "feat/merged-pr" }),
      ],
      "/repo",
      runner,
    );

    expect(assignments[0].nextStatus).toBe("pr_open");
    expect(assignments[0].nextPrNumber).toBe(201);
    expect(assignments[1].nextStatus).toBe("pr_merged");
    expect(assignments[1].nextPrNumber).toBe(202);
  });

  it("falls back to the stored PR number when the branch lookup returns nothing", async () => {
    const runner: CommandRunner = vi.fn(async (file, args) => {
      if (
        file === "git" &&
        args.slice(0, 4).join(" ") === "rev-parse --verify --quiet origin/main"
      ) {
        return { stdout: "origin/main\n" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "list") {
        return { stdout: "[]\n" };
      }
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          stdout: JSON.stringify({
            number: 202,
            state: "CLOSED",
            mergedAt: "2026-04-02T12:00:00.000Z",
            headRefName: "feat/merged-pr",
          }),
        };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const [assignment] = await resolveTaskAssignments(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          branch: "feat/merged-pr",
          status: "pr_open",
          prNumber: 202,
        }),
      ],
      "/repo",
      runner,
    );

    expect(assignment.nextStatus).toBe("pr_merged");
    expect(assignment.nextPrNumber).toBe(202);
  });
});

describe("buildTaskAssignmentReport", () => {
  it("groups assignment summaries by worker", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 106,
          status: "pr_merged",
          prNumber: 109,
        }),
        makeAssignment({
          id: 2,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
        makeAssignment({
          id: 3,
          agentId: "worker-2",
          issueNumber: 104,
          status: "branch_pushed",
          branch: "feat/worker-2",
        }),
      ],
      new Map([
        ["worker-1", makeAgent("worker-1", "Hyper Horse", "🐎")],
        ["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")],
      ]),
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️; #104 → commits on feat/worker-2, no PR 👀",
        "- 🐎 Hyper Horse: #106 → PR #109 MERGED ✅",
      ].join("\n"),
    );
  });

  it("includes a timestamp when one is provided", () => {
    const report = buildTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
      ],
      new Map([["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")]]),
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toBe(
      [
        "RALPH LOOP — WORKER STATUS:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
    );
  });
});

describe("getPendingTaskAssignmentReport", () => {
  const agentsById = new Map([
    ["worker-1", makeAgent("worker-1", "Hyper Horse", "🐎")],
    ["worker-2", makeAgent("worker-2", "Frozen Raven", "🐦‍⬛")],
  ]);

  it("queues an initial report for newly assigned tasks with no progress", () => {
    const report = getPendingTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-2",
          issueNumber: 103,
          status: "assigned",
        }),
      ],
      agentsById,
      "",
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toEqual({
      signature: [
        "RALPH LOOP — WORKER STATUS:",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
      message: [
        "RALPH LOOP — WORKER STATUS:",
        "Timestamp: 2026-04-02T14:10:00.000Z",
        "- 🐦‍⬛ Frozen Raven: #103 → no commits, no PR ⚠️",
      ].join("\n"),
    });
  });

  it("does not queue a report when it matches the last delivered summary signature", () => {
    const lastDeliveredReport = [
      "RALPH LOOP — WORKER STATUS:",
      "- 🐎 Hyper Horse: #106 → PR #109 MERGED ✅",
    ].join("\n");

    const report = getPendingTaskAssignmentReport(
      [
        makeAssignment({
          id: 1,
          agentId: "worker-1",
          issueNumber: 106,
          status: "pr_merged",
          prNumber: 109,
        }),
      ],
      agentsById,
      lastDeliveredReport,
      "2026-04-02T14:10:00.000Z",
    );

    expect(report).toBeNull();
  });
});
