import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecFileResult = { stdout?: string | Buffer };
export type ExecFileAsyncLike = (
  file: string,
  args: string[],
  options: { cwd: string; encoding: "utf-8" },
) => Promise<ExecFileResult>;

export interface GitContext {
  cwd: string;
  repo: string;
  /** Canonical repository root (main checkout root when inside a linked worktree) */
  repoRoot?: string;
  /** Current checkout root (`git rev-parse --show-toplevel`) */
  worktreePath?: string;
  /** `main` for the primary checkout, `linked` for a linked worktree */
  worktreeKind?: "main" | "linked";
  branch?: string;
}

async function runGitCommand(
  args: string[],
  cwd: string,
  runner: ExecFileAsyncLike,
): Promise<string | undefined> {
  try {
    const result = await runner("git", args, { cwd, encoding: "utf-8" });
    const stdout = typeof result.stdout === "string" ? result.stdout : result.stdout?.toString();
    const trimmed = stdout?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function probeGitBranch(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<string | undefined> {
  return runGitCommand(["branch", "--show-current"], cwd, runner);
}

export async function probeGitContext(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<GitContext> {
  const worktreePath = await runGitCommand(["rev-parse", "--show-toplevel"], cwd, runner);
  const branch = await probeGitBranch(cwd, runner);
  const gitDir = await runGitCommand(["rev-parse", "--absolute-git-dir"], cwd, runner);
  const commonDirRaw = await runGitCommand(["rev-parse", "--git-common-dir"], cwd, runner);
  const resolvedBase = worktreePath ?? cwd;
  const commonDir = commonDirRaw ? path.resolve(resolvedBase, commonDirRaw) : undefined;
  const repoRoot =
    commonDir && path.basename(commonDir) === ".git" ? path.dirname(commonDir) : worktreePath;
  const worktreeKind =
    worktreePath && gitDir && commonDir
      ? path.resolve(gitDir) === path.resolve(commonDir)
        ? "main"
        : "linked"
      : undefined;
  const resolvedRepoRoot = repoRoot ?? worktreePath ?? cwd;

  return {
    cwd,
    repo: path.basename(resolvedRepoRoot),
    repoRoot,
    worktreePath,
    worktreeKind,
    branch,
  };
}

export interface GitContextCache {
  get(): Promise<GitContext>;
  peek(): GitContext | null;
  clear(): void;
}

export function createGitContextCache(loader: () => Promise<GitContext>): GitContextCache {
  let cached: GitContext | null = null;
  let inflight: Promise<GitContext> | null = null;

  return {
    async get(): Promise<GitContext> {
      if (cached) return cached;
      if (inflight) return inflight;

      inflight = loader()
        .then((result) => {
          cached = result;
          return result;
        })
        .finally(() => {
          inflight = null;
        });

      return inflight;
    },

    peek(): GitContext | null {
      return cached;
    },

    clear(): void {
      cached = null;
      inflight = null;
    },
  };
}
