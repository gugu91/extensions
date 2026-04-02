import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import slackBridge from "./index.js";

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

describe("slack-bridge top-level shutdown", () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.HOME = "/tmp/slack-bridge-test-home";
  });

  afterEach(() => {
    if (originalBotToken === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = originalBotToken;
    }

    if (originalAppToken === undefined) {
      delete process.env.SLACK_APP_TOKEN;
    } else {
      process.env.SLACK_APP_TOKEN = originalAppToken;
    }

    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts in-flight top-level Slack calls during session shutdown", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn((definition: ToolDefinition) => {
        tools.set(definition.name, definition);
      }),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          rejectAbort();
          return;
        }

        signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const createChannel = tools.get("slack_create_channel");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(createChannel).toBeDefined();
    expect(commands.has("pinet-start")).toBe(true);

    await sessionStart?.({}, ctx);

    const pending = createChannel!.execute("tool-call-1", { name: "shutdown-test" });

    await sessionShutdown?.({}, ctx);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(2);
  });
});
