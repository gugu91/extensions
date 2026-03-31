import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ICommentStore,
  CommentAddInput,
  CommentListInput,
  CommentListResult,
  CommentListAllInput,
  CommentListAllResult,
  CommentWipeResult,
  CommentRecord,
  CommentActorType,
  CommentContext,
} from "./comments.js";
import {
  normalizeThreadId,
  normalizeActorType,
  normalizeActorId,
  normalizeContext,
  normalizeLimit,
  resolveThreadId,
  createCommentId,
} from "./comments.js";

interface CommentRow {
  id: string;
  thread_id: string;
  actor_type: string;
  actor_id: string;
  created_at: string;
  body: string;
  body_path: string;
  context_file: string | null;
  context_start_line: number | null;
  context_end_line: number | null;
}

interface CountRow {
  cnt: number;
}

interface IdRow {
  id: string;
}

function rowToCommentRecord(row: CommentRow): CommentRecord {
  const context: CommentContext | undefined =
    row.context_file != null
      ? {
          file: row.context_file,
          ...(row.context_start_line != null ? { startLine: row.context_start_line } : {}),
          ...(row.context_end_line != null ? { endLine: row.context_end_line } : {}),
        }
      : undefined;

  return {
    id: row.id,
    threadId: row.thread_id,
    actorType: row.actor_type as CommentActorType,
    actorId: row.actor_id,
    createdAt: row.created_at,
    context,
    bodyPath: row.body_path,
    body: row.body,
  };
}

export class SqliteCommentStore implements ICommentStore {
  private readonly dbPath: string;
  private readonly legacyDir: string;
  private db: DatabaseSync | null = null;

  constructor(repoRoot: string) {
    this.dbPath = path.join(repoRoot, ".pi", "picomms.db");
    this.legacyDir = path.join(repoRoot, ".pi", "a2a", "comments");
  }

