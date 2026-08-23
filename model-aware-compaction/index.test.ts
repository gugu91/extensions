import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function harness() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (event: string, handler: Handler) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  extension(api);
  const emit = (event: string, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };
  return { handlers, emit, api };
}

function context(tokens: number, compact = vi.fn()): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: { notify: vi.fn(), setStatus: vi.fn() } as unknown as ExtensionContext["ui"],
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => undefined,
      getSessionFile: () => undefined,
    },
    model: { provider: "openai", id: "gpt-5-mini" },
    getContextUsage: () => ({ tokens, contextWindow: 400_000, percent: tokens / 4_000 }),
    compact,
  };
}

describe("extension wiring", () => {
  it("does nothing while disabled", () => {
    const { emit } = harness();
    const compact = vi.fn();
    // Explicit project settings keep the test hermetic — without them the
    // extension falls back to ~/.pi/agent/settings.json, coupling the result
    // to whatever the developer's machine has configured globally.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: false } }),
    );
    try {
      emit("agent_settled", { ...context(120_000, compact), cwd: temp });
      expect(compact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("waits for the full operation to settle before compacting", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };

      // Pi can still auto-compact and retry after agent_end.
      emit("turn_end", ctx);
      emit("agent_end", ctx);
      expect(compact).not.toHaveBeenCalled();

      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("triggers once above the configured threshold and re-arms after completion plus lower usage", () => {
    const { emit } = harness();
    const compact = vi.fn();
    // Project settings take precedence; the test creates only the minimal extension config.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({
        "model-aware-compaction": { enabled: true },
      }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };
      emit("agent_settled", ctx);
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);

      const options = compact.mock.calls[0]?.[0] as { onComplete?: () => void };
      options.onComplete?.();
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);

      emit("agent_settled", {
        ...ctx,
        getContextUsage: () => ({ tokens: 90_000, contextWindow: 400_000, percent: 22.5 }),
      });
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("skips a settled branch whose latest entry is already a compaction", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const base = context(120_000, compact);
      const ctx = {
        ...base,
        cwd: temp,
        sessionManager: {
          ...base.sessionManager,
          getBranch: () => [{ type: "compaction" }],
        },
      };
      emit("agent_settled", ctx);
      emit("agent_settled", ctx);
      expect(compact).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("treats an already-compacted callback as an idempotent outcome", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true, debug: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp, hasUI: true };
      emit("agent_settled", ctx);
      const options = compact.mock.calls[0]?.[0] as { onError?: (error: Error) => void };
      options.onError?.(new Error("Already compacted"));
      emit("agent_settled", ctx);

      expect(compact).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("failed"));
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("failed"), "error");
    } finally {
      error.mockRestore();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("does not clear the in-flight guard when a model selection event re-arms the threshold", () => {
    const { emit } = harness();
    const compact = vi.fn();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "model-aware-compaction-"));
    fs.mkdirSync(path.join(temp, ".pi"));
    fs.writeFileSync(
      path.join(temp, ".pi", "settings.json"),
      JSON.stringify({ "model-aware-compaction": { enabled: true } }),
    );
    try {
      const ctx = { ...context(120_000, compact), cwd: temp };
      emit("agent_settled", ctx);
      emit("model_select", ctx);
      emit("agent_settled", ctx);
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
