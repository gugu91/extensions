import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";

interface EditorState {
  file: string | null;
  line: number | null;
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  commentEnd: number | null;
  commentText: string | null;
}

type NvimEvent =
  | { type: "buffer_focus"; file: string; line: number }
  | { type: "visible_range"; file: string; start: number; end: number }
  | { type: "selection"; file: string; start: number; end: number }
  | { type: "selection_comment"; file: string; start: number; end: number; comment: string };

function computeSocketPath(cwd: string): string | null {
  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf-8" }).trim();
    const key = `${repoRoot}:${branch}`;
    const hash = crypto.createHash("sha256").update(key).digest("hex");
    const dir = "/tmp/pi-nvim";
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, `${hash}.sock`);
  } catch {
    return null;
  }
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

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let socketPath: string | null = null;
  let dirty = false;

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

  function handleEvent(event: NvimEvent) {
    switch (event.type) {
      case "buffer_focus": {
        const switchedFile = editorState.file !== event.file;
        editorState.file = event.file;
        editorState.line = event.line;

        // Only clear selection/comment when we actually changed file.
        // This preserves one-shot comments when focus returns from the
        // temporary floating comment buffer back to the same file.
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
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const setBridgeStatus = (healthy: boolean) => {
      ctx.ui.setStatus("nvim-bridge", healthy ? "" : "");
    };

    socketPath = computeSocketPath(ctx.cwd);
    if (!socketPath) {
      setBridgeStatus(false);
      return;
    }

    // Unlink stale socket if exists
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // Ignore if not exists
    }

    let activeConnections = 0;

    server = net.createServer((conn) => {
      activeConnections += 1;
      setBridgeStatus(true);

      let buffer = "";

      conn.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        // Keep the last incomplete line in buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as NvimEvent;
            handleEvent(event);
          } catch {
            // Ignore malformed JSON
          }
        }
      });

      conn.on("close", () => {
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

  pi.on("before_agent_start", async (_event, _ctx) => {
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
    if (server) {
      server.close();
      server = null;
    }
    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore
      }
      socketPath = null;
    }

    ctx.ui.setStatus("nvim-bridge", "");
  });
}
