import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type CommentActorType = "human" | "agent";

export interface CommentContext {
  file: string;
  startLine?: number;
  endLine?: number;
}

export interface CommentMeta {
  id: string;
  threadId: string;
  actorType: CommentActorType;
  actorId: string;
  createdAt: string;
  context?: CommentContext;
  bodyPath: string;
}

export interface CommentRecord extends CommentMeta {
  body: string;
}

interface CommentIndex {
  version: 1;
  updatedAt: string;
  comments: CommentMeta[];
}

export interface CommentAddInput {
  body: string;
  threadId?: string;
  actorType?: string;
  actorId?: string;
  context?: {
    file?: string;
    startLine?: number;
    endLine?: number;
  } | null;
}

export interface CommentListInput {
  threadId?: string;
  limit?: number;
}

export interface CommentListResult {
  threadId: string;
  total: number;
  comments: CommentRecord[];
}

export interface CommentListAllInput {
  limit?: number;
}

export interface CommentListAllResult {
  total: number;
  comments: CommentRecord[];
}

export interface CommentWipeResult {
  removed: number;
  remaining: number;
}

const INDEX_VERSION = 1 as const;
const DEFAULT_THREAD_ID = "global";
const MAX_LIMIT = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeThreadId(threadId: string | undefined): string {
  const trimmed = threadId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_THREAD_ID;
}

function normalizeActorType(actorType: string | undefined): CommentActorType {
  return actorType === "human" ? "human" : "agent";
}

function normalizeActorId(actorId: string | undefined, actorType: CommentActorType): string {
  const trimmed = actorId?.trim();
  if (trimmed && trimmed.length > 0) return trimmed;
  if (actorType === "human") {
    const user = process.env.USER?.trim();
    return user && user.length > 0 ? user : "human";
  }
  return "pi";
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  if (int <= 0) return undefined;
  return int;
}

function normalizeContext(
  context:
    | {
        file?: string;
        startLine?: number;
        endLine?: number;
      }
    | null
    | undefined,
): CommentContext | undefined {
  if (!context?.file) return undefined;

  const file = context.file.trim();
  if (!file) return undefined;

  let startLine = normalizePositiveInteger(context.startLine);
  let endLine = normalizePositiveInteger(context.endLine);

  if (startLine != null && endLine == null) endLine = startLine;
  if (startLine == null && endLine != null) startLine = endLine;

  if (startLine != null && endLine != null && startLine > endLine) {
    [startLine, endLine] = [endLine, startLine];
  }

  const normalized: CommentContext = { file };
  if (startLine != null) normalized.startLine = startLine;
  if (endLine != null) normalized.endLine = endLine;
  return normalized;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit == null) return undefined;
  if (!Number.isFinite(limit)) return undefined;
  const int = Math.floor(limit);
  if (int <= 0) return undefined;
  return Math.min(int, MAX_LIMIT);
}

function compareComments(a: CommentMeta, b: CommentMeta): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return a.id.localeCompare(b.id);
}

function createCommentId(): string {
  const time = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const random = crypto.randomBytes(4).toString("hex");
  return `c_${time}_${random}`;
}

function isSafeRelativePath(filePath: string): boolean {
  if (path.isAbsolute(filePath)) return false;
  const normalized = path.normalize(filePath);
  return !normalized.startsWith("..") && !normalized.includes(`${path.sep}..${path.sep}`);
}

export class CommentStore {
  private readonly baseDir: string;
  private readonly indexPath: string;
  private readonly itemsDir: string;
  private readonly metaDir: string;
  private indexCache: CommentIndex | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(repoRoot: string) {
    this.baseDir = path.join(repoRoot, ".pi", "a2a", "comments");
    this.indexPath = path.join(this.baseDir, "index.json");
    this.itemsDir = path.join(this.baseDir, "items");
    this.metaDir = path.join(this.baseDir, "meta");
  }

  initialize(): void {
    this.ensureLayout();
    this.indexCache = this.loadIndexOrRebuild();
  }

