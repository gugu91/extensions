import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentInfo, TaskAssignmentInfo, TaskAssignmentStatus } from "./broker/types.js";

const execFileAsync = promisify(execFile);

export type CommandResult = { stdout?: string | Buffer };
export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" },
) => Promise<CommandResult>;

export interface ParsedTaskAssignment {
  issueNumber: number;
  branch: string | null;
}

export interface PullRequestSnapshot {
  number: number;
  state: string;
  mergedAt: string | null;
  headRefName: string;
}

export interface ResolvedTaskAssignment extends TaskAssignmentInfo {
  nextStatus: TaskAssignmentStatus;
  nextPrNumber: number | null;
  branchAheadCount: number;
}

const WORKTREE_BRANCH_REGEX = /\bgit\s+worktree\s+add\b[^\n]*?\s-b\s+([^\s`"',;]+)/i;
const CHECKOUT_BRANCH_REGEX = /\bgit\s+(?:checkout|switch)\s+-[cb]\s+([^\s`"',;]+)/i;
const EXPLICIT_BRANCH_REGEX =
  /\bbranch(?:\s+(?:to\s+work\s+on|name))?\s*[:=]?\s*[`"']?([A-Za-z0-9._/-]+)\b/i;
const TASK_REFERENCE_REGEX = /\b(?:(issue|pr)\s*)?#(\d+)\b/gi;

async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  try {
    const result = await runner(file, args, { cwd, encoding: "utf-8" });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString();
    const trimmed = stdout?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function runJsonCommand<T>(
  file: string,
  args: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<T | undefined> {
  const stdout = await runCommand(file, args, cwd, runner);
  if (!stdout) {
    return undefined;
  }

  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

function parseBranch(message: string): string | null {
  const match =
    message.match(WORKTREE_BRANCH_REGEX) ??
    message.match(CHECKOUT_BRANCH_REGEX) ??
    message.match(EXPLICIT_BRANCH_REGEX);
  const branch = match?.[1]?.trim();
  return branch ? branch : null;
}

function parseIssueNumbers(message: string): number[] {
  const explicitIssueNumbers = new Set<number>();
  const unlabeledNumbers: number[] = [];

  for (const match of message.matchAll(TASK_REFERENCE_REGEX)) {
    const label = match[1]?.toLowerCase();
    const issueNumber = Number(match[2]);
    if (!Number.isFinite(issueNumber)) {
      continue;
    }

    if (label === "pr") {
      continue;
    }
    if (label === "issue") {
      explicitIssueNumbers.add(issueNumber);
      continue;
    }

    unlabeledNumbers.push(issueNumber);
  }

  if (explicitIssueNumbers.size > 0) {
    return [...explicitIssueNumbers].sort((left, right) => left - right);
  }

  return [...new Set(unlabeledNumbers)].sort((left, right) => left - right);
}

export function extractTaskAssignmentsFromMessage(message: string): ParsedTaskAssignment[] {
  const branch = parseBranch(message);
  return parseIssueNumbers(message).map((issueNumber) => ({ issueNumber, branch }));
}

function normalizePullRequests(prs: PullRequestSnapshot[] | undefined): PullRequestSnapshot[] {
  if (!Array.isArray(prs)) {
    return [];
  }

  return prs.filter(
    (pr): pr is PullRequestSnapshot =>
      typeof pr?.number === "number" &&
      typeof pr?.state === "string" &&
      typeof pr?.headRefName === "string",
  );
}

function chooseBestPullRequest(prs: PullRequestSnapshot[]): PullRequestSnapshot | null {
  if (prs.length === 0) {
    return null;
  }

  const score = (pr: PullRequestSnapshot): number => {
    if (pr.mergedAt) return 3;
    if (pr.state.toUpperCase() === "OPEN") return 2;
    return 1;
  };

  return (
    [...prs].sort((left, right) => {
      const byScore = score(right) - score(left);
      if (byScore !== 0) return byScore;
      const leftMergedAt = left.mergedAt ? Date.parse(left.mergedAt) : 0;
      const rightMergedAt = right.mergedAt ? Date.parse(right.mergedAt) : 0;
      if (rightMergedAt !== leftMergedAt) return rightMergedAt - leftMergedAt;
      return right.number - left.number;
    })[0] ?? null
  );
}

async function resolveBaseRef(cwd: string, runner: CommandRunner): Promise<string | null> {
  for (const ref of ["origin/main", "main"]) {
    const resolved = await runCommand(
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      cwd,
      runner,
    );
    if (resolved) {
      return ref;
    }
  }
  return null;
}

async function getBranchAheadCount(
  branch: string | null,
  baseRef: string | null,
  cwd: string,
  runner: CommandRunner,
): Promise<number> {
  if (!branch || !baseRef) {
    return 0;
  }

  let maxAheadCount = 0;
  const refs = [...new Set([branch, `origin/${branch}`])];
  for (const ref of refs) {
    const resolved = await runCommand(
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      cwd,
      runner,
    );
    if (!resolved) {
      continue;
    }

    const count = await runCommand(
      "git",
      ["rev-list", "--count", `${baseRef}..${ref}`],
      cwd,
      runner,
    );
    const aheadCount = Number.parseInt(count ?? "0", 10);
    if (Number.isFinite(aheadCount) && aheadCount > maxAheadCount) {
      maxAheadCount = aheadCount;
    }
  }

  return maxAheadCount;
}

async function getPullRequestForBranch(
  branch: string | null,
  cwd: string,
  runner: CommandRunner,
): Promise<PullRequestSnapshot | null | undefined> {
  if (!branch) {
    return null;
  }

  const rawPrs = await runJsonCommand<PullRequestSnapshot[]>(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,mergedAt,headRefName",
    ],
    cwd,
    runner,
  );
  if (rawPrs === undefined) {
    return undefined;
  }

  const prs = normalizePullRequests(rawPrs);
  return chooseBestPullRequest(prs);
}

async function getPullRequestByNumber(
  prNumber: number,
  cwd: string,
  runner: CommandRunner,
): Promise<PullRequestSnapshot | null | undefined> {
  const pr = await runJsonCommand<PullRequestSnapshot>(
    "gh",
    ["pr", "view", String(prNumber), "--json", "number,state,mergedAt,headRefName"],
    cwd,
    runner,
  );
  if (pr === undefined) {
    return undefined;
  }
  return normalizePullRequests([pr])[0] ?? null;
}

function resolveTaskStatus(
  assignment: TaskAssignmentInfo,
  branchAheadCount: number,
  pr: PullRequestSnapshot | null | undefined,
): Pick<ResolvedTaskAssignment, "nextStatus" | "nextPrNumber"> {
  if (pr === undefined && assignment.status.startsWith("pr_")) {
    return { nextStatus: assignment.status, nextPrNumber: assignment.prNumber };
  }
  if (pr?.mergedAt) {
    return { nextStatus: "pr_merged", nextPrNumber: pr.number };
  }
  if (pr?.state.toUpperCase() === "OPEN") {
    return { nextStatus: "pr_open", nextPrNumber: pr.number };
  }
  if (pr) {
    return { nextStatus: "pr_closed", nextPrNumber: pr.number };
  }
  if (branchAheadCount > 0) {
    return { nextStatus: "branch_pushed", nextPrNumber: null };
  }
  return { nextStatus: "assigned", nextPrNumber: null };
}

export async function resolveTaskAssignments(
  assignments: TaskAssignmentInfo[],
  cwd = process.cwd(),
  runner: CommandRunner = execFileAsync as CommandRunner,
): Promise<ResolvedTaskAssignment[]> {
  if (assignments.length === 0) {
    return [];
  }

  const baseRef = await resolveBaseRef(cwd, runner);
  const branchProgressCache = new Map<
    string,
    Promise<{ branchAheadCount: number; pr: PullRequestSnapshot | null | undefined }>
  >();
  const pullRequestByNumberCache = new Map<
    number,
    Promise<PullRequestSnapshot | null | undefined>
  >();

  const resolveBranchProgress = (
    branch: string | null,
  ): Promise<{ branchAheadCount: number; pr: PullRequestSnapshot | null | undefined }> => {
    const cacheKey = branch ?? "";
    const cached = branchProgressCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const promise = Promise.all([
      getBranchAheadCount(branch, baseRef, cwd, runner),
      getPullRequestForBranch(branch, cwd, runner),
    ]).then(([branchAheadCount, pr]) => ({ branchAheadCount, pr }));
    branchProgressCache.set(cacheKey, promise);
    return promise;
  };

  const resolvePullRequestByNumber = (
    prNumber: number,
  ): Promise<PullRequestSnapshot | null | undefined> => {
    const cached = pullRequestByNumberCache.get(prNumber);
    if (cached) {
      return cached;
    }

    const promise = getPullRequestByNumber(prNumber, cwd, runner);
    pullRequestByNumberCache.set(prNumber, promise);
    return promise;
  };

  return Promise.all(
    assignments.map(async (assignment) => {
      const { branchAheadCount, pr } = await resolveBranchProgress(assignment.branch);
      const resolvedPr =
        pr == null && assignment.prNumber != null
          ? await resolvePullRequestByNumber(assignment.prNumber)
          : pr;
      const { nextStatus, nextPrNumber } = resolveTaskStatus(
        assignment,
        branchAheadCount,
        resolvedPr,
      );
      return {
        ...assignment,
        nextStatus,
        nextPrNumber,
        branchAheadCount,
      };
    }),
  );
}

export function hasTaskAssignmentStatusChange(assignment: ResolvedTaskAssignment): boolean {
  return (
    assignment.status !== assignment.nextStatus || assignment.prNumber !== assignment.nextPrNumber
  );
}

function formatTaskProgressFragment(
  assignment: Pick<TaskAssignmentInfo, "issueNumber" | "branch" | "status" | "prNumber">,
): string {
  switch (assignment.status) {
    case "pr_merged":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} MERGED ✅`;
    case "pr_open":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} OPEN 🔄`;
    case "pr_closed":
      return `#${assignment.issueNumber} → PR #${assignment.prNumber ?? "?"} CLOSED ⚠️`;
    case "branch_pushed":
      return `#${assignment.issueNumber} → commits on ${assignment.branch ?? "tracked branch"}, no PR 👀`;
    case "assigned":
    default:
      return `#${assignment.issueNumber} → no commits, no PR ⚠️`;
  }
}

