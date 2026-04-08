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

export interface IssueSnapshot {
  number: number;
  state: string;
}

export interface ResolvedTaskAssignment extends TaskAssignmentInfo {
  nextStatus: TaskAssignmentStatus;
  nextPrNumber: number | null;
  branchAheadCount: number;
  issueState: "OPEN" | "CLOSED" | null;
}

const WORKTREE_BRANCH_REGEX = /\bgit\s+worktree\s+add\b[^\n]*?\s-b\s+([^\s`"',;]+)/i;
const CHECKOUT_BRANCH_REGEX = /\bgit\s+(?:checkout|switch)\s+-[cb]\s+([^\s`"',;]+)/i;
const EXPLICIT_BRANCH_LABEL_REGEX =
  /\bbranch(?:\s+to\s+work\s+on|\s+name)?\s*:\s*[`"']?([A-Za-z0-9._/-]+)\b/i;
const ISSUE_PR_LINE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\/pr\s*:\s*#(\d+)\b/gi;
const ISSUE_LINE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\s*:\s*#(\d+)\b/gi;
const ISSUE_HEADING_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?issue\s+#(\d+)\b/gi;
const TASK_ISSUE_REGEX = /(?:^|\n)\s*(?:[-*]\s*)?task\s*:\s*[^\n#]*\bissue\s*#(\d+)\b/gi;
const NEW_TASK_ISSUE_REGEX =
  /(?:^|\n)\s*(?:[-*]\s*)?new(?:\s+[a-z-]+){0,3}\s+task\b[^\n#]*\bissue\s*#(\d+)\b/gi;
const FOLLOW_UP_TASK_ISSUE_REGEX =
  /(?:^|\n)\s*(?:[-*]\s*)?follow-up\s+task(?:\s+from)?\s+issue\s*#(\d+)\b/gi;

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

function normalizeMessageForTaskParsing(message: string): string {
  return message.replace(/\r\n/g, "\n").replace(/[`*_]/g, "");
}

function parseBranch(message: string): string | null {
  const normalized = normalizeMessageForTaskParsing(message);
  const match =
    normalized.match(WORKTREE_BRANCH_REGEX) ??
    normalized.match(CHECKOUT_BRANCH_REGEX) ??
    normalized.match(EXPLICIT_BRANCH_LABEL_REGEX);
  const branch = match?.[1]?.trim().replace(/[.,;:]+$/, "");
  return branch ? branch : null;
}

function parseIssueNumbers(message: string): number[] {
  const normalized = normalizeMessageForTaskParsing(message);
  const issueNumbers = new Set<number>();

  for (const regex of [
    ISSUE_PR_LINE_REGEX,
    ISSUE_LINE_REGEX,
    ISSUE_HEADING_REGEX,
    TASK_ISSUE_REGEX,
    NEW_TASK_ISSUE_REGEX,
    FOLLOW_UP_TASK_ISSUE_REGEX,
  ]) {
    for (const match of normalized.matchAll(regex)) {
      const issueNumber = Number(match[1]);
      if (Number.isFinite(issueNumber)) {
        issueNumbers.add(issueNumber);
      }
    }
  }

  return [...issueNumbers].sort((left, right) => left - right);
}

export function extractTaskAssignmentsFromMessage(message: string): ParsedTaskAssignment[] {
  const branch = parseBranch(message);
  return parseIssueNumbers(message).map((issueNumber) => ({ issueNumber, branch }));
}

function compareTaskAssignmentRecency(left: TaskAssignmentInfo, right: TaskAssignmentInfo): number {
  const updatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedAt !== 0) {
    return updatedAt;
  }
  const createdAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAt !== 0) {
    return createdAt;
  }
  return right.id - left.id;
}

function canonicalizeTaskAssignmentFromSourceMessage(
  assignment: TaskAssignmentInfo,
  sourceMessagesById: ReadonlyMap<number, string>,
): TaskAssignmentInfo | null {
  if (assignment.sourceMessageId == null) {
    return assignment;
  }

  const sourceMessage = sourceMessagesById.get(assignment.sourceMessageId);
  if (!sourceMessage) {
    return assignment;
  }

  const parsedAssignments = extractTaskAssignmentsFromMessage(sourceMessage);
  if (parsedAssignments.length === 0) {
    return null;
  }

  const matchingAssignment = parsedAssignments.find(
    (candidate) => candidate.issueNumber === assignment.issueNumber,
  );
  if (matchingAssignment) {
    if (matchingAssignment.branch === assignment.branch) {
      return assignment;
    }
    return { ...assignment, branch: matchingAssignment.branch };
  }

  if (parsedAssignments.length === 1) {
    const [canonicalAssignment] = parsedAssignments;
    return {
      ...assignment,
      issueNumber: canonicalAssignment.issueNumber,
      branch: canonicalAssignment.branch,
    };
  }

  return null;
}

