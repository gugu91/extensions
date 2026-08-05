import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatGlobalBrokerReport,
  formatPinetCommandHelp,
  registerPinetCommands,
  type PinetCommandsDeps,
} from "./pinet-commands.js";
import type { BrokerLockOwner } from "./broker/index.js";
import type { SlackBridgeSettings } from "./helpers.js";
import type { SlackScopeDiagnostics } from "./slack-scope-diagnostics.js";
import type { SlackBridgeRuntimeMode } from "./runtime-mode.js";

type CommandDefinition = {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

function createContext(): { ctx: ExtensionContext; notify: ReturnType<typeof vi.fn> } {
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify,
      theme: { fg: (_color: string, text: string) => text },
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;

  return { ctx, notify };
}

function createDeps(overrides: Partial<PinetCommandsDeps> = {}): PinetCommandsDeps {
  const settings: SlackBridgeSettings = {};
  const slackScopeDiagnostics: SlackScopeDiagnostics = {
    status: "not_checked",
    checkedAt: null,
    summary: "unchecked",
    surfaces: [],
    missingScopes: [],
    results: [],
  };

  const defaults: PinetCommandsDeps = {
    pinetEnabled: () => true,
    pinetRegistrationBlocked: () => false,
    runtimeMode: () => "single" as SlackBridgeRuntimeMode,
    runtimeConnected: () => true,
    brokerRole: () => "broker",
    agentName: () => "Slate Chalk Otter",
    agentEmoji: () => "🦦",
    agentOwnerToken: () => "owner-token",
    agentPersonality: () => null,
    agentAliases: () => new Set<string>(),
    botUserId: () => "U123",
    activeSkinTheme: () => null,
    lastDmChannel: () => null,
    followerRuntimeDiagnostic: () => null,
    threads: () => new Map<string, { owner?: string }>(),
    allowedUsers: () => null,
    inboxLength: () => 0,
    recentActivityLogEntries: () => [],
    slackScopeDiagnostics: () => slackScopeDiagnostics,
    settings: () => settings,
    lastBrokerMaintenance: () => null,
    ralphSnoozeStatus: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
    snoozeRalphLoop: ({ durationMs, reason }) => ({
      active: true,
      until: "2026-04-02T14:30:00.000Z",
      remainingMs: durationMs,
      reason: reason ?? null,
      source: "manual",
      emptyCycleCount: 0,
    }),
    clearRalphSnooze: () => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }),
    getBrokerControlPlaneHomeTabViewerIds: () => [],
    lastBrokerControlPlaneHomeTabRefreshAt: () => null,
    lastBrokerControlPlaneHomeTabError: () => null,
    subtreeBrokerStatus: () => ({
      active: false,
      selfAgentId: null,
      startedAt: null,
      paths: null,
      childLaunchEnv: {},
      childLaunchHint: null,
      childCount: 0,
      spawnedWorkers: [],
    }),
    getPinetRegistrationBlockReason: () => "blocked",
    inspectGlobalBroker: async () => ({ lock: { state: "none", owner: null }, probe: null }),
    replaceGlobalBroker: async () => ({
      outcome: "no-conflict",
      owner: null,
      steps: [],
      error: null,
    }),
    connectAsBroker: async () => {},
    connectAsFollower: async () => {},
    reloadPinetRuntime: async () => {},
    disconnectFollower: async () => ({ unregisterError: null }),
    startSubtreeBroker: async () => ({
      active: true,
      selfAgentId: "subbroker-worker-1",
      startedAt: "2026-05-25T22:00:00.000Z",
      paths: {
        rootDir: "/tmp/pinet-subtrees/worker-1",
        socketPath: "/tmp/pinet-subtrees/worker-1/pinet.sock",
        dbPath: "/tmp/pinet-subtrees/worker-1/pinet-broker.db",
        lockPath: "/tmp/pinet-subtrees/worker-1/pinet-broker.lock",
      },
      childLaunchEnv: {
        PINET_SOCKET_PATH: "/tmp/pinet-subtrees/worker-1/pinet.sock",
        PINET_PARENT_AGENT_ID: "subbroker-worker-1",
      },
      childLaunchHint: "PINET_SOCKET_PATH=/tmp/pinet-subtrees/worker-1/pinet.sock pi",
      childCount: 0,
      spawnedWorkers: [],
    }),
    stopSubtreeBroker: async () => {},
    spawnSubtreeWorker: async (_ctx, input) => ({
      status: "started",
      launchId: "launch-1",
      runtimeKind: "tmux",
      sessionName: "pinet-extensions-reviewer-launch-1",
      repoPath: `/tmp/${input.repo}`,
      role: input.role ?? "subworker",
      laneId: input.laneId ?? null,
      agentId: "child-1",
      agentName: "Child Worker",
      messageId: 42,
      threadId: "a2a:subbroker-worker-1:child-1",
      monitorCommand: "tmux attach -t pinet-extensions-reviewer-launch-1",
      socketPath: "/tmp/pinet-subtrees/worker-1/pinet.sock",
      dbPath: "/tmp/pinet-subtrees/worker-1/pinet-broker.db",
      childLaunchEnv: {},
    }),
    sendPinetAgentMessage: async (target) => ({ messageId: 1, target }),
    signalAgentFree: async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }),
    applyLocalAgentIdentity: async () => {},
    setExtStatus: () => {},
    setExtCtx: () => {},
  };

  return { ...defaults, ...overrides };
}

