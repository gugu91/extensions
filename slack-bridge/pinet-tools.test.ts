import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  registerPinetTools,
  type PinetToolsAgentRecord,
  type RegisterPinetToolsDeps,
} from "./pinet-tools.js";

type ToolDefinition = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
};

function makeAgent(overrides: Partial<PinetToolsAgentRecord> = {}): PinetToolsAgentRecord {
  return {
    emoji: "🐇",
    name: "Golden Chalk Rabbit",
    id: "agent-1",
    pid: 101,
    status: "idle",
    metadata: { repo: "extensions", tools: ["read", "edit"] },
    lastHeartbeat: new Date(Date.now() - 1_000).toISOString(),
    lastSeen: new Date(Date.now() - 500).toISOString(),
    disconnectedAt: null,
    resumableUntil: null,
    ...overrides,
  };
}

function createDeps(overrides: Partial<RegisterPinetToolsDeps> = {}): RegisterPinetToolsDeps {
  const defaults: RegisterPinetToolsDeps = {
    pinetEnabled: () => true,
    brokerRole: () => "broker",
    requireToolPolicy: () => {},
    sendPinetAgentMessage: async (target, _body) => ({ messageId: 17, target }),
    sendPinetBroadcastMessage: (channel) => ({
      channel,
      messageIds: [11, 12],
      recipients: ["Worker One", "Worker Two"],
    }),
    signalAgentFree: async (_ctx: ExtensionContext | undefined, _options) => ({
      queuedInboxCount: 0,
      drainedQueuedInbox: false,
    }),
    scheduleBrokerWakeup: async (fireAt: string, _message: string) => ({ id: 7, fireAt }),
    scheduleFollowerWakeup: async (fireAt: string, _message: string) => ({ id: 9, fireAt }),
    listBrokerAgents: () => [makeAgent()],
    listFollowerAgents: async (_includeGhosts: boolean) => [makeAgent({ id: "agent-2" })],
  };

  return { ...defaults, ...overrides };
}

function registerWithDeps(deps: RegisterPinetToolsDeps): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: vi.fn((definition: ToolDefinition) => {
      tools.set(definition.name, definition);
    }),
  } as unknown as ExtensionAPI;

  registerPinetTools(pi, deps);
  return tools;
}

describe("registerPinetTools", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers the four generic Pinet tools", () => {
    const tools = registerWithDeps(createDeps());

    expect([...tools.keys()]).toEqual([
      "pinet_message",
      "pinet_free",
      "pinet_schedule",
      "pinet_agents",
    ]);
  });

  it("uses the broker broadcast path for broadcast pinet_message targets", async () => {
    const sendPinetBroadcastMessage = vi.fn((channel: string, _body: string) => ({
      channel,
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    }));
    const deps = createDeps({ sendPinetBroadcastMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet_message")?.execute("tool-call-1", {
      to: "#extensions",
      message: "hello mesh",
    })) as {
      content: Array<{ text: string }>;
      details: { channel: string; messageIds: number[]; recipients: string[] };
    };

    expect(sendPinetBroadcastMessage).toHaveBeenCalledWith("#extensions", "hello mesh");
    expect(result.content[0]?.text).toBe(
      "Broadcast sent to #extensions (2 agents: Worker One, Worker Two).",
    );
    expect(result.details).toEqual({
      channel: "#extensions",
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    });
  });

  it("formats pinet_free responses with note and queued inbox count", async () => {
    const signalAgentFree = vi.fn(async () => ({
      queuedInboxCount: 2,
      drainedQueuedInbox: false,
    }));
    const deps = createDeps({ signalAgentFree });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet_free")?.execute("tool-call-2", {
      note: "wrapped up #395",
    })) as {
      content: Array<{ text: string }>;
      details: { status: string; note: string | null; queuedInboxCount: number };
    };

    expect(signalAgentFree).toHaveBeenCalledWith(undefined, { requirePinet: true });
    expect(result.content[0]?.text).toBe(
      "Marked this Pinet agent idle/free for new work. Note: wrapped up #395. 2 queued inbox items remain.",
    );
    expect(result.details).toEqual({
      status: "idle",
      note: "wrapped up #395",
      queuedInboxCount: 2,
    });
  });

  it("routes pinet_schedule through the broker wake-up callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const scheduleBrokerWakeup = vi.fn(async (fireAt: string, _message: string) => ({
      id: 7,
      fireAt,
    }));
    const deps = createDeps({ scheduleBrokerWakeup });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet_schedule")?.execute("tool-call-3", {
      delay: "5m",
      message: "check queue",
    })) as {
      content: Array<{ text: string }>;
      details: { id: number; fireAt: string };
    };

    expect(scheduleBrokerWakeup).toHaveBeenCalledWith("2026-04-14T12:05:00.000Z", "check queue");
    expect(result.content[0]?.text).toBe("Wake-up scheduled for 2026-04-14T12:05:00.000Z (id: 7).");
    expect(result.details).toEqual({ id: 7, fireAt: "2026-04-14T12:05:00.000Z" });
  });

  it("renders broker pinet_agents output with routing hints and outbound counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [makeAgent({ outboundCount: 3 })]);
    const deps = createDeps({ listBrokerAgents });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet_agents")?.execute("tool-call-4", {
      repo: "extensions",
      required_tools: "read, edit",
      task: "review #395",
    })) as {
      content: Array<{ text: string }>;
      details: { hint: { repo?: string; requiredTools?: string[]; task?: string } };
    };

    expect(listBrokerAgents).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain(
      "Agent routing hints: repo=extensions · tools=read,edit · task=review #395",
    );
    expect(result.content[0]?.text).toContain("Golden Chalk Rabbit");
    expect(result.content[0]?.text).toContain("outbound: 3 this session");
    expect(result.details.hint).toEqual({
      repo: "extensions",
      branch: undefined,
      role: undefined,
      requiredTools: ["read", "edit"],
      task: "review #395",
    });
  });
});
