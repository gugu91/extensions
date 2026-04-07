import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BrokerClient } from "./broker/client.js";
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

describe("slack-bridge Pinet reconnect", () => {
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

  it("refreshes follower registration state after broker reconnect", async () => {
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

    let disconnectHandler: (() => void) | null = null;
    let reconnectHandler: (() => void) | null = null;
    const registerCalls: Array<{
      name: string;
      emoji: string;
      metadata?: Record<string, unknown>;
      stableId?: string;
    }> = [];

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockImplementation(async function (
      this: BrokerClient,
      name: string,
      emoji: string,
      metadata?: Record<string, unknown>,
      stableId?: string,
    ) {
      const result = {
        agentId: "worker-1",
        name,
        emoji,
        metadata: metadata ?? null,
      };
      (
        this as unknown as {
          registeredIdentity: typeof result | null;
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registeredIdentity = result;
      (
        this as unknown as {
          registrationSnapshot: {
            name: string;
            emoji: string;
            metadata?: Record<string, unknown>;
            stableId?: string;
          } | null;
        }
      ).registrationSnapshot = {
        name,
        emoji,
        ...(metadata ? { metadata } : {}),
        ...(stableId ? { stableId } : {}),
      };
      registerCalls.push({ name, emoji, metadata, stableId });
      return result;
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockResolvedValue([]);
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation((handler) => {
      disconnectHandler = handler;
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation((handler) => {
      reconnectHandler = handler;
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet-follow");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("", ctx);

    expect(registerCalls).toHaveLength(1);
    expect(disconnectHandler).toBeTypeOf("function");
    expect(reconnectHandler).toBeTypeOf("function");

    if (!disconnectHandler || !reconnectHandler) {
      throw new Error("Reconnect handlers were not registered");
    }

    const runDisconnect: () => void = disconnectHandler;
    const runReconnect: () => void = reconnectHandler;

    runDisconnect();
    runReconnect();

    await vi.waitFor(() => {
      expect(registerCalls).toHaveLength(2);
    });

    expect(registerCalls[1]?.stableId).toBe(registerCalls[0]?.stableId);
    expect(registerCalls[1]?.metadata).toMatchObject({
      role: "worker",
      capabilities: expect.objectContaining({ role: "worker" }),
    });
    expect(notify).toHaveBeenCalledWith("Pinet broker disconnected — reconnecting...", "warning");
    expect(notify).toHaveBeenCalledWith("Pinet broker reconnected", "info");

    await sessionShutdown?.({}, ctx);
    expect(setStatus).toHaveBeenCalled();
  });

  it("suppresses automatic inbox drain immediately after Escape so interrupts return control", async () => {
    vi.useFakeTimers();

    const commands = new Map<string, CommandDefinition>();
    const events = new Map<string, EventHandler>();
    const sendUserMessage = vi.fn();

    const pi = {
      appendEntry: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
        commands.set(name, definition);
      }),
      on: vi.fn((eventName: string, handler: EventHandler) => {
        events.set(eventName, handler);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;

    const setStatus = vi.fn();
    const notify = vi.fn();
    let idle = false;
    let terminalInputHandler:
      | ((data: string) => { consume?: boolean; data?: string } | undefined)
      | null = null;
    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => idle,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify,
        setStatus,
        onTerminalInput: vi.fn(
          (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
            terminalInputHandler = handler;
            return () => {
              if (terminalInputHandler === handler) {
                terminalInputHandler = null;
              }
            };
          },
        ),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    let pollCount = 0;
    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Agent",
      emoji: "🦙",
      metadata: { role: "worker", capabilities: { role: "worker" } },
    });
    vi.spyOn(BrokerClient.prototype, "claimThread").mockResolvedValue({ claimed: true });
    vi.spyOn(BrokerClient.prototype, "pollInbox").mockImplementation(async () => {
      if (pollCount > 0) {
        pollCount += 1;
        return [];
      }
      pollCount += 1;
      return [
        {
          inboxId: 17,
          message: {
            id: 17,
            threadId: "100.1",
            source: "slack",
            direction: "inbound",
            sender: "U_SENDER",
            body: "hello from broker",
            createdAt: "100.1",
            metadata: { channel: "D123" },
          },
        },
      ];
    });
    vi.spyOn(BrokerClient.prototype, "updateStatus").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "ackMessages").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "unregister").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "disconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onDisconnect").mockImplementation(() => {
      /* mocked */
    });
    vi.spyOn(BrokerClient.prototype, "onReconnect").mockImplementation(() => {
      /* mocked */
    });

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const agentEnd = events.get("agent_end");
    const follow = commands.get("pinet-follow");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(agentEnd).toBeDefined();
    expect(follow).toBeDefined();

    try {
      await sessionStart?.({}, ctx);
      await follow?.handler("", ctx);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(sendUserMessage).not.toHaveBeenCalled();
      const inputHandler = terminalInputHandler as unknown as
        | ((data: string) => { consume?: boolean; data?: string } | undefined)
        | undefined;
      expect(inputHandler).toBeTypeOf("function");
      expect(inputHandler?.("\u001b")).toBeUndefined();

      idle = true;
      await agentEnd?.({ type: "agent_end", messages: [] }, ctx);
      expect(sendUserMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_501);
      await agentEnd?.({ type: "agent_end", messages: [] }, ctx);

      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("hello from broker"), {
        deliverAs: "followUp",
      });

      await sessionShutdown?.({}, ctx);
      expect(setStatus).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("following broker"), "info");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends structured control envelopes for follower pinet_message commands", async () => {
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

    const ctx = {
      cwd: process.cwd(),
      hasUI: true,
      isIdle: () => false,
      ui: {
        theme: {
          fg: (_color: string, text: string) => text,
        },
        notify: vi.fn(),
        setStatus: vi.fn(),
      },
      sessionManager: {
        getEntries: () => [],
        getHeader: () => null,
        getLeafId: () => "leaf",
        getSessionFile: () => "/tmp/slack-bridge-session.json",
      },
    } as unknown as ExtensionContext;

    const sendCalls: Array<{
      target: string;
      body: string;
      metadata?: Record<string, unknown>;
    }> = [];

    vi.spyOn(BrokerClient.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(BrokerClient.prototype, "register").mockResolvedValue({
      agentId: "worker-1",
      name: "Test Worker",
      emoji: "🐘",
      metadata: { role: "worker" },
    });
    vi.spyOn(BrokerClient.prototype, "sendAgentMessage").mockImplementation(
      async (target: string, body: string, metadata?: Record<string, unknown>) => {
        sendCalls.push({ target, body, metadata });
        return 17;
      },
    );
    vi.spyOn(BrokerClient.prototype, "disconnectGracefully").mockResolvedValue(undefined);

    slackBridge(pi);

    const sessionStart = events.get("session_start");
    const sessionShutdown = events.get("session_shutdown");
    const follow = commands.get("pinet-follow");
    const pinetMessage = tools.get("pinet_message");

    expect(sessionStart).toBeDefined();
    expect(sessionShutdown).toBeDefined();
    expect(follow).toBeDefined();
    expect(pinetMessage).toBeDefined();

    await sessionStart?.({}, ctx);
    await follow?.handler("", ctx);
    await pinetMessage?.execute("tool-call-1", {
      to: "receiver-agent",
      message: "/reload",
    });

    expect(sendCalls).toEqual([
      {
        target: "receiver-agent",
        body: '{"type":"pinet:control","action":"reload"}',
        metadata: { type: "pinet:control", action: "reload" },
      },
    ]);

    await sessionShutdown?.({}, ctx);
  });
});