function registerCommands(deps: PinetCommandsDeps): Map<string, CommandDefinition> {
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
      commands.set(name, definition);
    }),
  } as unknown as ExtensionAPI;

  registerPinetCommands(pi, deps);
  return commands;
}

describe("registerPinetCommands", () => {
  it("registers only the unified /pinet command", () => {
    const commands = registerCommands(createDeps());

    expect(commands.has("pinet")).toBe(true);
    expect(commands.has("pinet-start")).toBe(false);
    expect(commands.has("pinet-follow")).toBe(false);
    expect(commands.has("pinet-free")).toBe(false);
    expect(commands.has("pinet-skin")).toBe(false);
  });

  it("shows help for the unified command", async () => {
    const commands = registerCommands(createDeps());
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("", ctx);

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /pinet <action> [args]"),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/pinet start"), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("/pinet skin <theme>"), "info");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("/pinet-start"), "info");
  });

  it("keeps /pinet follow as a no-op for a connected follower", async () => {
    const reloadPinetRuntime = vi.fn(async () => {});
    const commands = registerCommands(
      createDeps({
        runtimeMode: () => "follower",
        runtimeConnected: () => true,
        reloadPinetRuntime,
      }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("follow", ctx);

    expect(reloadPinetRuntime).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Pinet already running (follower)", "info");
  });

  it("reconnects a disconnected follower when /pinet follow is retried", async () => {
    const connectAsFollower = vi.fn(async () => {});
    const reloadPinetRuntime = vi.fn(async () => {});
    const commands = registerCommands(
      createDeps({
        runtimeMode: () => "follower",
        runtimeConnected: () => false,
        connectAsFollower,
        reloadPinetRuntime,
      }),
    );
    const { ctx, notify } = createContext();
    const abort = vi.fn();
    Object.assign(ctx, { isIdle: () => false, abort });

    await commands.get("pinet")?.handler("follow", ctx);

    expect(abort).toHaveBeenCalled();
    expect(connectAsFollower).not.toHaveBeenCalled();
    expect(reloadPinetRuntime).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenCalledWith("Pinet follower disconnected — reconnecting...", "info");
    expect(notify).toHaveBeenCalledWith("🦦 Slate Chalk Otter — following broker", "info");
  });

  it("routes /pinet reload through the existing remote-control message path", async () => {
    const sendPinetAgentMessage = vi.fn(async (target: string, body: string) => ({
      messageId: 42,
      target: `${target}:${body}`,
    }));
    const commands = registerCommands(createDeps({ sendPinetAgentMessage }));
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("reload GoldenOtter", ctx);

    expect(sendPinetAgentMessage).toHaveBeenCalledWith("GoldenOtter", "/reload");
    expect(notify).toHaveBeenCalledWith("Sent /reload to GoldenOtter:/reload", "info");
  });

  it("uses unified usage text for action arguments", async () => {
    const commands = registerCommands(createDeps());
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("reload", ctx);

    expect(notify).toHaveBeenCalledWith("Usage: /pinet reload <agent-name-or-id>", "warning");
  });

  it("snoozes and clears broker RALPH maintenance from the unified command", async () => {
    const snoozeRalphLoop = vi.fn(({ durationMs, reason }) => ({
      active: true,
      until: "2026-04-02T14:30:00.000Z",
      remainingMs: durationMs,
      reason,
      source: "manual" as const,
      emptyCycleCount: 0,
    }));
    const clearRalphSnooze = vi.fn(() => ({
      active: false,
      until: null,
      remainingMs: 0,
      reason: null,
      source: null,
      emptyCycleCount: 0,
    }));
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "broker", snoozeRalphLoop, clearRalphSnooze }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("snooze 30m no work available", ctx);
    await commands.get("pinet")?.handler("snooze off", ctx);

    expect(snoozeRalphLoop).toHaveBeenCalledWith({
      durationMs: 30 * 60_000,
      reason: "no work available",
    });
    expect(clearRalphSnooze).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("RALPH snooze: active"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("RALPH snooze: off"), "info");
  });

  it("starts a subtree broker from a follower without leaving central follower mode", async () => {
    const startSubtreeBroker = vi.fn(createDeps().startSubtreeBroker);
    const commands = registerCommands(
      createDeps({
        runtimeMode: () => "follower",
        brokerRole: () => "follower",
        startSubtreeBroker,
      }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("subtree start", ctx);

    expect(startSubtreeBroker).toHaveBeenCalledWith(ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Subtree broker: running"), "info");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("PINET_SOCKET_PATH=/tmp/pinet-subtrees/worker-1/pinet.sock"),
      "info",
    );
  });

  it("rejects subtree broker start unless this session is a follower", async () => {
    const startSubtreeBroker = vi.fn(createDeps().startSubtreeBroker);
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "broker", startSubtreeBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("subtree start", ctx);

    expect(startSubtreeBroker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        "operations require this session to be running as a Pinet worker/follower",
      ),
      "warning",
    );
  });

  it("stops a running subtree broker from the unified command", async () => {
    const stopSubtreeBroker = vi.fn(async () => {});
    const commands = registerCommands(createDeps({ stopSubtreeBroker }));
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("subtree stop", ctx);

    expect(stopSubtreeBroker).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Subtree broker stopped. Spawned child followers were asked to exit.",
      "info",
    );
  });

  it("spawns a subtree child worker from the unified command", async () => {
    const spawnSubtreeWorker = vi.fn(createDeps().spawnSubtreeWorker);
    const commands = registerCommands(
      createDeps({
        runtimeMode: () => "follower",
        brokerRole: () => "follower",
        spawnSubtreeWorker,
      }),
    );
    const { ctx, notify } = createContext();

    await commands
      .get("pinet")
      ?.handler("subtree spawn repo=extensions role=reviewer lane=issue-761 Review PR #761", ctx);

    expect(spawnSubtreeWorker).toHaveBeenCalledWith(ctx, {
      repo: "extensions",
      role: "reviewer",
      laneId: "issue-761",
      task: "Review PR #761",
    });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Subtree worker started"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("child-1"), "info");
  });

  it("runs free from the unified command and rejects removed skin action", async () => {
    const signalAgentFree = vi.fn(async () => ({ queuedInboxCount: 0, drainedQueuedInbox: false }));
    const commands = registerCommands(createDeps({ signalAgentFree }));
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("free", ctx);
    await commands.get("pinet")?.handler("skin slate chalk", ctx);

    expect(signalAgentFree).toHaveBeenCalledWith(ctx, { requirePinet: true });
    expect(notify).toHaveBeenCalledWith(
      "Marked 🦦 Slate Chalk Otter idle/free for new work.",
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Unknown Pinet action: skin"),
      "warning",
    );
  });
});

