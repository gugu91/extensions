import * as path from "node:path";

export type CheckoutKind = "main" | "linked";

export interface WorktreePolicyContext {
  worktreeKind?: CheckoutKind;
  branch?: string;
  cwd?: string;
  repoRoot?: string;
}

const WORKTREE_SETUP_COMMAND =
  "git worktree add .worktrees/<name> -b <branch> && cd .worktrees/<name>";
const GIT_BRANCH_SWITCH_RE =
  /(^|[\n;&|]\s*)git\s+(?:(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)|(?:-[^\s]+\s+))*?(checkout|switch)\b/m;
const GIT_WORKTREE_COMMAND_RE = /^git\s+worktree\s+(add|remove|list|prune)\b/;
const GIT_PATH_REDIRECTION_RE =
  /(^|\s)(--work-tree|--git-dir)=?\S*|(^|\s)(GIT_WORK_TREE|GIT_DIR)=\S+/;
const MAIN_CHECKOUT_READ_ONLY_RES = [
  /^pwd$/,
  /^ls\b/,
  /^find\b/,
  /^rg\b/,
  /^grep\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^sort\b/,
  /^cut\b/,
  /^awk\b/,
  /^sed\b(?!.*\s-i\b)/,
  /^(test|\[)\b/,
  /^(basename|dirname|realpath|readlink|stat)\b/,
  /^git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?(status|log|diff|show|branch\b|rev-parse|ls-files|remote\b|worktree\s+list)\b/,
];

function describeMainCheckout(branch?: string): string {
  if (branch && branch !== "main") {
    return ` The main checkout is currently on \`${branch}\`, expected \`main\`.`;
  }
  return " The main checkout must stay on `main`.";
}

export function containsGitBranchSwitch(command: string): boolean {
  return GIT_BRANCH_SWITCH_RE.test(command);
}

export function buildMainCheckoutEditBlockReason(branch?: string): string {
  return [
    `Refusing to modify files from the main checkout.${describeMainCheckout(branch)}`,
    `Feature work must happen in a git worktree. Create one first: \`${WORKTREE_SETUP_COMMAND}\`.`,
  ].join(" ");
}

export function buildMainCheckoutBranchSwitchBlockReason(branch?: string): string {
  return [
    `Refusing to run \`git checkout\` or \`git switch\` in the main checkout.${describeMainCheckout(branch)}`,
    `Create or enter a linked worktree instead: \`${WORKTREE_SETUP_COMMAND}\`.`,
  ].join(" ");
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function extractCdTarget(segment: string): string | null {
  const match = /^cd\s+(.+)$/.exec(segment.trim());
  return match?.[1] ? stripQuotes(match[1]) : null;
}

function extractGitCTarget(segment: string): string | null {
  const match = /^git\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+/.exec(segment.trim());
  return match?.[1] ? stripQuotes(match[1]) : null;
}

function getPolicyRoot(context: WorktreePolicyContext): string {
  return path.resolve(context.repoRoot ?? context.cwd ?? process.cwd());
}

function isRepoRootRelativeWorktreePath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  return (
    normalized === ".worktrees" ||
    normalized.startsWith(".worktrees/") ||
    normalized === "./.worktrees" ||
    normalized.startsWith("./.worktrees/")
  );
}

function resolvePolicyPath(
  candidate: string,
  baseDir: string,
  context: WorktreePolicyContext,
): string {
  const trimmed = stripQuotes(candidate.trim());
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  if (isRepoRootRelativeWorktreePath(trimmed)) {
    const repoRelative = trimmed.replace(/^\.\//, "");
    return path.resolve(getPolicyRoot(context), repoRelative);
  }
  return path.resolve(baseDir, trimmed);
}

function resolveToolPath(
  input: unknown,
  context: WorktreePolicyContext,
  cwd = process.cwd(),
): string | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = (input as { path?: unknown }).path;
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  return resolvePolicyPath(candidate, cwd, context);
}

function getLinkedWorktreeRoot(
  targetPath: string | null,
  context: WorktreePolicyContext,
): string | null {
  if (!targetPath) return null;
  const worktreesDir = path.join(getPolicyRoot(context), ".worktrees");
  if (!isPathInside(worktreesDir, targetPath)) {
    return null;
  }
  const relative = path.relative(worktreesDir, targetPath);
  const [worktreeName] = relative.split(path.sep);
  if (!worktreeName) {
    return null;
  }
  return path.join(worktreesDir, worktreeName);
}

function isLinkedWorktreePath(targetPath: string | null, context: WorktreePolicyContext): boolean {
  return getLinkedWorktreeRoot(targetPath, context) != null;
}

function isAllowedMainCheckoutSegment(segment: string): boolean {
  return MAIN_CHECKOUT_READ_ONLY_RES.some((pattern) => pattern.test(segment));
}

function containsGitPathRedirection(segment: string): boolean {
  return GIT_PATH_REDIRECTION_RE.test(segment);
}

function extractPathCandidates(segment: string): string[] {
  const candidates = new Set<string>();
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  for (const token of tokens) {
    const stripped = stripQuotes(token);
    const values = [stripped];
    const equalsIndex = stripped.indexOf("=");
    if (equalsIndex > 0 && equalsIndex < stripped.length - 1) {
      values.push(stripQuotes(stripped.slice(equalsIndex + 1)));
    }

    for (const value of values) {
      if (!value) continue;
      if (path.isAbsolute(value) || isRepoRootRelativeWorktreePath(value)) {
        candidates.add(value);
      }
      for (const match of value.matchAll(/(?:\.\.?)(?:[\\/][^'"`\s),]+)+/g)) {
        candidates.add(match[0]);
      }
      for (const match of value.matchAll(/(?:\/[^'"`\s),]+)+/g)) {
        candidates.add(match[0]);
      }
      for (const match of value.matchAll(/[A-Za-z]:\\[^'"`\s),]+(?:\\[^'"`\s),]+)*/g)) {
        candidates.add(match[0]);
      }
    }
  }

  return [...candidates];
}

function containsWorktreeEscape(
  segment: string,
  effectiveDir: string,
  linkedWorktreeRoot: string,
  context: WorktreePolicyContext,
): boolean {
  const repoRoot = getPolicyRoot(context);
  return extractPathCandidates(segment).some((candidate) => {
    const resolved = resolvePolicyPath(candidate, effectiveDir, context);
    return isPathInside(repoRoot, resolved) && !isPathInside(linkedWorktreeRoot, resolved);
  });
}

function getMainCheckoutBashBlockReason(
  command: string,
  context: WorktreePolicyContext,
): string | null {
  let currentDir = path.resolve(context.cwd ?? context.repoRoot ?? process.cwd());

  for (const segment of splitShellSegments(command)) {
    const cdTarget = extractCdTarget(segment);
    if (cdTarget) {
      currentDir = resolvePolicyPath(cdTarget, currentDir, context);
      continue;
    }

    const effectiveDir = resolvePolicyPath(extractGitCTarget(segment) ?? ".", currentDir, context);
    const linkedWorktreeRoot = getLinkedWorktreeRoot(effectiveDir, context);

    if (containsGitPathRedirection(segment)) {
      return buildMainCheckoutEditBlockReason(context.branch);
    }

    if (linkedWorktreeRoot) {
      if (containsWorktreeEscape(segment, effectiveDir, linkedWorktreeRoot, context)) {
        return buildMainCheckoutEditBlockReason(context.branch);
      }
      continue;
    }

    if (containsGitBranchSwitch(segment)) {
      return buildMainCheckoutBranchSwitchBlockReason(context.branch);
    }

    if (GIT_WORKTREE_COMMAND_RE.test(segment) || isAllowedMainCheckoutSegment(segment)) {
      continue;
    }

    return buildMainCheckoutEditBlockReason(context.branch);
  }

  return null;
}

export function getMainCheckoutToolBlockReason(
  toolName: string,
  input: unknown,
  context: WorktreePolicyContext,
): string | null {
  if (context.worktreeKind !== "main") {
    return null;
  }

  if (toolName === "edit" || toolName === "write") {
    if (isLinkedWorktreePath(resolveToolPath(input, context, context.cwd), context)) {
      return null;
    }
    return buildMainCheckoutEditBlockReason(context.branch);
  }

  if (
    toolName === "bash" &&
    typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
  ) {
    return getMainCheckoutBashBlockReason((input as { command: string }).command, context);
  }

  return null;
}
