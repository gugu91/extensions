import { describe, expect, it } from "vitest";
import {
  buildContextualThreadMetadata,
  formatAnchorForMessage,
  hasSameCodeRevision,
  parseContextualThreadMetadata,
  updateContextualThreadResolvedState,
  type ContextJsonValue,
} from "./code-anchor.js";

describe("contextual thread metadata", () => {
  it("builds and parses a revision-aware code anchor", () => {
    const metadata = buildContextualThreadMetadata({
      repository: "/repo",
      worktree: "/repo/.worktrees/feature",
      path: "src/app.ts",
      headOid: "head",
      baseOid: "base",
      blobOid: "blob",
      side: "new",
      startLine: 12,
      endLine: 14,
      selectedText: "const x = 1;",
      contextText: "context",
    });

    expect(parseContextualThreadMetadata(metadata as ContextJsonValue)).toEqual(metadata);
    expect(metadata.codeAnchor.selectedTextSha256).toHaveLength(64);
    expect(formatAnchorForMessage(metadata)).toBe(
      "[code-anchor src/app.ts:12-14 side=new head=head blob=blob base=base]",
    );
    expect(hasSameCodeRevision(metadata.codeAnchor, metadata.codeAnchor)).toBe(true);
    expect(
      hasSameCodeRevision(metadata.codeAnchor, { ...metadata.codeAnchor, blobOid: "changed" }),
    ).toBe(false);
  });

  it("stores resolution state in ordinary thread metadata", () => {
    const metadata = buildContextualThreadMetadata({
      repository: "/repo",
      worktree: "/repo",
      path: "src/app.ts",
      headOid: "head",
      blobOid: "blob",
      side: "old",
      startLine: 1,
    });

    expect(
      updateContextualThreadResolvedState(metadata, true, "nvim", "2026-01-01T00:00:00.000Z").state,
    ).toEqual({ resolved: true, resolvedAt: "2026-01-01T00:00:00.000Z", resolvedBy: "nvim" });
  });
});
