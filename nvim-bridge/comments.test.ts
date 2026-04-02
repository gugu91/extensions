import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CommentStore,
  buildContextThreadId,
  normalizeContext,
  resolveThreadId,
} from "./comments.js";

describe("normalizeContext", () => {
  it("normalizes blank and reversed ranges", () => {
    expect(normalizeContext(undefined)).toBeUndefined();
    expect(normalizeContext({ file: "   " })).toBeUndefined();

    expect(
      normalizeContext({
        file: "src/app.ts",
        startLine: 20,
        endLine: 10,
      }),
    ).toEqual({
      file: "src/app.ts",
      startLine: 10,
      endLine: 20,
    });
  });

  it("fills in a missing bound from the other side", () => {
    expect(
      normalizeContext({
        file: "src/app.ts",
        endLine: 7,
      }),
    ).toEqual({
      file: "src/app.ts",
      startLine: 7,
      endLine: 7,
    });
  });
});

describe("buildContextThreadId", () => {
  it("builds a stable context thread id only for complete ranges", () => {
    expect(
      buildContextThreadId({
        file: "src/app.ts",
        startLine: 3,
        endLine: 5,
      }),
    ).toBe("ctx:src/app.ts:3-5");
    expect(buildContextThreadId({ file: "src/app.ts" })).toBeNull();
  });
});

describe("resolveThreadId", () => {
  it("prefers explicit threads, then contextual threads, then global", () => {
    expect(resolveThreadId("review-123", { file: "src/app.ts", startLine: 3, endLine: 5 })).toBe(
      "review-123",
    );
    expect(resolveThreadId(undefined, { file: "src/app.ts", startLine: 3, endLine: 5 })).toBe(
      "ctx:src/app.ts:3-5",
    );
    expect(resolveThreadId(undefined, undefined)).toBe("global");
  });
});

describe("CommentStore", () => {
  let repoRoot: string;
  let store: CommentStore | null;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nvim-comments-test-"));
    store = new CommentStore(repoRoot);
    store.initialize();
  });

  afterEach(() => {
    store?.close();
    store = null;
    vi.useRealTimers();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("stores contextual comments and returns newest-per-thread when limited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));

    const first = await store!.addComment({
      body: "First note",
      actorId: "reviewer",
      context: { file: "src/app.ts", startLine: 12 },
    });

    vi.setSystemTime(new Date("2024-01-01T00:00:01.000Z"));

    const second = await store!.addComment({
      body: "Second note",
      actorId: "reviewer",
      context: { file: "src/app.ts", startLine: 12 },
    });

    expect(first.threadId).toBe("ctx:src/app.ts:12-12");
    expect(second.threadId).toBe(first.threadId);

    const listed = store!.listComments({ threadId: first.threadId, limit: 1 });
    expect(listed.total).toBe(2);
    expect(listed.comments).toHaveLength(1);
    expect(listed.comments[0]?.body).toBe("Second note");
    expect(store!.getThreadSummary(first.threadId)).toEqual({
      threadId: first.threadId,
      total: 2,
      latestId: second.id,
    });
  });

  it("serializes concurrent writes without losing comments", async () => {
    await Promise.all([
      store!.addComment({ body: "one", actorId: "tester", threadId: "thread-a" }),
      store!.addComment({ body: "two", actorId: "tester", threadId: "thread-a" }),
      store!.addComment({ body: "three", actorId: "tester", threadId: "thread-a" }),
    ]);

    const listed = store!.listComments({ threadId: "thread-a" });
    expect(listed.total).toBe(3);
    expect(listed.comments.map((comment) => comment.body).sort()).toEqual(["one", "three", "two"]);
  });

  it("rebuilds its index from metadata when the index file is missing", async () => {
    const comment = await store!.addComment({
      body: "Needs index rebuild",
      actorId: "tester",
      context: { file: "src/app.ts", startLine: 8, endLine: 9 },
    });

    store!.close();
    fs.rmSync(path.join(repoRoot, ".pi", "a2a", "comments", "index.json"), { force: true });

    store = new CommentStore(repoRoot);
    store.initialize();

    const listed = store.listComments({ threadId: comment.threadId });
    expect(listed.total).toBe(1);
    expect(listed.comments[0]?.body).toBe("Needs index rebuild");
    expect(listed.comments[0]?.context).toEqual({
      file: "src/app.ts",
      startLine: 8,
      endLine: 9,
    });
  });

  it("wipes all comments and recreates an empty store layout", async () => {
    await store!.addComment({ body: "To be removed", actorId: "tester", threadId: "cleanup" });

    const result = await store!.wipeAllComments();

    expect(result).toEqual({ removed: 1, remaining: 0 });
    expect(store!.listAllComments()).toEqual({ total: 0, comments: [] });
    expect(fs.existsSync(path.join(repoRoot, ".pi", "a2a", "comments", "index.json"))).toBe(true);
  });
});
