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
  repoRoot?: string;
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

export async function probeGitContext(
  cwd = process.cwd(),
  runner: ExecFileAsyncLike = execFileAsync as ExecFileAsyncLike,
): Promise<GitContext> {
  const repoRoot = await runGitCommand(["rev-parse", "--show-toplevel"], cwd, runner);
  const branch = await runGitCommand(["branch", "--show-current"], cwd, runner);
  const resolvedRepoRoot = repoRoot ?? cwd;

  return {
    cwd,
    repo: path.basename(resolvedRepoRoot),
    repoRoot,
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
