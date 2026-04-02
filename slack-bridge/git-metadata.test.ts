import { describe, it, expect, vi } from "vitest";
import { createGitContextCache, probeGitContext, type ExecFileAsyncLike } from "./git-metadata.js";

describe("probeGitContext", () => {
  it("returns repo, repoRoot, and branch when git commands succeed", async () => {
    const runner: ExecFileAsyncLike = vi.fn(async (_file, args) => {
      if (args[0] === "rev-parse") {
        return { stdout: "/Users/alice/src/extensions\n" };
      }
      if (args[0] === "branch") {
        return { stdout: "main\n" };
      }
      throw new Error("unexpected command");
    });

    await expect(
      probeGitContext("/Users/alice/src/extensions/slack-bridge", runner),
    ).resolves.toEqual({
      cwd: "/Users/alice/src/extensions/slack-bridge",
      repo: "extensions",
      repoRoot: "/Users/alice/src/extensions",
      branch: "main",
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
