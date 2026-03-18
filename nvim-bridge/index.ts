import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
  CommentStore,
  buildContextThreadId,
  formatCommentPreview,
  type CommentRecord,
} from "./comments.js";

interface EditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}

type NvimEvent =
  | { type: "buffer_focus"; file: string; line: number }
  | { type: "visible_range"; file: string; start: number; end: number }
  | { type: "selection"; file: string; start: number; end: number }
  | { type: "trigger_agent"; prompt: string };

type NvimCommand = { type: "open_file"; file: string; line?: number };

type CommentRpcRequest =
  | {
      id: string;
      type: "comment.list" | "comment.sync";
      payload: { threadId?: string; limit?: number };
    }
  | {
      id: string;
      type: "comment.list_all";
      payload: { limit?: number };
    }
  | {
      id: string;
      type: "comment.add";
      payload: {
        body: string;
        threadId?: string;
        actorType?: string;
        actorId?: string;
        context?: {
          file?: string;
          startLine?: number;
          endLine?: number;
        };
      };
    };

interface RepoInfo {
  repoRoot: string;
  branch: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function resolveRepoInfo(cwd: string): RepoInfo | null {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    return { repoRoot, branch };
  } catch {
    return null;
  }
}

function computeSocketPath(repoInfo: RepoInfo): string {
  const key = `${repoInfo.repoRoot}:${repoInfo.branch}`;
  const hash = crypto.createHash("sha256").update(key).digest("hex");
  const dir = "/tmp/pi-nvim";
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${hash}.sock`);
}

function formatContext(state: EditorState): string {
  if (!state.file) return "";

  let msg = `User is viewing ${state.file}`;

  if (state.visibleStart != null && state.visibleEnd != null) {
    msg += `, lines ${state.visibleStart}-${state.visibleEnd}`;
  }

  if (state.line != null) {
    msg += ` (cursor at line ${state.line})`;
  }

  if (state.selectionStart != null && state.selectionEnd != null) {
    msg += `, selection on lines ${state.selectionStart}-${state.selectionEnd}`;
  }

  msg += ".";
  return msg;
}

function parseNvimEvent(value: unknown): NvimEvent | null {
  const event = asObject(value);
  if (!event || typeof event.type !== "string") return null;

  switch (event.type) {
    case "buffer_focus": {
      const line = toPositiveInteger(event.line);
      if (typeof event.file !== "string" || line == null) return null;
      return {
        type: "buffer_focus",
        file: event.file,
        line,
      };
    }

    case "visible_range": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "visible_range",
        file: event.file,
        start,
        end,
      };
    }

    case "selection": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (typeof event.file !== "string" || start == null || end == null) return null;
      return {
        type: "selection",
        file: event.file,
        start,
        end,
      };
    }

    case "trigger_agent": {
      if (typeof event.prompt !== "string") return null;
      return {
        type: "trigger_agent",
        prompt: event.prompt,
      };
    }

    default:
      return null;
  }
}

function parseCommentRpcRequest(value: unknown): CommentRpcRequest | null {
  const request = asObject(value);
  if (
    !request ||
    typeof request.id !== "string" ||
    !request.id.trim() ||
    typeof request.type !== "string"
  ) {
    return null;
  }

  if (request.type === "comment.list" || request.type === "comment.sync") {
    const payload = asObject(request.payload) ?? {};
    const limit = toPositiveInteger(payload.limit);
    return {
      id: request.id,
      type: request.type,
      payload: {
        threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
        limit: limit ?? undefined,
      },
    };
  }

  if (request.type === "comment.list_all") {
    const payload = asObject(request.payload) ?? {};
    const limit = toPositiveInteger(payload.limit);
    return {
      id: request.id,
      type: "comment.list_all",
      payload: {
        limit: limit ?? undefined,
      },
    };
  }

  if (request.type === "comment.add") {
    const payload = asObject(request.payload);
    if (!payload || typeof payload.body !== "string") return null;

    const context = asObject(payload.context);

    return {
      id: request.id,
      type: "comment.add",
      payload: {
        body: payload.body,
        threadId: typeof payload.threadId === "string" ? payload.threadId : undefined,
        actorType: typeof payload.actorType === "string" ? payload.actorType : undefined,
        actorId: typeof payload.actorId === "string" ? payload.actorId : undefined,
        context: context
          ? {
              file: typeof context.file === "string" ? context.file : undefined,
              startLine: toPositiveInteger(context.startLine) ?? undefined,
              endLine: toPositiveInteger(context.endLine) ?? undefined,
            }
          : undefined,
      },
    };
  }

  return null;
}

function formatCommentListForTool(result: {
  threadId: string;
  total: number;
  comments: CommentRecord[];
}): string {
  if (result.total === 0) {
    return `No comments in thread "${result.threadId}".`;
  }

  let text = `Comments in thread "${result.threadId}" (${result.comments.length}/${result.total} shown):`;

  for (const comment of result.comments) {
    const actor = `${comment.actorType}:${comment.actorId}`;
    const context = comment.context?.file
      ? ` (${comment.context.file}` +
        (comment.context.startLine != null && comment.context.endLine != null
          ? `:${comment.context.startLine}-${comment.context.endLine}`
          : "") +
        ")"
      : "";

    text += `\n- [${comment.id}] ${actor} @ ${comment.createdAt}${context}\n  ${formatCommentPreview(comment)}`;
  }

  return text;
}

function formatCommentContext(comment: CommentRecord): string {
  if (!comment.context?.file) return "";

  if (comment.context.startLine != null && comment.context.endLine != null) {
    return ` (${comment.context.file}:${comment.context.startLine}-${comment.context.endLine})`;
  }

  return ` (${comment.context.file})`;
}

function getCurrentCommentContext(state: EditorState): {
  file: string;
  startLine: number;
  endLine: number;
} | null {
  if (!state.file) return null;

  const startLine = state.selectionStart ?? state.line;
  const endLine = state.selectionEnd ?? state.line;
  if (startLine == null || endLine == null) return null;

  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);

  return {
    file: state.file,
    startLine: normalizedStart,
    endLine: normalizedEnd,
  };
}

function commentMatchesCurrentContext(comment: CommentRecord, state: EditorState): boolean {
  const current = getCurrentCommentContext(state);
  if (!current || !comment.context?.file || comment.context.file !== current.file) {
    return false;
  }

  const startLine = comment.context.startLine ?? comment.context.endLine;
  const endLine = comment.context.endLine ?? comment.context.startLine;
  if (startLine == null || endLine == null) return false;

  if (current.startLine !== current.endLine) {
    return startLine === current.startLine && endLine === current.endLine;
  }

  return startLine <= current.startLine && endLine >= current.startLine;
}

function formatCommentForRead(comment: CommentRecord): string {
  const actor = `${comment.actorType}:${comment.actorId}`;
  const contextSuffix = formatCommentContext(comment);
  const bodyLines = comment.body.split(/\r?\n/);
  const firstLine = bodyLines.shift() ?? "";

  let chunk = `- ${actor}${contextSuffix}`;
  if (firstLine.trim()) {
    chunk += ` — ${firstLine.trim()}`;
  }

  if (bodyLines.length > 0) {
    const remainder = bodyLines.join("\n").trim();
    if (remainder) {
      chunk += `\n  ${remainder.replace(/\n/g, "\n  ")}`;
    }
  }

  return `${chunk}\n`;
}

function buildPiCommsReadPrompt(
  state: EditorState,
  comments: CommentRecord[],
  totalCount: number,
  maxChars = 18000,
): { prompt: string; included: number; truncated: boolean } {
  const header: string[] = ["Apply these persistent PiComms comments as guidance for the task."];

  const context = formatContext(state);
  if (context) {
    header.push(`Current editor context: ${context}`);
  }

  const currentContext = getCurrentCommentContext(state);
  const currentThreadId = buildContextThreadId(currentContext ?? undefined);

  const prioritized = [...comments].sort((a, b) => {
    const aRelevant =
      (currentThreadId != null && a.threadId === currentThreadId) ||
      commentMatchesCurrentContext(a, state);
    const bRelevant =
      (currentThreadId != null && b.threadId === currentThreadId) ||
      commentMatchesCurrentContext(b, state);
    if (aRelevant !== bRelevant) {
      return aRelevant ? -1 : 1;
    }
    return a.createdAt.localeCompare(b.createdAt);
  });

  const relevantComments = prioritized.filter(
    (comment) =>
      (currentThreadId != null && comment.threadId === currentThreadId) ||
      commentMatchesCurrentContext(comment, state),
  );
  const otherComments = prioritized.filter((comment) => !relevantComments.includes(comment));

  const sections: string[] = [];
  let usedChars = 0;
  let included = 0;

  const appendSection = (title: string, items: CommentRecord[]): void => {
    if (items.length === 0) return;

    let section = `${title}:\n`;
    let sectionIncluded = 0;

    for (const comment of items) {
      const chunk = formatCommentForRead(comment);
      if (usedChars + section.length + chunk.length > maxChars && included > 0) {
        break;
      }

      section += chunk;
      usedChars += chunk.length;
      included += 1;
      sectionIncluded += 1;
    }

    if (sectionIncluded > 0) {
      sections.push(section.trimEnd());
    }
  };

  appendSection("Most relevant PiComms", relevantComments);
  appendSection("Other PiComms in this repository", otherComments);

  const truncated = included < totalCount;
  const footer: string[] = [`Loaded comments: ${included}/${totalCount}.`];
  if (truncated) {
    footer.push("Some comments were omitted due to prompt size limits.");
  }

  return {
    prompt: `${header.join("\n")}\n\n${sections.join("\n\n")}\n\n${footer.join("\n")}`.trim(),
    included,
    truncated,
  };
}

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let socketPath: string | null = null;
  let dirty = false;
  let commentStore: CommentStore | null = null;
  const clients: Set<net.Socket> = new Set();

  const editorState: EditorState = {
    file: null,
    line: null,
    visibleStart: null,
    visibleEnd: null,
    selectionStart: null,
    selectionEnd: null,
  };

  function sendJson(socket: net.Socket, payload: unknown): boolean {
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function broadcast(payload: unknown): boolean {
    if (clients.size === 0) return false;
    let sent = false;
    for (const client of clients) {
      const ok = sendJson(client, payload);
      sent = sent || ok;
    }
    return sent;
  }

  function sendToNvim(cmd: NvimCommand): boolean {
    return broadcast(cmd);
  }

  function notifyThreadUpdated(threadId?: string): void {
    if (!commentStore) return;

    const summary = commentStore.getThreadSummary(threadId);
    broadcast({
      type: "comments.updated",
      payload: {
        threadId: summary.threadId,
        total: summary.total,
        latestId: summary.latestId,
      },
    });
  }

  function notifyAllCommentsWiped(removed: number): void {
    broadcast({
      type: "comments.wiped",
      payload: {
        removed,
      },
    });

    // No threadId on purpose: clients should refresh whichever thread is open.
    broadcast({
      type: "comments.updated",
      payload: {
        total: 0,
        latestId: null,
      },
    });
  }

  function notifyCommentUpdated(comment: CommentRecord): void {
    broadcast({
      type: "comment.added",
      payload: { comment },
    });
    notifyThreadUpdated(comment.threadId);
  }

  async function runPiCommsRead(
    source: "slash" | "panel",
    options: { isIdle?: boolean } = {},
  ): Promise<{
    ok: boolean;
    message: string;
  }> {
    if (!commentStore) {
      return { ok: false, message: "Comment store is unavailable" };
    }

    const all = commentStore.listAllComments();
    if (all.total === 0) {
      return { ok: false, message: "No PiComms comments found in this repository." };
    }

    const read = buildPiCommsReadPrompt(editorState, all.comments, all.total);

    try {
      if (options.isIdle === false) {
        pi.sendUserMessage(read.prompt, { deliverAs: "followUp" });
      } else {
        pi.sendUserMessage(read.prompt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to queue PiComms read";
      return { ok: false, message };
    }

    const truncationSuffix = read.truncated ? " Prompt was truncated to fit context." : "";
    return {
      ok: true,
      message: `Queued PiComms read from ${source} (${read.included}/${all.total} comments included).${truncationSuffix}`,
    };
  }

  async function runPiCommsClean(source: "slash" | "panel" | "tool"): Promise<{
    ok: boolean;
    message: string;
  }> {
    if (!commentStore) {
      return { ok: false, message: "Comment store is unavailable" };
    }

    try {
      const result = await commentStore.wipeAllComments();
      notifyAllCommentsWiped(result.removed);
      return {
        ok: true,
        message: `PiComms clean from ${source}: removed ${result.removed} comments in this repository.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to wipe comments";
      return { ok: false, message };
    }
  }

  function handleEvent(event: NvimEvent): void {
    switch (event.type) {
      case "buffer_focus": {
        const switchedFile = editorState.file !== event.file;
        editorState.file = event.file;
        editorState.line = event.line;

        if (switchedFile) {
          editorState.selectionStart = null;
          editorState.selectionEnd = null;
        }

        dirty = true;
        break;
      }

      case "visible_range":
        editorState.file = event.file;
        editorState.visibleStart = event.start;
        editorState.visibleEnd = event.end;
        dirty = true;
        break;

      case "selection":
        editorState.file = event.file;
        editorState.selectionStart = event.start;
        editorState.selectionEnd = event.end;
        dirty = true;
        break;

      default:
        break;
    }
  }

  async function handleCommentRequest(conn: net.Socket, request: CommentRpcRequest): Promise<void> {
    if (!commentStore) {
      sendJson(conn, {
        type: "error",
        id: request.id,
        error: {
          code: "comments_unavailable",
          message: "Comment storage is not initialized",
        },
      });
      return;
    }

    try {
      if (request.type === "comment.list" || request.type === "comment.sync") {
        const result = commentStore.listComments({
          threadId: request.payload.threadId,
          limit: request.payload.limit,
        });

        sendJson(conn, {
          type: "ok",
          id: request.id,
          result,
        });
        return;
      }

      if (request.type === "comment.list_all") {
        const result = commentStore.listAllComments({
          limit: request.payload.limit,
        });

        sendJson(conn, {
          type: "ok",
          id: request.id,
          result,
        });
        return;
      }

      if (request.type === "comment.add") {
        const comment = await commentStore.addComment({
          body: request.payload.body,
          threadId: request.payload.threadId,
          actorType: request.payload.actorType ?? "human",
          actorId: request.payload.actorId,
          context: request.payload.context,
        });

        sendJson(conn, {
          type: "ok",
          id: request.id,
          result: { comment },
        });

        notifyCommentUpdated(comment);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(conn, {
        type: "error",
        id: request.id,
        error: {
          code: "comment_request_failed",
          message,
        },
      });
    }
  }

  pi.registerTool({
    name: "open_in_editor",
    label: "Open in Editor",
    description: "Open a file in the user's neovim editor, optionally at a specific line",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to repo root)" }),
      line: Type.Optional(Type.Number({ description: "Line number to jump to" })),
    }),
    async execute(_toolCallId, params) {
      const sent = sendToNvim({
        type: "open_file",
        file: params.file,
        line: params.line,
      });

      if (!sent) {
        return {
          content: [{ type: "text", text: "No neovim instance connected" }],
          isError: true,
        };
      }

      const target = params.line ? `${params.file}:${params.line}` : params.file;
      return {
        content: [{ type: "text", text: `Opened ${target} in editor` }],
      };
    },
  });

  pi.registerTool({
    name: "comment_add",
    label: "Add Comment",
    description: "Add a markdown PiComms comment in the current git repository",
    parameters: Type.Object({
      comment: Type.String({ description: "Markdown comment body" }),
      thread_id: Type.Optional(Type.String({ description: "Thread id (default: global)" })),
      actor_type: Type.Optional(
        Type.String({ description: "Actor type (agent or human). Defaults to agent" }),
      ),
      actor_id: Type.Optional(
        Type.String({ description: "Actor identifier (default depends on actor type)" }),
      ),
      file: Type.Optional(Type.String({ description: "Optional file path for context" })),
      start_line: Type.Optional(Type.Number({ description: "Optional start line for context" })),
      end_line: Type.Optional(Type.Number({ description: "Optional end line for context" })),
    }),
    async execute(_toolCallId, params) {
      if (!commentStore) {
        return {
          content: [{ type: "text", text: "Comment store is unavailable" }],
          isError: true,
        };
      }

      const hasFile = typeof params.file === "string" && params.file.trim().length > 0;

      try {
        const comment = await commentStore.addComment({
          body: params.comment,
          threadId: params.thread_id,
          actorType: params.actor_type ?? "agent",
          actorId: params.actor_id,
          context: hasFile
            ? {
                file: params.file,
                startLine: toPositiveInteger(params.start_line) ?? undefined,
                endLine: toPositiveInteger(params.end_line) ?? undefined,
              }
            : undefined,
        });

        notifyCommentUpdated(comment);

        return {
          content: [
            { type: "text", text: `Added comment ${comment.id} to thread "${comment.threadId}".` },
          ],
          details: { comment },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to add comment";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "comment_list",
    label: "List Comments",
    description: "List PiComms comments from the current git repository",
    parameters: Type.Object({
      thread_id: Type.Optional(Type.String({ description: "Thread id (default: global)" })),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of comments to return (default: 50)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!commentStore) {
        return {
          content: [{ type: "text", text: "Comment store is unavailable" }],
          isError: true,
        };
      }

      const limit = toPositiveInteger(params.limit) ?? 50;
      const result = commentStore.listComments({
        threadId: params.thread_id,
        limit,
      });

      return {
        content: [{ type: "text", text: formatCommentListForTool(result) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "comment_wipe_all",
    label: "Wipe All Comments",
    description: "Delete all persistent PiComms comments in the current git repository",
    parameters: Type.Object({}),
    async execute() {
      const result = await runPiCommsClean("tool");
      return {
        content: [{ type: "text", text: result.message }],
        isError: !result.ok,
      };
    },
  });

  pi.registerCommand("picomms:read", {
    description: "Read all persistent PiComms comments and queue them for the agent",
    handler: async (_args, ctx) => {
      const result = await runPiCommsRead("slash", {
        isIdle: typeof ctx.isIdle === "function" ? ctx.isIdle() : undefined,
      });
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("picomms:clean", {
    description: "Wipe all persistent PiComms comments in this repository",
    handler: async (_args, ctx) => {
      const result = await runPiCommsClean("slash");
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const setBridgeStatus = (healthy: boolean) => {
      ctx.ui.setStatus("nvim-bridge", healthy ? "" : "");
    };

    const repoInfo = resolveRepoInfo(ctx.cwd);
    const storageRoot = repoInfo?.repoRoot ?? ctx.cwd;

    try {
      commentStore = new CommentStore(storageRoot);
      commentStore.initialize();
    } catch (error) {
      commentStore = null;
      const message = error instanceof Error ? error.message : "unknown error";
      console.error(`[nvim-bridge] Failed to initialize comment store: ${message}`);
    }

    if (!repoInfo) {
      socketPath = null;
      setBridgeStatus(false);
      return;
    }

    socketPath = computeSocketPath(repoInfo);

    // Unlink stale socket if exists.
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore if socket does not exist.
    }

    let activeConnections = 0;

    server = net.createServer((conn) => {
      activeConnections += 1;
      clients.add(conn);
      setBridgeStatus(true);

      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line) as unknown;
            const request = parseCommentRpcRequest(parsed);
            if (request) {
              void handleCommentRequest(conn, request);
              continue;
            }

            const event = parseNvimEvent(parsed);
            if (!event) continue;

            if (event.type === "trigger_agent") {
              try {
                pi.sendUserMessage(event.prompt, { deliverAs: "followUp" });
              } catch {
                try {
                  pi.sendUserMessage(event.prompt, { deliverAs: "steer" });
                } catch {
                  // Ignore dispatch failures.
                }
              }
            } else {
              handleEvent(event);
            }
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      conn.on("close", () => {
        clients.delete(conn);
        activeConnections = Math.max(0, activeConnections - 1);
        if (activeConnections === 0) {
          setBridgeStatus(false);
        }
      });

      conn.on("error", () => {
        // Ignore individual connection errors; close handler updates status.
      });
    });

    server.on("error", (err) => {
      console.error(`[nvim-bridge] Server error: ${err.message}`);
      setBridgeStatus(false);
    });

    server.listen(socketPath, () => {
      // Socket is ready, waiting for nvim to connect.
      setBridgeStatus(false);
    });
  });

  pi.on("before_agent_start", async () => {
    if (!dirty) return;

    const content = formatContext(editorState);
    if (!content) return;

    dirty = false;

    return {
      message: {
        customType: "nvim-context",
        content,
        display: true,
      },
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    for (const client of clients) {
      try {
        client.destroy();
      } catch {
        // Ignore.
      }
    }
    clients.clear();

    if (server) {
      server.close();
      server = null;
    }

    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore.
      }
      socketPath = null;
    }

    commentStore = null;
    ctx.ui.setStatus("nvim-bridge", "");
  });
}
