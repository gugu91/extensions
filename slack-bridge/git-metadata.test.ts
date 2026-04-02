import { describe, it, expect, vi } from "vitest";
import {
  createGitContextCache,
  probeGitBranch,
  probeGitContext,
  type ExecFileAsyncLike,
} from "./git-metadata.js";

describe("probeGitBranch", () => {
  it("returns the live branch when git succeeds", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => ({ stdout: "main\n" }));

    await expect(probeGitBranch("/Users/alice/src/extensions", runner)).resolves.toBe("main");
  });

  it("returns undefined when branch lookup fails", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => {
      throw new Error("not a git repo");
    });

    await expect(probeGitBranch("/tmp/scratch", runner)).resolves.toBeUndefined();
  });
});

describe("probeGitContext", () => {
  it("returns canonical repo metadata for the main checkout", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/Users/alice/src/extensions\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
        return { stdout: "/Users/alice/src/extensions/.git\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return { stdout: ".git\n" };
      }
      if (args[0] === "branch") {
        return { stdout: "main\n" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    await expect(
      probeGitContext("/Users/alice/src/extensions/slack-bridge", runner),
    ).resolves.toEqual({
      cwd: "/Users/alice/src/extensions/slack-bridge",
      repo: "extensions",
      repoRoot: "/Users/alice/src/extensions",
      worktreePath: "/Users/alice/src/extensions",
      worktreeKind: "main",
      branch: "main",
    });
  });

  it("keeps the canonical repo name when running from a linked worktree", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        return { stdout: "/Users/alice/src/extensions/.worktrees/feat-87\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
        return { stdout: "/Users/alice/src/extensions/.git/worktrees/feat-87\n" };
      }
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
        return { stdout: "/Users/alice/src/extensions/.git\n" };
      }
      if (args[0] === "branch") {
        return { stdout: "feat/enforce-worktree-rule\n" };
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    await expect(
      probeGitContext("/Users/alice/src/extensions/.worktrees/feat-87/slack-bridge", runner),
    ).resolves.toEqual({
      cwd: "/Users/alice/src/extensions/.worktrees/feat-87/slack-bridge",
      repo: "extensions",
      repoRoot: "/Users/alice/src/extensions",
      worktreePath: "/Users/alice/src/extensions/.worktrees/feat-87",
      worktreeKind: "linked",
      branch: "feat/enforce-worktree-rule",
    });
  });

  it("falls back to cwd basename when not in a git repo", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async () => {
      throw new Error("not a git repo");
    });

    await expect(probeGitContext("/tmp/scratch", runner)).resolves.toEqual({
      cwd: "/tmp/scratch",
      repo: "scratch",
      repoRoot: undefined,
      worktreePath: undefined,
      worktreeKind: undefined,
      branch: undefined,
    });
  });

  it("treats blank git output as undefined", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "\n" };
      }
      return { stdout: "   \n" };
    });

    await expect(probeGitContext("/tmp/scratch", runner)).resolves.toEqual({
      cwd: "/tmp/scratch",
      repo: "scratch",
      repoRoot: undefined,
      worktreePath: undefined,
      worktreeKind: undefined,
      branch: undefined,
    });
  });
});

describe("createGitContextCache", () => {
  it("caches the loaded result", async () => {
    const loader = vi.fn(async () => ({
      cwd: "/tmp/project",
      repo: "project",
      repoRoot: "/tmp/project",
      worktreePath: "/tmp/project",
      worktreeKind: "main" as const,
      branch: "main",
    }));

    const cache = createGitContextCache(loader);

    await expect(cache.get()).resolves.toMatchObject({ repo: "project" });
    await expect(cache.get()).resolves.toMatchObject({ repo: "project" });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.peek()).toMatchObject({ repo: "project" });
  });

  it("shares a single in-flight request", async () => {
    let resolveLoader!: (value: { cwd: string; repo: string }) => void;
    const promise = new Promise<{ cwd: string; repo: string }>((resolve) => {
      resolveLoader = resolve;
    });
    const loader = vi.fn(() => promise);

    const cache = createGitContextCache(loader);
    const a = cache.get();
    const b = cache.get();

    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoader({ cwd: "/tmp/project", repo: "project" });

    await expect(a).resolves.toMatchObject({ repo: "project" });
    await expect(b).resolves.toMatchObject({ repo: "project" });
  });

  it("clear resets the cache", async () => {
    const loader = vi.fn(async () => ({ cwd: "/tmp/a", repo: "a" }));
    loader.mockResolvedValueOnce({ cwd: "/tmp/a", repo: "a" });
    loader.mockResolvedValueOnce({ cwd: "/tmp/b", repo: "b" });

    const cache = createGitContextCache(loader);
    await cache.get();
    cache.clear();
    await expect(cache.get()).resolves.toMatchObject({ repo: "b" });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