  getThreadSummary(threadId?: string): {
    threadId: string;
    total: number;
    latestId: string | null;
  } {
    const normalizedThreadId = normalizeThreadId(threadId);
    const comments = this.getIndex().comments.filter(
      (comment) => comment.threadId === normalizedThreadId,
    );
    const latestId = comments.length > 0 ? (comments[comments.length - 1]?.id ?? null) : null;
    return {
      threadId: normalizedThreadId,
      total: comments.length,
      latestId,
    };
  }

  async addComment(input: CommentAddInput): Promise<CommentRecord> {
    return this.withWriteLock(async () => {
      const body = input.body.trim();
      if (!body) {
        throw new Error("Comment body cannot be empty");
      }

      const threadId = normalizeThreadId(input.threadId);
      const actorType = normalizeActorType(input.actorType);
      const actorId = normalizeActorId(input.actorId, actorType);
      const createdAt = new Date().toISOString();
      const id = createCommentId();
      const bodyPath = path.posix.join("items", `${id}.md`);
      const context = normalizeContext(input.context);

      const meta: CommentMeta = {
        id,
        threadId,
        actorType,
        actorId,
        createdAt,
        context,
        bodyPath,
      };

      this.writeTextAtomic(this.resolveInsideBase(bodyPath), `${body}\n`);
      this.writeJsonAtomic(path.join(this.metaDir, `${id}.json`), meta);

      const index = this.getIndex();
      const comments = [...index.comments, meta].sort(compareComments);
      const nextIndex: CommentIndex = {
        version: INDEX_VERSION,
        updatedAt: new Date().toISOString(),
        comments,
      };

      this.writeJsonAtomic(this.indexPath, nextIndex);
      this.indexCache = nextIndex;

      return {
        ...meta,
        body,
      };
    });
  }

  listComments(input: CommentListInput = {}): CommentListResult {
    const threadId = normalizeThreadId(input.threadId);
    const limit = normalizeLimit(input.limit);
    const index = this.getIndex();

    const threadComments = index.comments.filter((comment) => comment.threadId === threadId);
    const selected = limit != null ? threadComments.slice(-limit) : threadComments;

    const comments = selected.map((meta) => ({
      ...meta,
      body: this.readBody(meta),
    }));

    return {
      threadId,
      total: threadComments.length,
      comments,
    };
  }

  listAllComments(input: CommentListAllInput = {}): CommentListAllResult {
    const limit = normalizeLimit(input.limit);
    const index = this.getIndex();
    const selected = limit != null ? index.comments.slice(-limit) : index.comments;

    const comments = selected.map((meta) => ({
      ...meta,
      body: this.readBody(meta),
    }));

    return {
      total: index.comments.length,
      comments,
    };
  }

  async wipeAllComments(): Promise<CommentWipeResult> {
    return this.withWriteLock(async () => {
      const index = this.getIndex();
      const removed = index.comments.length;

      try {
        fs.rmSync(this.baseDir, { recursive: true, force: true });
      } catch {
        // Ignore deletion failures and continue rebuilding the storage layout.
      }

      this.ensureLayout();

      const nextIndex: CommentIndex = {
        version: INDEX_VERSION,
        updatedAt: new Date().toISOString(),
        comments: [],
      };

      this.writeJsonAtomic(this.indexPath, nextIndex);
      this.indexCache = nextIndex;

      return {
        removed,
        remaining: 0,
      };
    });
  }

  private withWriteLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private ensureLayout(): void {
    fs.mkdirSync(this.itemsDir, { recursive: true });
    fs.mkdirSync(this.metaDir, { recursive: true });
  }

  private getIndex(): CommentIndex {
    if (!this.indexCache) {
      this.indexCache = this.loadIndexOrRebuild();
    }
    return this.indexCache;
  }

