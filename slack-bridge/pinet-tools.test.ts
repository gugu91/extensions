import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  registerPinetTools,
  type PinetToolsAgentRecord,
  type RegisterPinetToolsDeps,
} from "./pinet-tools.js";

type ToolDefinition = {
  name: string;
  promptSnippet?: string;
  parameters?: unknown;
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
    readPinetInbox: async () => ({
      messages: [],
      unreadCountBefore: 0,
      unreadCountAfter: 0,
      unreadThreads: [],
      markedReadIds: [],
    }),
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

  it("registers the default Pinet surface", () => {
    const tools = registerWithDeps(createDeps());

    expect([...tools.keys()]).toEqual(["pinet"]);
  });

  it("standardizes send/delegation on the dispatcher", () => {
    const tools = registerWithDeps(createDeps());
    const pinet = tools.get("pinet");

    expect(pinet?.promptSnippet).toContain("Use this dispatcher for all Pinet actions");
    expect(pinet?.promptSnippet).toContain('action="send"');
    expect(JSON.stringify(pinet?.parameters)).toContain(
      "help, send, read, free, schedule, or agents",
    );
  });

  it("uses the broker broadcast path for broadcast dispatcher send targets", async () => {
    const sendPinetBroadcastMessage = vi.fn((channel: string, _body: string) => ({
      channel,
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    }));
    const deps = createDeps({ sendPinetBroadcastMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-1", {
      action: "send",
      args: {
        to: "#extensions",
        message: "hello mesh",
      },
    })) as {
      details: {
        data: {
          text: string;
          details: { channel: string; messageIds: number[]; recipients: string[] };
        };
      };
    };

    expect(sendPinetBroadcastMessage).toHaveBeenCalledWith("#extensions", "hello mesh");
    expect(result.details.data.text).toBe(
      "Broadcast sent to #extensions (2 agents: Worker One, Worker Two).",
    );
    expect(result.details.data.details).toEqual({
      channel: "#extensions",
      messageIds: [21, 22],
      recipients: ["Worker One", "Worker Two"],
    });
  });

  it("reads durable Pinet inbox context and marks returned rows read by default", async () => {
    const readPinetInbox = vi.fn(async () => ({
      messages: [
        {
          inboxId: 31,
          delivered: true,
          readAt: "2026-04-25T12:00:00.000Z",
          message: {
            id: 44,
            threadId: "a2a:broker:worker",
            source: "agent",
            direction: "inbound",
            sender: "broker",
            body: "please inspect #594",
            metadata: { a2a: true },
            createdAt: "2026-04-25T11:59:00.000Z",
          },
        },
      ],
      unreadCountBefore: 2,
      unreadCountAfter: 1,
      unreadThreads: [
        {
          threadId: "a2a:broker:worker",
          source: "agent",
          channel: "",
          unreadCount: 1,
          latestMessageId: 45,
          latestAt: "2026-04-25T12:01:00.000Z",
          highestMailClass: "steering" as const,
          mailClassCounts: { steering: 1, fwup: 0, maintenance_context: 0 },
        },
      ],
      markedReadIds: [31],
    }));
    const deps = createDeps({ readPinetInbox });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-read", {
      action: "read",
      args: {
        thread_id: "a2a:broker:worker",
        limit: 5,
      },
    })) as {
      details: {
        status: "succeeded";
        data: { text: string; details: { markedReadIds: number[] } };
      };
    };

    expect(readPinetInbox).toHaveBeenCalledWith({ threadId: "a2a:broker:worker", limit: 5 });
    expect(result.details.data.text).toContain(
      "Pinet read (unread) from thread a2a:broker:worker: 1 message.",
    );
    expect(result.details.data.text).toContain("Unread before: 2; unread after: 1.");
    expect(result.details.data.text).toContain(
      "- [steering] [agent/a2a:broker:worker #44] broker: please inspect #594",
    );
    expect(result.details.data.text).toContain(
      "- [steering] a2a:broker:worker (agent): 1 unread (1 steering); latest #45; pointer=pinet action=read args.thread_id=a2a:broker:worker args.unread_only=true",
    );
    expect(result.details.data.text).toContain("Marked read: 31.");
    expect(result.details.data.details.markedReadIds).toEqual([31]);
  });

  it("routes action-dispatched help through the dispatcher", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-help", {
      action: "help",
    })) as {
      content: Array<{ text: string }>;
      details: {
        status: "succeeded";
        data: {
          actions: Array<{ action: string; guardrail_tool: string; description: string }>;
          note: string;
        };
      };
    };

    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.note).toContain("Use args.topic");
    expect(result.details.data.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "send", guardrail_tool: "pinet:send" }),
        expect.objectContaining({ action: "read", guardrail_tool: "pinet:read" }),
        expect.objectContaining({ action: "free", guardrail_tool: "pinet:free" }),
        expect.objectContaining({ action: "schedule", guardrail_tool: "pinet:schedule" }),
        expect.objectContaining({ action: "agents", guardrail_tool: "pinet:agents" }),
      ]),
    );
  });

  it("rejects legacy direct-tool names as dispatcher action values", async () => {
    const tools = registerWithDeps(createDeps());

    const result = (await tools.get("pinet")?.execute("tool-call-legacy-action", {
      action: "pinet_send",
    })) as { details: { status: string; errors: Array<{ message: string }> } };

    expect(result.details.status).toBe("failed");
    expect(result.details.errors[0]?.message).toContain("Unknown Pinet action: pinet_send");
  });

  it("routes action-dispatched pinet send", async () => {
    const sendPinetAgentMessage = vi.fn(async (_to: string, _message: string) => ({
      messageId: 41,
      target: "alpha",
    }));
    const deps = createDeps({ sendPinetAgentMessage });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-dispatch-send", {
      action: "send",
      args: {
        to: "alpha",
        message: "dispatch now",
      },
    })) as {
      content: Array<{ text: string }>;
      details: { status: string; data: { action: string; text: string } };
    };

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("alpha", "dispatch now");
    expect(result.details.status).toBe("succeeded");
    expect(result.details.data.action).toBe("send");
    expect(result.content[0]?.text).toContain('"status": "succeeded"');
  });

  it("formats action-dispatched free responses with note and queued inbox count", async () => {
    const signalAgentFree = vi.fn(async () => ({
      queuedInboxCount: 2,
      drainedQueuedInbox: false,
    }));
    const deps = createDeps({ signalAgentFree });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-2", {
      action: "free",
      args: { note: "wrapped up #395" },
    })) as {
      details: {
        status: "succeeded";
        data: {
          text: string;
          details: { status: string; note: string | null; queuedInboxCount: number };
        };
      };
    };

    expect(signalAgentFree).toHaveBeenCalledWith(undefined, { requirePinet: true });
    expect(result.details.data.text).toBe(
      "Marked this Pinet agent idle/free for new work. Note: wrapped up #395. 2 queued inbox items remain.",
    );
    expect(result.details.data.details).toEqual({
      status: "idle",
      note: "wrapped up #395",
      queuedInboxCount: 2,
    });
  });

  it("routes action-dispatched schedule through the broker wake-up callback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const scheduleBrokerWakeup = vi.fn(async (fireAt: string, _message: string) => ({
      id: 7,
      fireAt,
    }));
    const deps = createDeps({ scheduleBrokerWakeup });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-3", {
      action: "schedule",
      args: { delay: "5m", message: "check queue" },
    })) as {
      details: {
        status: "succeeded";
        data: { text: string; details: { id: number; fireAt: string } };
      };
    };

    expect(scheduleBrokerWakeup).toHaveBeenCalledWith("2026-04-14T12:05:00.000Z", "check queue");
    expect(result.details.data.text).toBe(
      "Wake-up scheduled for 2026-04-14T12:05:00.000Z (id: 7).",
    );
    expect(result.details.data.details).toEqual({ id: 7, fireAt: "2026-04-14T12:05:00.000Z" });
  });

  it("renders broker pinet agents output with routing hints and outbound counts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:00:00Z"));

    const listBrokerAgents = vi.fn(() => [makeAgent({ outboundCount: 3 })]);
    const deps = createDeps({ listBrokerAgents });
    const tools = registerWithDeps(deps);

    const result = (await tools.get("pinet")?.execute("tool-call-4", {
      action: "agents",
      args: {
        repo: "extensions",
        required_tools: "read, edit",
        task: "review #395",
      },
    })) as {
      details: {
        status: "succeeded";
        data: {
          text: string;
          details: { hint: { repo?: string; requiredTools?: string[]; task?: string } };
        };
      };
    };

    expect(listBrokerAgents).toHaveBeenCalledTimes(1);
    expect(result.details.data.text).toContain(
      "Agent routing hints: repo=extensions · tools=read,edit · task=review #395",
    );
    expect(result.details.data.text).toContain("Golden Chalk Rabbit");
    expect(result.details.data.text).toContain("outbound: 3 this session");
    expect(result.details.data.details.hint).toEqual({
      repo: "extensions",
      branch: undefined,
      role: undefined,
      requiredTools: ["read", "edit"],
      task: "review #395",
    });
  });
});
