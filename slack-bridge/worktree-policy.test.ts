import { describe, expect, it } from "vitest";
import {
  buildMainCheckoutBranchSwitchBlockReason,
  buildMainCheckoutEditBlockReason,
  containsGitBranchSwitch,
  getMainCheckoutToolBlockReason,
} from "./worktree-policy.js";

describe("containsGitBranchSwitch", () => {
  it("detects git checkout commands", () => {
    expect(containsGitBranchSwitch("git checkout feat/foo")).toBe(true);
  });

  it("detects git switch commands in compound bash", () => {
    expect(containsGitBranchSwitch("pwd && git switch feat/foo")).toBe(true);
  });

  it("ignores non-switch commands", () => {
    expect(containsGitBranchSwitch("git status && pnpm test")).toBe(false);
  });
});

describe("main checkout block reasons", () => {
  it("builds an edit/write refusal that points agents to worktrees", () => {
    const reason = buildMainCheckoutEditBlockReason();
    expect(reason).toContain("Refusing to modify files from the main checkout");
    expect(reason).toContain("git worktree add .worktrees/<name> -b <branch>");
  });

  it("mentions drift when the main checkout is already off main", () => {
    const reason = buildMainCheckoutBranchSwitchBlockReason("feat/not-main");
    expect(reason).toContain("currently on `feat/not-main`, expected `main`");
  });
});

describe("getMainCheckoutToolBlockReason", () => {
  it("blocks editing files in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "edit",
        { path: "slack-bridge/index.ts" },
        {
          worktreeKind: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("git worktree add .worktrees/<name> -b <branch>");
  });

  it("allows editing files inside linked worktrees even when launched from the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "edit",
        { path: ".worktrees/feat-87/slack-bridge/index.ts" },
        {
          worktreeKind: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("blocks git branch switching in bash from the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "git switch feat/work" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to run `git checkout` or `git switch` in the main checkout");
  });

  it("allows branch switching after cd into a linked worktree", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "cd .worktrees/feat-87 && git switch feat/next" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("allows branch switching with git -C into a linked worktree", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "git -C .worktrees/feat-87 switch feat/next" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("allows ordinary bash tooling after cd into a linked worktree", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        {
          command:
            "git worktree add .worktrees/feat-87 -b feat/87 && cd .worktrees/feat-87 && pnpm lint && pnpm test",
        },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("resolves .worktrees paths against repoRoot when cwd is nested", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "edit",
        { path: ".worktrees/feat-87/slack-bridge/index.ts" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions/slack-bridge",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("allows cd into a linked worktree from a nested repo cwd", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "cd .worktrees/feat-87 && pnpm test" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions/slack-bridge",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("blocks obvious shell mutations in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "echo hello > slack-bridge/index.ts" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks interpreter-based writes in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "node -e \"require('node:fs').writeFileSync('foo.ts', 'x')\"" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks non-redirection writers in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "dd if=/dev/null of=foo.ts" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("allows git worktree management commands in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "git worktree add .worktrees/feat-87 -b feat/87" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("blocks worktree-targeted shell commands that can escape back into the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "cd .worktrees/feat-87 && rm -rf ../../slack-bridge" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks worktree-targeted git commands that redirect work-tree back to main", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        {
          command:
            "cd .worktrees/feat-87 && git --work-tree=../.. --git-dir=../../.git checkout -- slack-bridge/index.ts",
        },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks git -C worktree commands that override git-dir back to main", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        {
          command:
            "git -C .worktrees/feat-87 --git-dir=../../.git --work-tree=../.. clean -fd slack-bridge",
        },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks explicit path escapes from a linked worktree via embedded script strings", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        {
          command:
            "cd .worktrees/feat-87 && node -e \"require('node:fs').writeFileSync('../../slack-bridge/index.ts', 'x')\"",
        },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("blocks absolute main-checkout paths embedded inside interpreter strings", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        {
          command:
            "cd .worktrees/feat-87 && node -e \"require('node:fs').writeFileSync('/Users/alice/src/extensions/slack-bridge/index.ts', 'x')\"",
        },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toContain("Refusing to modify files from the main checkout");
  });

  it("allows safe bash inspection commands in the main checkout", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "bash",
        { command: "git status && rg worktree slack-bridge" },
        {
          worktreeKind: "main",
          branch: "main",
          cwd: "/Users/alice/src/extensions",
          repoRoot: "/Users/alice/src/extensions",
        },
      ),
    ).toBeNull();
  });

  it("allows edit/write tools in linked worktrees", () => {
    expect(
      getMainCheckoutToolBlockReason(
        "write",
        { path: "foo.ts", content: "x" },
        { worktreeKind: "linked" },
      ),
    ).toBeNull();
  });
});