  initialize(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });

    this.db.exec("PRAGMA journal_mode=WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY NOT NULL,
        thread_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        body TEXT NOT NULL,
        body_path TEXT NOT NULL,
        context_file TEXT,
        context_start_line INTEGER,
        context_end_line INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_comments_thread_created
        ON comments(thread_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_comments_created
        ON comments(created_at, id);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT
      );
    `);

    this.migrateFromJson();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async addComment(input: CommentAddInput): Promise<CommentRecord> {
    const db = this.getDb();

    const body = input.body.trim();
    if (!body) {
      throw new Error("Comment body cannot be empty");
    }

    const context = normalizeContext(input.context);
    const threadId = resolveThreadId(input.threadId, context);
    const actorType = normalizeActorType(input.actorType);
    const actorId = normalizeActorId(input.actorId, actorType);
    const createdAt = new Date().toISOString();
    const id = createCommentId();
    const bodyPath = path.posix.join("items", `${id}.md`);

    db.prepare(
      `INSERT INTO comments
         (id, thread_id, actor_type, actor_id, created_at, body, body_path,
          context_file, context_start_line, context_end_line)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      threadId,
      actorType,
      actorId,
      createdAt,
      body,
      bodyPath,
      context?.file ?? null,
      context?.startLine ?? null,
      context?.endLine ?? null,
    );

    return {
      id,
      threadId,
      actorType,
      actorId,
      createdAt,
      context,
      bodyPath,
      body,
    };
  }

  listComments(input: CommentListInput = {}): CommentListResult {
    const db = this.getDb();
    const threadId = normalizeThreadId(input.threadId);
    const limit = normalizeLimit(input.limit);

    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM comments WHERE thread_id = ?")
      .get(threadId) as unknown as CountRow;
    const total = countRow.cnt;

    let rows: CommentRow[];
    if (limit != null) {
      rows = db
        .prepare(
          `SELECT * FROM (
            SELECT * FROM comments WHERE thread_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?
          ) ORDER BY created_at ASC, id ASC`,
        )
        .all(threadId, limit) as unknown as CommentRow[];
    } else {
      rows = db
        .prepare("SELECT * FROM comments WHERE thread_id = ? ORDER BY created_at ASC, id ASC")
        .all(threadId) as unknown as CommentRow[];
    }

    return {
      threadId,
      total,
      comments: rows.map(rowToCommentRecord),
    };
  }

  listAllComments(input: CommentListAllInput = {}): CommentListAllResult {
    const db = this.getDb();
    const limit = normalizeLimit(input.limit);

    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM comments")
      .get() as unknown as CountRow;
    const total = countRow.cnt;

    let rows: CommentRow[];
    if (limit != null) {
      rows = db
        .prepare(
          `SELECT * FROM (
            SELECT * FROM comments ORDER BY created_at DESC, id DESC LIMIT ?
          ) ORDER BY created_at ASC, id ASC`,
        )
        .all(limit) as unknown as CommentRow[];
    } else {
      rows = db
        .prepare("SELECT * FROM comments ORDER BY created_at ASC, id ASC")
        .all() as unknown as CommentRow[];
    }

    return {
      total,
      comments: rows.map(rowToCommentRecord),
    };
  }

  async wipeAllComments(): Promise<CommentWipeResult> {
    const db = this.getDb();

    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM comments")
      .get() as unknown as CountRow;
    const removed = countRow.cnt;

    db.exec("DELETE FROM comments");

    return { removed, remaining: 0 };
  }

  getThreadSummary(threadId?: string): {
    threadId: string;
    total: number;
    latestId: string | null;
  } {
    const db = this.getDb();
    const normalizedThreadId = normalizeThreadId(threadId);

    const countRow = db
      .prepare("SELECT COUNT(*) as cnt FROM comments WHERE thread_id = ?")
      .get(normalizedThreadId) as unknown as CountRow;
    const total = countRow.cnt;

    const latestRow = db
      .prepare(
        "SELECT id FROM comments WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      )
      .get(normalizedThreadId) as unknown as IdRow | undefined;
    const latestId = latestRow?.id ?? null;

    return {
      threadId: normalizedThreadId,
      total,
      latestId,
    };
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    return this.db;
  }

  private migrateFromJson(): void {
    const db = this.getDb();

    const migrated = db.prepare("SELECT value FROM meta WHERE key = ?").get("migrated_from_json");
    if (migrated) return;

    const indexPath = path.join(this.legacyDir, "index.json");
    if (!fs.existsSync(indexPath)) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migrated_from_json",
        "1",
      );
      return;
    }

    try {
      const indexText = fs.readFileSync(indexPath, "utf-8");
      const index = JSON.parse(indexText) as {
        comments?: Array<{
          id?: string;
          threadId?: string;
          actorType?: string;
          actorId?: string;
          createdAt?: string;
          bodyPath?: string;
          context?: {
            file?: string;
            startLine?: number;
            endLine?: number;
          };
        }>;
      };

      if (index && Array.isArray(index.comments)) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO comments
             (id, thread_id, actor_type, actor_id, created_at, body, body_path,
              context_file, context_start_line, context_end_line)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const meta of index.comments) {
          if (!meta || typeof meta.id !== "string") continue;
          if (!meta.bodyPath) continue;

          const bodyFile = path.resolve(this.legacyDir, meta.bodyPath);
          let body: string;
          try {
            body = fs.readFileSync(bodyFile, "utf-8").replace(/\r\n/g, "\n").replace(/\n$/, "");
          } catch {
            continue;
          }

          insert.run(
            meta.id,
            meta.threadId ?? "global",
            meta.actorType ?? "agent",
            meta.actorId ?? "pi",
            meta.createdAt ?? new Date().toISOString(),
            body,
            meta.bodyPath,
            meta.context?.file ?? null,
            meta.context?.startLine ?? null,
            meta.context?.endLine ?? null,
          );
        }
      }

      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
        "migrated_from_json",
        "1",
      );
    } catch {
      // Migration failed; will retry on next initialize.
    }
  }
}
