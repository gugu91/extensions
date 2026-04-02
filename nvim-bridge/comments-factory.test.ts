import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("createCommentStore", () => {
  let repoRoot: string | null = null;

  afterEach(() => {
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      repoRoot = null;
    }
    vi.doUnmock("./comments-sqlite.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("falls back to the JSON CommentStore when sqlite initialization fails", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nvim-comment-factory-test-"));

    vi.doMock("./comments-sqlite.js", () => ({
      SqliteCommentStore: class MockSqliteCommentStore {
        initialize(): void {
          throw new Error("node:sqlite unavailable");
        }
      },
    }));

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createCommentStore, CommentStore } = await import("./comments.js");

    const store = await createCommentStore(repoRoot);
    expect(store).toBeInstanceOf(CommentStore);

    await store.addComment({
      body: "Fallback note",
      actorId: "tester",
      threadId: "fallback-thread",
    });

    expect(store.listComments({ threadId: "fallback-thread" })).toMatchObject({
      total: 1,
      comments: [{ body: "Fallback note" }],
    });
    expect(consoleError).toHaveBeenCalledWith(
      "[picomms] SQLite store init failed, falling back to JSON:",
      expect.any(Error),
    );
  });
});