  private loadIndexOrRebuild(): CommentIndex {
    const parsed = this.readJsonFile(this.indexPath);
    if (parsed) {
      const normalized = this.normalizeIndex(parsed);
      if (normalized) {
        return normalized;
      }
    }

    return this.rebuildIndex();
  }

  private rebuildIndex(): CommentIndex {
    this.ensureLayout();

    const comments: CommentMeta[] = [];
    const files = fs.readdirSync(this.metaDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;

      const metaPath = path.join(this.metaDir, file.name);
      const parsed = this.readJsonFile(metaPath);
      if (!parsed) continue;

      const normalized = this.normalizeMeta(parsed);
      if (!normalized) continue;

      const bodyPath = this.resolveInsideBase(normalized.bodyPath);
      if (!fs.existsSync(bodyPath)) continue;

      comments.push(normalized);
    }

    comments.sort(compareComments);

    const index: CommentIndex = {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      comments,
    };

    this.writeJsonAtomic(this.indexPath, index);
    return index;
  }

  private normalizeIndex(value: unknown): CommentIndex | null {
    if (!isObject(value)) return null;
    if (value.version !== INDEX_VERSION) return null;
    if (!Array.isArray(value.comments)) return null;

    const comments: CommentMeta[] = [];
    for (const entry of value.comments) {
      const normalized = this.normalizeMeta(entry);
      if (!normalized) continue;
      comments.push(normalized);
    }

    comments.sort(compareComments);

    return {
      version: INDEX_VERSION,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
      comments,
    };
  }

  private normalizeMeta(value: unknown): CommentMeta | null {
    if (!isObject(value)) return null;
    if (typeof value.id !== "string" || !value.id.trim()) return null;

    const threadId = normalizeThreadId(
      typeof value.threadId === "string" ? value.threadId : undefined,
    );
    const actorType = normalizeActorType(
      typeof value.actorType === "string" ? value.actorType : undefined,
    );
    const actorId = normalizeActorId(
      typeof value.actorId === "string" ? value.actorId : undefined,
      actorType,
    );
    const createdAt =
      typeof value.createdAt === "string" && value.createdAt
        ? value.createdAt
        : new Date().toISOString();

    if (typeof value.bodyPath !== "string" || !value.bodyPath.trim()) return null;
    if (!isSafeRelativePath(value.bodyPath)) return null;

    const context = normalizeContext(isObject(value.context) ? value.context : undefined);

    return {
      id: value.id,
      threadId,
      actorType,
      actorId,
      createdAt,
      context,
      bodyPath: value.bodyPath,
    };
  }

  private readBody(meta: CommentMeta): string {
    const filePath = this.resolveInsideBase(meta.bodyPath);
    try {
      const body = fs.readFileSync(filePath, "utf-8");
      return body.replace(/\r\n/g, "\n").replace(/\n$/, "");
    } catch {
      return "";
    }
  }

  private readJsonFile(filePath: string): unknown | null {
    try {
      const text = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  private writeJsonAtomic(filePath: string, data: unknown): void {
    const text = `${JSON.stringify(data, null, 2)}\n`;
    this.writeTextAtomic(filePath, text);
  }

  private writeTextAtomic(filePath: string, text: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    const tempName = `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const tempPath = path.join(dir, tempName);

    fs.writeFileSync(tempPath, text, "utf-8");
    fs.renameSync(tempPath, filePath);
  }

  private resolveInsideBase(relativePath: string): string {
    if (!isSafeRelativePath(relativePath)) {
      throw new Error(`Unsafe relative path: ${relativePath}`);
    }

    const resolved = path.resolve(this.baseDir, relativePath);
    const normalizedBase = `${path.resolve(this.baseDir)}${path.sep}`;
    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(`Path escapes base directory: ${relativePath}`);
    }

    return resolved;
  }
}

export function formatCommentPreview(comment: CommentRecord, maxChars = 280): string {
  const flattened = comment.body.replace(/\s+/g, " ").trim();
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, Math.max(0, maxChars - 1))}…`;
}
