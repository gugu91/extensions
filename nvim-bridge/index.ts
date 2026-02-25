import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { CommentStore, formatCommentPreview, type CommentRecord } from "./comments.js";

interface EditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  commentStart: number | null;
  commentEnd: number | null;
  commentText: string | null;
}

type NvimEvent =
  | { type: "buffer_focus"; file: string; line: number }
  | { type: "visible_range"; file: string; start: number; end: number }
  | { type: "selection"; file: string; start: number; end: number }
  | { type: "selection_comment"; file: string; start: number; end: number; comment: string }
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

function formatInlineComment(comment: string): string {
  const flattened = comment.replace(/\s+/g, " ").trim();
  if (flattened.length <= 220) return flattened;
  return `${flattened.slice(0, 219)}…`;
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

  if (state.commentStart != null && state.commentEnd != null && state.commentText) {
    msg += `, comment on lines ${state.commentStart}-${state.commentEnd}: "${formatInlineComment(state.commentText)}"`;
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

    case "selection_comment": {
      const start = toPositiveInteger(event.start);
      const end = toPositiveInteger(event.end);
      if (
        typeof event.file !== "string" ||
        start == null ||
        end == null ||
        typeof event.comment !== "string"
      )
        return null;
      return {
        type: "selection_comment",
        file: event.file,
        start,
        end,
        comment: event.comment,
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
    commentStart: null,
    commentEnd: null,
    commentText: null,
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

  function handleEvent(event: NvimEvent): void {
    switch (event.type) {
      case "buffer_focus": {
        const switchedFile = editorState.file !== event.file;
        editorState.file = event.file;
        editorState.line = event.line;

        // Preserve one-shot comments when focus returns from temporary buffers.
        if (switchedFile) {
          editorState.selectionStart = null;
          editorState.selectionEnd = null;
          editorState.commentStart = null;
          editorState.commentEnd = null;
          editorState.commentText = null;
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

      case "selection_comment":
        editorState.file = event.file;
        editorState.selectionStart = event.start;
        editorState.selectionEnd = event.end;
        editorState.commentStart = event.start;
        editorState.commentEnd = event.end;
        editorState.commentText = event.comment;
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
    description: "Add a markdown comment to the local A2A thread",
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
    description: "List comments from the local A2A thread",
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
    description: "Delete all persistent A2A comments in the current git repository",
    parameters: Type.Object({}),
    async execute() {
      if (!commentStore) {
        return {
          content: [{ type: "text", text: "Comment store is unavailable" }],
          isError: true,
        };
      }

      try {
        const result = await commentStore.wipeAllComments();
        notifyAllCommentsWiped(result.removed);

        return {
          content: [
            {
              type: "text",
              text: `Wiped all comments in this repository (${result.removed} removed).`,
            },
          ],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to wipe comments";
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
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
              pi.sendUserMessage(event.prompt);
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

    // Comment notes are one-shot to avoid repeating them in later updates.
    editorState.commentStart = null;
    editorState.commentEnd = null;
    editorState.commentText = null;

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
