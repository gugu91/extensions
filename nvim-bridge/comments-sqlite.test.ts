import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteCommentStore } from "./comments-sqlite.js";

describe("SqliteCommentStore", () => {
  let repoRoot: string;
  let store: SqliteCommentStore | null;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nvim-sqlite-test-"));
    store = null;
  });

  afterEach(() => {
    store?.close();
    store = null;
    vi.useRealTimers();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("stores comments in sqlite with contextual thread ids and summaries", async () => {
    store = new SqliteCommentStore(repoRoot);
    store.initialize();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const first = await store.addComment({
      body: "First sqlite note",
      actorId: "reviewer",
      context: { file: "src/app.ts", startLine: 4, endLine: 6 },
    });

    vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));

    const second = await store.addComment({
      body: "Second sqlite note",
      actorId: "reviewer",
      context: { file: "src/app.ts", startLine: 4, endLine: 6 },
    });

    const listed = store.listComments({ threadId: first.threadId, limit: 1 });
    expect(listed.total).toBe(2);
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0]?.body).toBe("Second sqlite note");
    expect(store.getThreadSummary(first.threadId)).toEqual({
      threadId: first.threadId,
      total: 2,
      latestId: second.id,
    });
  });

  it("migrates existing JSON comments into sqlite on initialize", () => {
    const legacyDir = path.join(repoRoot, ".pi", "a2a", "comments");
    const itemsDir = path.join(legacyDir, "items");
    fs.mkdirSync(itemsDir, { recursive: true });

    fs.writeFileSync(path.join(itemsDir, "legacy-1.md"), "Migrated body\n", "utf-8");
    fs.writeFileSync(
      path.join(legacyDir, "index.json"),
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: "2024-01-01T00:00:00.000Z",
          comments: [
            {
              id: "legacy-1",
              threadId: "legacy-thread",
              actorType: "human",
              actorId: "alice",
              createdAt: "2024-01-01T00:00:00.000Z",
              bodyPath: "items/legacy-1.md",
              context: {
                file: "src/legacy.ts",
                startLine: 10,
                endLine: 12,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    store = new SqliteCommentStore(repoRoot);
    store.initialize();

    const listed = store.listComments({ threadId: "legacy-thread" });
    expect(listed.total).toBe(1);
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0]).toMatchObject({
      id: "legacy-1",
      threadId: "legacy-thread",
      actorType: "human",
      actorId: "alice",
      body: "Migrated body",
      bodyPath: "items/legacy-1.md",
      context: {
        file: "src/legacy.ts",
        startLine: 10,
        endLine: 12,
      },
    });
    expect(fs.existsSync(path.join(repoRoot, ".pi", "picomms.db"))).toBe(true);
  });

  it("wipes all comments from sqlite", async () => {
    store = new SqliteCommentStore(repoRoot);
    store.initialize();

    await store.addComment({
      body: "Delete me",
      actorId: "reviewer",
      threadId: "cleanup",
    });

    const result = await store.wipeAllComments();
    expect(result).toEqual({ removed: 1, remaining: 0 });
    expect(store.listAllComments()).toEqual({ total: 0, comments: [] });
  });
});
