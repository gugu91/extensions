import { describe, expect, it } from "vitest";
import { buildContextualThreadMetadata } from "./code-anchor.js";
import {
  formatContextualThreadContext,
  selectOpenContextualThreads,
} from "./contextual-thread-context.js";
import type { ThreadInfo } from "./broker/types.js";

function thread(id: string, resolved = false, headOid = "head"): ThreadInfo {
  const metadata = buildContextualThreadMetadata({
    repository: "/repo",
    worktree: "/repo/worktree",
    path: "src/app.ts",
    headOid,
    baseOid: "base",
    blobOid: "blob",
    side: "new",
    startLine: 8,
  });
  metadata.state.resolved = resolved;
  return {
    threadId: id,
    source: "nvim",
    channel: "repo",
    ownerAgent: "agent-1",
    metadata,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("contextual thread hydration", () => {
  it("selects only unresolved threads for the current worktree revision", () => {
    const selected = selectOpenContextualThreads(
      [thread("open"), thread("resolved", true), thread("stale", false, "old-head")],
      {
        repository: "/repo",
        worktree: "/repo/worktree",
        headOid: "head",
        baseOid: "base",
      },
    );
    expect(selected.map((item) => item.thread.threadId)).toEqual(["open"]);
  });

  it("formats bounded message context with the generic reply operation", () => {
    const selected = selectOpenContextualThreads([thread("nvim:thread-1")], {
      repository: "/repo",
      worktree: "/repo/worktree",
      headOid: "head",
      baseOid: "base",
    });
    const text = formatContextualThreadContext(
      selected,
      new Map([["nvim:thread-1", [{ sender: "Neovim", body: "Please check this branch." }]]]),
    );
    expect(text).toContain("nvim:thread-1 — src/app.ts:8 (new)");
    expect(text).toContain("Neovim: Please check this branch.");
    expect(text).toContain("pinet action=reply");
  });
});
