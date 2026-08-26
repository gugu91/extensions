import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatContext, type EditorState } from "./helpers.js";

type NvimRpcValue = string | number | boolean | null | NvimRpcObject | NvimRpcValue[];
interface NvimRpcObject {
  [key: string]: NvimRpcValue | undefined;
}

export function resolveNvimSocketPath(cwd: string): string | null {
  try {
    const root = fs.realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf-8",
      }).trim(),
    );
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
    }).trim();
    const hash = createHash("sha256").update(`${root}:${branch}`).digest("hex");
    return path.join("/tmp/pi-nvim", `${hash}.sock`);
  } catch {
    return null;
  }
}

export function requestNvim(
  socketPath: string,
  type: string,
  payload: NvimRpcObject,
  timeoutMs = 1500,
): Promise<NvimRpcObject> {
  return new Promise((resolve, reject) => {
    const id = `pi-${randomUUID()}`;
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, result?: NvimRpcObject) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(() => finish(new Error("Neovim request timed out")), timeoutMs);

    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, type, payload })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as NvimRpcValue;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        if (parsed.id !== id) continue;
        if (parsed.type === "error") {
          const error = parsed.error;
          const message =
            error &&
            typeof error === "object" &&
            !Array.isArray(error) &&
            typeof error.message === "string"
              ? error.message
              : "Neovim request failed";
          finish(new Error(message));
          return;
        }
        const result = parsed.result;
        finish(null, result && typeof result === "object" && !Array.isArray(result) ? result : {});
        return;
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("Neovim socket closed before responding"));
    });
  });
}

export default function (pi: ExtensionAPI) {
  let socketPath: string | null = null;

  pi.registerTool({
    name: "open_in_editor",
    label: "Open in Editor",
    description: "Open a file in the user's neovim editor, optionally at a specific line",
    parameters: Type.Object({
      file: Type.String({ description: "File path (relative to repo root)" }),
      line: Type.Optional(Type.Number({ description: "Line number to jump to" })),
    }),
    async execute(_toolCallId, params) {
      if (!socketPath) {
        return {
          content: [{ type: "text", text: "No Pinet Neovim adapter is available." }],
          isError: true,
        };
      }
      try {
        const result = await requestNvim(socketPath, "editor.open", {
          file: params.file,
          ...(params.line ? { line: params.line } : {}),
        });
        if (result.delivered !== true) {
          throw new Error("No neovim instance is connected");
        }
        const target = params.line ? `${params.file}:${params.line}` : params.file;
        return { content: [{ type: "text", text: `Opened ${target} in editor` }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "No neovim instance is connected",
            },
          ],
          isError: true,
        };
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    socketPath = resolveNvimSocketPath(ctx.cwd);
    ctx.ui.setStatus("nvim-bridge", socketPath ? "" : "");
  });

  pi.on("before_agent_start", async () => {
    if (!socketPath) return;
    try {
      const result = await requestNvim(socketPath, "editor.context", {});
      const state: EditorState = {
        file: typeof result.file === "string" ? result.file : null,
        line: typeof result.line === "number" ? result.line : null,
        visibleStart: typeof result.visibleStart === "number" ? result.visibleStart : null,
        visibleEnd: typeof result.visibleEnd === "number" ? result.visibleEnd : null,
        selectionStart: typeof result.selectionStart === "number" ? result.selectionStart : null,
        selectionEnd: typeof result.selectionEnd === "number" ? result.selectionEnd : null,
      };
      const content = formatContext(state);
      if (!content) return;
      return {
        message: {
          customType: "nvim-context",
          content,
          display: true,
        },
      };
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    socketPath = null;
    ctx.ui.setStatus("nvim-bridge", "");
  });
}