function formatAgentLabel(
  agentId: string,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
): string {
  const agent = agentsById.get(agentId);
  if (!agent) {
    return agentId;
  }
  return `${agent.emoji} ${agent.name}`.trim();
}

function getAgentSortKey(
  agentId: string,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
): string {
  const agent = agentsById.get(agentId);
  return agent?.name ?? agentId;
}

export function buildTaskAssignmentReport(
  assignments: Array<
    Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "branch" | "status" | "prNumber">
  >,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
): string | null {
  if (assignments.length === 0) {
    return null;
  }

  const grouped = new Map<
    string,
    Array<Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "branch" | "status" | "prNumber">>
  >();
  for (const assignment of assignments) {
    const bucket = grouped.get(assignment.agentId);
    if (bucket) {
      bucket.push(assignment);
    } else {
      grouped.set(assignment.agentId, [assignment]);
    }
  }

  const lines = [...grouped.entries()]
    .sort(([leftAgentId], [rightAgentId]) => {
      const leftLabel = getAgentSortKey(leftAgentId, agentsById);
      const rightLabel = getAgentSortKey(rightAgentId, agentsById);
      return leftLabel.localeCompare(rightLabel);
    })
    .map(([agentId, agentAssignments]) => {
      const summary = [...agentAssignments]
        .sort((left, right) => left.issueNumber - right.issueNumber)
        .map((assignment) => formatTaskProgressFragment(assignment))
        .join("; ");
      return `- ${formatAgentLabel(agentId, agentsById)}: ${summary}`;
    });

  return `RALPH LOOP — WORKER STATUS:\n${lines.join("\n")}`;
}

export function getPendingTaskAssignmentReport(
  assignments: Array<
    Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "branch" | "status" | "prNumber">
  >,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
  lastDeliveredReport: string,
): string | null {
  const report = buildTaskAssignmentReport(assignments, agentsById);
  if (!report || report === lastDeliveredReport) {
    return null;
  }
  return report;
}
