import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import slackBridge from "./index.js";
import { BrokerClient } from "./broker/client.js";

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

type CommandDefinition = {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function stubIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const target = stream as unknown as Record<string, unknown>;
  const hadOwnProperty = Object.prototype.hasOwnProperty.call(target, "isTTY");
  const previousValue = target.isTTY;

  Object.defineProperty(target, "isTTY", {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });

  return () => {
    if (hadOwnProperty) {
      Object.defineProperty(target, "isTTY", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: previousValue,
      });
      return;
    }

    Reflect.deleteProperty(target, "isTTY");
  };
}

describe("slack-bridge top-level shutdown", () => {
  const originalBotToken = process.env.SLACK_BOT_TOKEN;
  const originalAppToken = process.env.SLACK_APP_TOKEN;
  const originalHome = process.env.HOME;
  let testHome: string;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "slack-bridge-test-home-"));
    process.env.HOME = testHome;
  });

  afterEach(() => {
    fs.rmSync(testHome, { recursive: true, force: true });

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
    expect(tools.has("pinet_free")).toBe(true);
    expect(commands.has("pinet-start")).toBe(true);
    expect(commands.has("pinet-free")).toBe(true);
    expect(commands.has("pinet-skin")).toBe(true);

    await sessionStart?.({}, ctx);

    const pending = createChannel!.execute("tool-call-1", { name: "shutdown-test" });

    await sessionShutdown?.({}, ctx);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it("does not auto-follow into the mesh for headless ephemeral subagent sessions", async () => {
    const settingsPath = `${process.env.HOME}/.pi/agent/settings.json`;
    fs.mkdirSync(`${process.env.HOME}/.pi/agent`, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ "slack-bridge": { autoFollow: true } }));

    const events = new Map<string, EventHandler>();
    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
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
      isIdle: () => true,
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
        getLeafId: () => "subagent-leaf",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;

    const connectSpy = vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    const registerSpy = vi.spyOn(BrokerClient.prototype, "register");

    slackBridge(pi);

    const restoreStdinIsTTY = stubIsTTY(process.stdin, false);
    const restoreStdoutIsTTY = stubIsTTY(process.stdout, false);
    try {
      await events.get("session_start")?.({}, ctx);
    } finally {
      restoreStdinIsTTY();
      restoreStdoutIsTTY();
    }

    expect(connectSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalled();
  });
});