describe("/pinet start replace", () => {
  it("replaces the global broker before starting as broker", async () => {
    const callOrder: string[] = [];
    const replaceGlobalBroker = vi.fn(async () => {
      callOrder.push("replace");
      return {
        outcome: "replaced-graceful" as const,
        owner: null,
        steps: ["Graceful shutdown request: accepted."],
        error: null,
      };
    });
    const connectAsBroker = vi.fn(async () => {
      callOrder.push("connect");
    });
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "off", replaceGlobalBroker, connectAsBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("start replace", ctx);

    expect(callOrder).toEqual(["replace", "connect"]);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker replace: replaced-graceful."),
      "info",
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Graceful shutdown request: accepted."),
      "info",
    );
  });

  it("does not start as broker when replacement fails", async () => {
    const replaceGlobalBroker = vi.fn(async () => ({
      outcome: "failed" as const,
      owner: null,
      steps: ["Sending SIGTERM to verified lock owner pid 1336."],
      error: "Broker pid 1336 is still holding the lock after SIGTERM.",
    }));
    const connectAsBroker = vi.fn(async () => {});
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "off", replaceGlobalBroker, connectAsBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("start replace", ctx);

    expect(connectAsBroker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker replace failed: Broker pid 1336"),
      "error",
    );
  });

  it("aborts without starting when the owner changed mid-replacement", async () => {
    const replaceGlobalBroker = vi.fn(async () => ({
      outcome: "owner-changed" as const,
      owner: null,
      steps: [],
      error: "The broker lock changed owners during replacement.",
    }));
    const connectAsBroker = vi.fn(async () => {});
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "off", replaceGlobalBroker, connectAsBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("start replace", ctx);

    expect(connectAsBroker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Pinet broker replace aborted"),
      "error",
    );
  });

  it("rejects unknown start options", async () => {
    const connectAsBroker = vi.fn(async () => {});
    const replaceGlobalBroker = vi.fn(createDeps().replaceGlobalBroker);
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "off", replaceGlobalBroker, connectAsBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("start bogus", ctx);

    expect(connectAsBroker).not.toHaveBeenCalled();
    expect(replaceGlobalBroker).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /pinet start [replace]"),
      "warning",
    );
  });
});