export function normalizeTrackedTaskAssignments(
  assignments: TaskAssignmentInfo[],
  sourceMessagesById: ReadonlyMap<number, string> = new Map(),
): TaskAssignmentInfo[] {
  const canonicalAssignments = assignments
    .map((assignment) =>
      canonicalizeTaskAssignmentFromSourceMessage(assignment, sourceMessagesById),
    )
    .filter((assignment): assignment is TaskAssignmentInfo => assignment != null)
    .sort(compareTaskAssignmentRecency);

  const visibleAssignments: TaskAssignmentInfo[] = [];
  const seenIssueNumbers = new Set<number>();
  for (const assignment of canonicalAssignments) {
    if (seenIssueNumbers.has(assignment.issueNumber)) {
      continue;
    }
    seenIssueNumbers.add(assignment.issueNumber);
    visibleAssignments.push(assignment);
  }

  return visibleAssignments;
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

async function getIssueByNumber(
  issueNumber: number,
  cwd: string,
  runner: CommandRunner,
): Promise<IssueSnapshot | null | undefined> {
  const issue = await runJsonCommand<IssueSnapshot>(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "number,state"],
    cwd,
    runner,
  );
  if (issue === undefined) {
    return undefined;
  }
  if (issue && typeof issue.number === "number" && typeof issue.state === "string") {
    return issue;
  }
  return null;
}

function normalizeIssueState(
  issue: IssueSnapshot | null | undefined,
): ResolvedTaskAssignment["issueState"] {
  const state = issue?.state?.toUpperCase();
  if (state === "OPEN" || state === "CLOSED") {
    return state;
  }
  return null;
}

function hasTrackedPullRequestLink(
  assignment: Pick<TaskAssignmentInfo, "status" | "prNumber">,
  pr: PullRequestSnapshot,
): boolean {
  return (
    assignment.prNumber === pr.number ||
    assignment.status === "pr_open" ||
    assignment.status === "pr_merged" ||
    assignment.status === "pr_closed"
  );
}

function resolveTaskStatus(
  assignment: TaskAssignmentInfo,
  branchAheadCount: number,
  pr: PullRequestSnapshot | null | undefined,
): Pick<ResolvedTaskAssignment, "nextStatus" | "nextPrNumber"> {
  if (pr === undefined && assignment.status.startsWith("pr_")) {
    return { nextStatus: assignment.status, nextPrNumber: assignment.prNumber };
  }
  if (pr?.state.toUpperCase() === "OPEN") {
    return { nextStatus: "pr_open", nextPrNumber: pr.number };
  }
  if (pr?.mergedAt) {
    if (hasTrackedPullRequestLink(assignment, pr)) {
      return { nextStatus: "pr_merged", nextPrNumber: pr.number };
    }
    if (branchAheadCount > 0) {
      return { nextStatus: "branch_pushed", nextPrNumber: null };
    }
    return { nextStatus: "assigned", nextPrNumber: null };
  }
  if (pr) {
    if (hasTrackedPullRequestLink(assignment, pr)) {
      return { nextStatus: "pr_closed", nextPrNumber: pr.number };
    }
    if (branchAheadCount > 0) {
      return { nextStatus: "branch_pushed", nextPrNumber: null };
    }
    return { nextStatus: "assigned", nextPrNumber: null };
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
  const issueByNumberCache = new Map<number, Promise<IssueSnapshot | null | undefined>>();

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

  const resolveIssueByNumber = (issueNumber: number): Promise<IssueSnapshot | null | undefined> => {
    const cached = issueByNumberCache.get(issueNumber);
    if (cached) {
      return cached;
    }

    const promise = getIssueByNumber(issueNumber, cwd, runner);
    issueByNumberCache.set(issueNumber, promise);
    return promise;
  };

  return Promise.all(
    assignments.map(async (assignment) => {
      const { branchAheadCount, pr } = await resolveBranchProgress(assignment.branch);
      const resolvedPr =
        pr == null && assignment.prNumber != null
          ? await resolvePullRequestByNumber(assignment.prNumber)
          : pr;
      const issueState = normalizeIssueState(await resolveIssueByNumber(assignment.issueNumber));
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
        issueState,
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

function getVisibleTaskAssignmentReportEntries<
  T extends Pick<
    TaskAssignmentInfo,
    "agentId" | "issueNumber" | "branch" | "status" | "prNumber"
  > & {
    issueState?: ResolvedTaskAssignment["issueState"];
  },
>(assignments: T[]): T[] {
  return assignments.filter((assignment) => assignment.issueState !== "CLOSED");
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
  cycleStartedAt?: string,
): string | null {
  const visibleAssignments = getVisibleTaskAssignmentReportEntries(assignments);
  if (visibleAssignments.length === 0) {
    return null;
  }

  const grouped = new Map<
    string,
    Array<Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "branch" | "status" | "prNumber">>
  >();
  for (const assignment of visibleAssignments) {
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

  const header = cycleStartedAt
    ? ["RALPH LOOP — WORKER STATUS:", `Timestamp: ${cycleStartedAt}`]
    : ["RALPH LOOP — WORKER STATUS:"];
  return [...header, ...lines].join("\n");
}

export interface PendingTaskAssignmentReport {
  message: string;
  signature: string;
}

export function getPendingTaskAssignmentReport(
  assignments: Array<
    Pick<TaskAssignmentInfo, "agentId" | "issueNumber" | "branch" | "status" | "prNumber">
  >,
  agentsById: ReadonlyMap<string, Pick<AgentInfo, "emoji" | "name">>,
  lastDeliveredSignature: string,
  cycleStartedAt?: string,
): PendingTaskAssignmentReport | null {
  const signature = buildTaskAssignmentReport(assignments, agentsById);
  if (!signature || signature === lastDeliveredSignature) {
    return null;
  }

  const message = buildTaskAssignmentReport(assignments, agentsById, cycleStartedAt);
  if (!message) {
    return null;
  }

  return { message, signature };
}
