import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalProgressMessage } from "./progress.js";
import { registerAgentGoal } from "./index.js";
import { MemoryGoalStorage } from "./memory-storage.js";

type GoalEventHandler = (
  event: { messages?: GoalProgressMessage[] },
  context: ExtensionContext,
) => Promise<void> | void;
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

afterEach(() => vi.useRealTimers());

describe("registerAgentGoal", () => {
  it("records a worker terminal candidate and evaluates it after the run settles", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionContext;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      budget: { maxIterations: 5 },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const evaluator = {
      evaluate: vi.fn().mockResolvedValue({ outcome: "complete", reason: "verified" }),
    };
    registerAgentGoal(pi, {
      storage,
      evaluator,
      continuation: { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) },
    });
    const updateGoalTool = tools.get("update_goal");
    if (!updateGoalTool?.execute) throw new Error("update_goal was not registered");

    await handlers.get("agent_start")?.({}, context);
    await updateGoalTool.execute(
      "call-1",
      { status: "complete", reason: "all acceptance checks pass" },
      new AbortController().signal,
      undefined,
      context,
    );
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);

    expect(evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "goal-1" }),
      expect.objectContaining({
        terminalCandidate: {
          outcome: "complete",
          reason: "all acceptance checks pass",
        },
      }),
    );
    expect(await storage.get("session-1")).toMatchObject({ status: "complete" });
  });

  it("automatically retries a continuation deferred while the session is busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const handlers = new Map<string, GoalEventHandler>();
    const tools = new Map<string, ToolDefinition>();
    const sendMessage = vi.fn();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage,
    } as object as ExtensionAPI;
    let idle = false;
    const context = {
      hasUI: true,
      isIdle: () => idle,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionContext;
    const storage = new MemoryGoalStorage();
    await storage.create({
      id: "goal-1",
      scopeId: "session-1",
      objective: "ship",
      status: "active",
      budget: { maxIterations: 5 },
      usage: { iterations: 0, tokens: 0 },
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    registerAgentGoal(pi, { storage });

    await handlers.get("agent_start")?.({}, context);
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ state: "deferred" });

    idle = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(await storage.getContinuationClaim("session-1")).toMatchObject({ state: "started" });
    await handlers.get("session_shutdown")?.({}, context);
  });

  it("opens a goal overlay in TUI mode and preserves the textual fallback", async () => {
    const commands = new Map<string, RegisteredCommand>();
    const sendMessage = vi.fn();
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      sendMessage,
    } as object as ExtensionAPI;
    const custom = vi.fn().mockResolvedValue(undefined);
    const baseContext = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        custom,
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    };
    registerAgentGoal(pi, { storage: new MemoryGoalStorage() });
    const command = commands.get("goal");
    if (!command) throw new Error("goal command was not registered");

    await command.handler("", {
      ...baseContext,
      mode: "tui",
    } as object as ExtensionCommandContext);

    expect(custom).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        overlay: true,
        overlayOptions: expect.objectContaining({ anchor: "center" }),
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    await command.handler("", {
      ...baseContext,
      mode: "print",
    } as object as ExtensionCommandContext);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "This session has no goal." }),
      { triggerTurn: false },
    );
  });

  it("lets the worker create and inspect its own bounded goal", async () => {
    const handlers = new Map<string, GoalEventHandler>();
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      on(name: string, handler: GoalEventHandler) {
        handlers.set(name, handler);
      },
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      registerCommand: vi.fn(),
      sendMessage: vi.fn(),
    } as object as ExtensionAPI;
    const context = {
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "session-1" },
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        notify: vi.fn(),
      },
    } as object as ExtensionContext;
    const storage = new MemoryGoalStorage();
    const continuation = { continueIfIdle: vi.fn().mockResolvedValue({ status: "started" }) };
    registerAgentGoal(pi, {
      storage,
      evaluator: { evaluate: vi.fn() },
      continuation,
      defaultBudget: { maxIterations: 8 },
    });
    const createGoalTool = tools.get("create_goal");
    const getGoalTool = tools.get("get_goal");
    if (!createGoalTool?.execute || !getGoalTool?.execute) {
      throw new Error("goal tools were not registered");
    }

    await handlers.get("agent_start")?.({}, context);
    await expect(
      createGoalTool.execute(
        "rejected-call",
        { objective: "unbounded task", maxIterations: 9 },
        new AbortController().signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("configured limit of 8");
    await createGoalTool.execute(
      "call-1",
      { objective: "finish the approved task", maxIterations: 4 },
      new AbortController().signal,
      undefined,
      context,
    );
    await handlers.get("agent_end")?.({ messages: [] }, context);
    await handlers.get("agent_settled")?.({}, context);
    const inspected = await getGoalTool.execute(
      "call-2",
      {},
      new AbortController().signal,
      undefined,
      context,
    );

    expect(await storage.get("session-1")).toMatchObject({
      objective: "finish the approved task",
      status: "active",
      budget: { maxIterations: 4 },
      usage: { iterations: 0 },
    });
    expect(continuation.continueIfIdle).toHaveBeenCalledOnce();
    expect(inspected.content[0]).toMatchObject({ type: "text" });
  });
});