describe("/pinet status — global broker state", () => {
  it("reports machine-wide broker state while disconnected", async () => {
    const inspectGlobalBroker = vi.fn(createDeps().inspectGlobalBroker);
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "off", inspectGlobalBroker }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("status", ctx);

    expect(inspectGlobalBroker).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Global broker: none running on this machine"),
      "info",
    );
  });

  it("reports a stranded broker with recovery guidance", async () => {
    const owner: BrokerLockOwner = {
      pid: 1336,
      processStartTime: "boot-A",
      instanceId: "inst-1",
      hostname: "host",
      createdAt: "2026-07-25T10:00:00.000Z",
      legacy: false,
    };
    const commands = registerCommands(
      createDeps({
        runtimeMode: () => "off",
        inspectGlobalBroker: async () => ({
          lock: { state: "alive", owner },
          probe: "unreachable",
        }),
      }),
    );
    const { ctx, notify } = createContext();

    await commands.get("pinet")?.handler("status", ctx);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("pid 1336 holds the lock"), "info");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/pinet start replace"), "info");
  });

  it("does not inspect global broker state in broker mode", async () => {
    const inspectGlobalBroker = vi.fn(createDeps().inspectGlobalBroker);
    const commands = registerCommands(
      createDeps({ runtimeMode: () => "broker", inspectGlobalBroker }),
    );
    const { ctx } = createContext();

    await commands.get("pinet")?.handler("status", ctx);

    expect(inspectGlobalBroker).not.toHaveBeenCalled();
  });
});

describe("formatGlobalBrokerReport", () => {
  const owner: BrokerLockOwner = {
    pid: 1336,
    processStartTime: "boot-A",
    instanceId: "inst-1",
    hostname: "host",
    createdAt: "2026-07-25T10:00:00.000Z",
    legacy: false,
  };

  it("describes each lock state with a next step", () => {
    expect(
      formatGlobalBrokerReport({ lock: { state: "none", owner: null }, probe: null }),
    ).toContain("none running");
    expect(
      formatGlobalBrokerReport({ lock: { state: "unreadable", owner: null }, probe: null }),
    ).toContain("unreadable lock file");
    expect(
      formatGlobalBrokerReport({ lock: { state: "stale-dead", owner }, probe: null }),
    ).toContain("stale lock from dead pid 1336");
    expect(
      formatGlobalBrokerReport({
        lock: { state: "stale-pid-reused", owner, currentStartTime: "boot-B" },
        probe: null,
      }),
    ).toContain("reused by an unrelated process");
    expect(
      formatGlobalBrokerReport({ lock: { state: "alive", owner }, probe: "healthy" }),
    ).toContain("/pinet follow");
    expect(
      formatGlobalBrokerReport({ lock: { state: "alive", owner }, probe: "unresponsive" }),
    ).toContain("likely stranded");
  });
});

describe("formatPinetCommandHelp", () => {
  it("documents the consolidated primary actions", () => {
    const help = formatPinetCommandHelp();

    expect(help).toContain("/pinet start [replace]");
    expect(help).toContain("/pinet follow");
    expect(help).toContain("/pinet reload <agent>");
    expect(help).toContain("/pinet exit <agent>");
    expect(help).toContain("/pinet free");
    expect(help).toContain("/pinet snooze [duration|off|status]");
    expect(help).toContain("/pinet subtree [start|status|spawn|stop]");
    expect(help).not.toContain("/pinet skin <theme>");
  });
});
