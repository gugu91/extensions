import fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetHibernationActivationAuthorityForTest } from "./broker/hibernation-activation-authority.js";
import { BrokerClient } from "./broker/client.js";
import type { InboxMessage, PinetControlCommand, SlackBridgeSettings } from "./helpers.js";
import {
  buildSubtreeBrokerPaths,
  createSubtreeBrokerRuntime,
  SubtreeSpawnLaunchError,
  SubtreeSpawnRegistrationTimeoutError,
  type SubtreeBrokerRuntime,
  type SubtreeBrokerRuntimeDeps,
} from "./subtree-broker-runtime.js";

const ctx = {} as ExtensionContext;
const runtimes: SubtreeBrokerRuntime[] = [];
const roots: string[] = [];

function createRuntime(
  deliverSteeringMessage: SubtreeBrokerRuntimeDeps["deliverSteeringMessage"],
  stableId = `compaction-gate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  overrides: Partial<SubtreeBrokerRuntimeDeps> = {},
): {
  runtime: SubtreeBrokerRuntime;
  stableId: string;
} {
  const runtime = createSubtreeBrokerRuntime({
    cwd: process.cwd(),
    getSettings: () => ({}) as SlackBridgeSettings,
    getAgentStableId: () => stableId,
    getCentralAgentId: () => null,
    getAgentIdentity: () => ({ name: "Test", emoji: "🧪" }),
    getAgentMetadata: async () => ({}),
    getMeshRoleFromMetadata: (_metadata, fallback) => fallback ?? "worker",
    pushInboxMessages: () => {},
    discardQueuedInboxMessages: () => {},
    updateBadge: () => {},
    maybeDrainInboxIfIdle: () => false,
    deliverSteeringMessage,
    requestRemoteControl: (command: PinetControlCommand) => ({
      currentCommand: null,
      queuedCommand: null,
      accepted: false,
      shouldStartNow: false,
      status: "covered",
      scheduledCommand: command,
      ackDisposition: "immediate",
    }),
    runRemoteControl: () => {},
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  });
  runtimes.push(runtime);
  roots.push(buildSubtreeBrokerPaths(stableId).rootDir);
  return { runtime, stableId };
}

function queueSteeringMessage(runtime: SubtreeBrokerRuntime): string {
  const control = runtime.getHibernationRuntimeControl();
  if (!control) throw new Error("subtree broker did not start");
  const selfId = runtime.getStatus().selfAgentId;
  if (!selfId) throw new Error("subtree broker has no self id");

  const threadId = `a2a:sender:${selfId}`;
  control.db.createThread(threadId, "agent", "", selfId);
  control.db.insertMessage(
    threadId,
    "agent",
    "inbound",
    "sender",
    '{"type":"pinet:steer","message":"wait for compaction"}',
    [selfId],
    { type: "pinet:steer", message: "wait for compaction", kind: "pinet_steer" },
  );
  return selfId;
}

afterEach(async () => {
  await Promise.all(
    runtimes
      .splice(0)
      .map((runtime) => runtime.stop({ releaseIdentity: true, stopChildren: false })),
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subtree broker inbox delivery", () => {
  it("queues each regular inbox entry once and recovers it across restart", async () => {
    const queuedInbox: InboxMessage[] = [];
    const deliveryDeps = {
      pushInboxMessages: (messages: InboxMessage[]) => queuedInbox.push(...messages),
      discardQueuedInboxMessages: () => {
        for (let index = queuedInbox.length - 1; index >= 0; index -= 1) {
          if (queuedInbox[index]?.brokerInboxOrigin === "subtree") queuedInbox.splice(index, 1);
        }
      },
    };
    const first = createRuntime(() => false, undefined, deliveryDeps);
    await first.runtime.start(ctx);
    const control = first.runtime.getHibernationRuntimeControl();
    if (!control) throw new Error("subtree broker did not start");
    const selfId = first.runtime.getStatus().selfAgentId;
    if (!selfId) throw new Error("subtree broker has no self id");
    const threadId = `a2a:sender:${selfId}`;
    control.db.createThread(threadId, "agent", "", selfId);
    control.db.insertMessage(threadId, "agent", "inbound", "sender", "finished the task", [selfId]);

    first.runtime.drainInbox(ctx);
    first.runtime.drainInbox(ctx);

    expect(queuedInbox).toHaveLength(1);
    expect(queuedInbox[0]?.brokerInboxOrigin).toBe("subtree");
    expect(control.db.getPendingInboxCount(selfId)).toBe(1);

    await first.runtime.stop({ releaseIdentity: true, stopChildren: false });
    expect(queuedInbox).toHaveLength(0);

    const second = createRuntime(() => false, first.stableId, {
      ...deliveryDeps,
      maybeDrainInboxIfIdle: () => {
        const inboxIds = queuedInbox.flatMap((message) =>
          message.brokerInboxId == null ? [] : [message.brokerInboxId],
        );
        second.runtime.markDelivered(inboxIds);
        queuedInbox.length = 0;
        return true;
      },
    });
    await second.runtime.start(ctx);

    expect(queuedInbox).toHaveLength(0);
    expect(second.runtime.getHibernationRuntimeControl()?.db.getPendingInboxCount(selfId)).toBe(0);
  });
});

interface TmuxLaunchFacts {
  launchId: string;
  sessionName: string;
}

function createTmuxHarness(): {
  run: (args: string[]) => Promise<void>;
  liveSessions: Set<string>;
  killedSessions: string[];
  commands: string[][];
  setOnLaunch: (callback: ((facts: TmuxLaunchFacts) => void | Promise<void>) | null) => void;
} {
  const liveSessions = new Set<string>();
  const killedSessions: string[] = [];
  const commands: string[][] = [];
  let onLaunch: ((facts: TmuxLaunchFacts) => void | Promise<void>) | null = null;

  return {
    liveSessions,
    killedSessions,
    commands,
    setOnLaunch: (callback) => {
      onLaunch = callback;
    },
    run: async (args) => {
      commands.push(args);
      const newSessionIndex = args.indexOf("new-session");
      if (newSessionIndex >= 0) {
        const sessionName = args[args.indexOf("-s", newSessionIndex) + 1];
        const launcherPath = args.at(-1);
        if (!sessionName || !launcherPath) throw new Error("invalid tmux launch");
        const launchId = fs
          .readFileSync(launcherPath, "utf8")
          .match(/^export PINET_LAUNCH_ID='([^']+)'$/m)?.[1];
        if (!launchId) throw new Error("launcher has no launch id");
        liveSessions.add(sessionName);
        await onLaunch?.({ launchId, sessionName });
        return;
      }

      const target = args[args.indexOf("-t") + 1];
      const matches = target?.startsWith("=")
        ? liveSessions.has(target.slice(1))
          ? [target.slice(1)]
          : []
        : [...liveSessions].filter(
            (session) => session === target || session.startsWith(target ?? ""),
          );
      if (args.includes("has-session") && matches.length !== 1) {
        if (matches.length === 0) {
          throw Object.assign(new Error(`can't find session: ${target}`), {
            stderr: `can't find session: ${target}`,
          });
        }
        throw new Error("ambiguous tmux session");
      }
      if (args.includes("kill-session")) {
        if (matches.length !== 1) {
          throw Object.assign(new Error(`can't find session: ${target}`), {
            stderr: `can't find session: ${target}`,
          });
        }
        const [matchedSession] = matches;
        liveSessions.delete(matchedSession);
        killedSessions.push(matchedSession);
      }
    },
  };
}

function registerChild(
  runtime: SubtreeBrokerRuntime,
  facts: TmuxLaunchFacts,
  agentId: string,
): void {
  const control = runtime.getHibernationRuntimeControl();
  const parentAgentId = runtime.getStatus().selfAgentId;
  if (!control || !parentAgentId) throw new Error("subtree broker did not start");
  control.db.registerAgent(agentId, `Child ${agentId}`, "🌱", process.pid, {
    parentAgentId,
    launchId: facts.launchId,
    tmuxSession: facts.sessionName,
  });
}

describe("subtree broker spawn lifecycle", () => {
  it("single-flights cold broker startup across concurrent spawns", async () => {
    const tmux = createTmuxHarness();
    const getAgentMetadata = vi.fn(async () => ({}));
    const { runtime } = createRuntime(
      () => false,
      `single-flight-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { getAgentMetadata, runTmuxCommand: tmux.run },
    );
    let childNumber = 0;
    tmux.setOnLaunch((facts) => {
      childNumber += 1;
      registerChild(runtime, facts, `child-${childNumber}`);
    });

    const results = await Promise.all([
      runtime.spawnWorker(ctx, { task: "Task one", repo: "." }),
      runtime.spawnWorker(ctx, { task: "Task two", repo: "." }),
      runtime.spawnWorker(ctx, { task: "Task three", repo: "." }),
    ]);

    expect(results).toHaveLength(3);
    expect(new Set(results.map((result) => result.agentId)).size).toBe(3);
    expect(getAgentMetadata).toHaveBeenCalledTimes(1);
    expect(tmux.liveSessions.size).toBe(3);
    expect(
      runtime.getStatus().spawnedWorkers.every((worker) => worker.runtimeKind === "tmux"),
    ).toBe(true);
  });

  it("selects Herdr only when explicitly configured", async () => {
    const tmuxRun = vi.fn(async () => {});
    let launchId = "";
    let sessionName = "";
    const runHerdrCommand = vi.fn(async (args: string[]) => {
      if (args.includes("create")) {
        launchId =
          args
            .find((value) => value.startsWith("PINET_LAUNCH_ID="))
            ?.slice("PINET_LAUNCH_ID=".length) ?? "";
        sessionName = args[args.indexOf("--label") + 1] ?? "";
        return JSON.stringify({ result: { root_pane: { pane_id: "w1:p2" } } });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({ result: { process_info: { shell_pid: 4242 } } });
      }
      if (args.includes("run")) {
        const control = runtime.getHibernationRuntimeControl();
        const parentAgentId = runtime.getStatus().selfAgentId;
        if (!control || !parentAgentId || !launchId) throw new Error("missing launch facts");
        control.db.registerAgent("herdr-child", "Herdr Child", "🌱", process.pid, {
          parentAgentId,
          launchId,
        });
      }
      return "{}";
    });
    const { runtime } = createRuntime(
      () => false,
      `herdr-selection-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      {
        getSettings: () => ({ subtreeWorkerRuntime: "herdr" }),
        runTmuxCommand: tmuxRun,
        runHerdrCommand,
      },
    );

    const result = await runtime.spawnWorker(ctx, { task: "Run in Herdr", repo: "." });

    expect(result.agentId).toBe("herdr-child");
    expect(result.sessionName).toBe(sessionName);
    expect(result.childLaunchEnv.PINET_LAUNCH_SOURCE).toBe("broker-herdr");
    expect(result.childLaunchEnv).not.toHaveProperty("PINET_TMUX_SESSION");
    expect(result.monitorCommand).toContain("herdr session attach");
    expect(runtime.getStatus().spawnedWorkers[0]).toMatchObject({
      runtimeKind: "herdr",
      herdrPaneId: "w1:p2",
      herdrShellPid: 4242,
    });
    expect(tmuxRun).not.toHaveBeenCalled();
  });

  it("fails clearly instead of substituting tmux when configured Herdr is unavailable", async () => {
    const tmuxRun = vi.fn(async () => {});
    const unavailable = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
    const { runtime } = createRuntime(
      () => false,
      `herdr-unavailable-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      {
        getSettings: () => ({ subtreeWorkerRuntime: "herdr" }),
        runTmuxCommand: tmuxRun,
        runHerdrCommand: async () => {
          throw unavailable;
        },
      },
    );

    await expect(runtime.spawnWorker(ctx, { task: "Run in Herdr", repo: "." })).rejects.toThrow(
      "Herdr worker runtime is configured but the 'herdr' executable is unavailable",
    );
    expect(tmuxRun).not.toHaveBeenCalled();
  });

  it("keeps tmux and Herdr workers isolated under one broker", async () => {
    const originalActivation = process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION;
    process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION = "1";
    __resetHibernationActivationAuthorityForTest();

    try {
      const tmux = createTmuxHarness();
      const herdrCommands: string[][] = [];
      const meshSecret = "mixed-fleet-secret";
      let configuredRuntime: "tmux" | "herdr" = "tmux";
      let herdrLaunchId = "";
      let herdrSessionName = "";
      const childClients: BrokerClient[] = [];
      const registerMixedChild = async (
        agentId: string,
        name: string,
        launchId: string,
        metadata: Record<string, unknown>,
      ): Promise<void> => {
        const socketPath = runtime.getStatus().paths?.socketPath;
        if (!socketPath) throw new Error("subtree broker did not start");
        const child = new BrokerClient({ path: socketPath, meshSecret });
        childClients.push(child);
        await child.connect();
        await child.register(
          name,
          "🌱",
          { ...metadata, launchId },
          `test:session:/tmp/${agentId}.jsonl`,
        );
      };
      const runHerdrCommand = async (args: string[]): Promise<string> => {
        herdrCommands.push(args);
        if (args.includes("create")) {
          herdrLaunchId =
            args
              .find((value) => value.startsWith("PINET_LAUNCH_ID="))
              ?.slice("PINET_LAUNCH_ID=".length) ?? "";
          herdrSessionName = args[args.indexOf("--label") + 1] ?? "";
          return JSON.stringify({ result: { root_pane: { pane_id: "w1:p23" } } });
        }
        if (args.includes("process-info")) {
          return JSON.stringify({ result: { process_info: { shell_pid: 2323 } } });
        }
        if (args.includes("run")) {
          const parentAgentId = runtime.getStatus().selfAgentId;
          if (!parentAgentId || !herdrLaunchId) throw new Error("missing Herdr launch facts");
          await registerMixedChild("mixed-herdr-child", "Mixed Herdr Child", herdrLaunchId, {
            parentAgentId,
          });
        }
        return "{}";
      };
      const { runtime } = createRuntime(
        () => false,
        `mixed-fleet-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        {
          getSettings: () => ({ subtreeWorkerRuntime: configuredRuntime, meshSecret }),
          runTmuxCommand: tmux.run,
          runHerdrCommand,
        },
      );
      tmux.setOnLaunch(async (facts) => {
        const parentAgentId = runtime.getStatus().selfAgentId;
        if (!parentAgentId) throw new Error("subtree broker did not start");
        await registerMixedChild("mixed-tmux-child", "Mixed tmux Child", facts.launchId, {
          parentAgentId,
          tmuxSession: facts.sessionName,
        });
      });

      const tmuxResult = await runtime.spawnWorker(ctx, { task: "Run in tmux", repo: "." });
      configuredRuntime = "herdr";
      const herdrResult = await runtime.spawnWorker(ctx, { task: "Run in Herdr", repo: "." });
      const control = runtime.getHibernationRuntimeControl();
      if (!control) throw new Error("subtree broker did not start");
      const tmuxSpec = control.db.getAgentRuntimeSpec(tmuxResult.agentId);
      const herdrSpec = control.db.getAgentRuntimeSpec(herdrResult.agentId);
      const tmuxMetadata = control.db.getAgentById(tmuxResult.agentId)?.metadata;
      const herdrMetadata = control.db.getAgentById(herdrResult.agentId)?.metadata;
      const workerRecords = runtime.getStatus().spawnedWorkers;

      await runtime.stop();

      expect(tmuxResult).toMatchObject({
        agentName: "Mixed tmux Child",
        runtimeKind: "tmux",
      });
      expect(tmuxResult.monitorCommand).toContain("tmux ");
      expect(herdrResult).toMatchObject({
        agentName: "Mixed Herdr Child",
        runtimeKind: "herdr",
        sessionName: herdrSessionName,
      });
      expect(herdrResult.monitorCommand).toContain("herdr session attach");
      expect(workerRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentId: tmuxResult.agentId,
            runtimeKind: "tmux",
            sessionName: tmuxResult.sessionName,
          }),
          expect.objectContaining({
            agentId: herdrResult.agentId,
            runtimeKind: "herdr",
            sessionName: herdrResult.sessionName,
            herdrPaneId: "w1:p23",
            herdrShellPid: 2323,
          }),
        ]),
      );
      expect(tmuxSpec).toMatchObject({
        runtimeKind: "tmux",
        tmuxSession: tmuxResult.sessionName,
      });
      expect(herdrSpec).toMatchObject({
        runtimeKind: "herdr",
        herdrSession: "pinet-workers",
        herdrPaneId: "w1:p23",
        herdrShellPid: 2323,
      });
      expect(tmuxMetadata).toMatchObject({
        runtimeKind: "tmux",
        runtimeLocator: tmuxResult.sessionName,
        tmuxSession: tmuxResult.sessionName,
      });
      expect(herdrMetadata).toMatchObject({
        runtimeKind: "herdr",
        runtimeLocator: "w1:p23",
      });
      expect(herdrMetadata).not.toHaveProperty("tmuxSession");
      expect(tmux.killedSessions).toEqual([tmuxResult.sessionName]);
      expect(herdrCommands.filter((args) => args.includes("close"))).toEqual([
        ["--session", "pinet-workers", "pane", "close", "w1:p23"],
      ]);
      expect(tmux.commands.flat()).not.toContain("w1:p23");
      expect(herdrCommands.flat()).not.toContain(tmuxResult.sessionName);
      for (const child of childClients) child.disconnect();
    } finally {
      if (originalActivation === undefined) {
        delete process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION;
      } else {
        process.env.PINET_HIBERNATION_RUNTIME_ACTIVATION = originalActivation;
      }
      __resetHibernationActivationAuthorityForTest();
    }
  }, 15_000);

  it.each(["tmux", "herdr"] as const)(
    "dispatches broker-stop cleanup to the recorded %s runtime",
    async (runtimeKind) => {
      const tmux = createTmuxHarness();
      const herdrCommands: string[][] = [];
      const runHerdrCommand = async (args: string[]): Promise<string> => {
        herdrCommands.push(args);
        if (args.includes("create")) {
          return JSON.stringify({ result: { root_pane: { pane_id: "w1:p9" } } });
        }
        if (args.includes("process-info")) {
          return JSON.stringify({ result: { process_info: { shell_pid: 9009 } } });
        }
        return "{}";
      };
      const { runtime } = createRuntime(
        () => false,
        `stop-${runtimeKind}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
        {
          getSettings: () => ({ subtreeWorkerRuntime: runtimeKind }),
          runTmuxCommand: tmux.run,
          runHerdrCommand,
        },
      );

      await expect(
        runtime.spawnWorker(ctx, {
          task: `Run in ${runtimeKind}`,
          repo: ".",
          waitForRegistrationMs: 2,
        }),
      ).rejects.toBeInstanceOf(SubtreeSpawnRegistrationTimeoutError);
      await runtime.stop();

      if (runtimeKind === "tmux") {
        expect(tmux.killedSessions).toHaveLength(1);
        expect(herdrCommands).toHaveLength(0);
      } else {
        expect(tmux.killedSessions).toHaveLength(0);
        expect(herdrCommands.some((args) => args.includes("close"))).toBe(true);
      }
    },
  );

  it("single-flights public start with automatic spawn startup", async () => {
    const tmux = createTmuxHarness();
    const getAgentMetadata = vi.fn(async () => ({}));
    const { runtime } = createRuntime(
      () => false,
      `public-start-flight-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { getAgentMetadata, runTmuxCommand: tmux.run },
    );
    tmux.setOnLaunch((facts) => registerChild(runtime, facts, "spawn-child"));

    const [, spawned] = await Promise.all([
      runtime.start(ctx),
      runtime.spawnWorker(ctx, { task: "Spawn while starting", repo: "." }),
    ]);

    expect(spawned.agentId).toBe("spawn-child");
    expect(getAgentMetadata).toHaveBeenCalledTimes(1);
  });

  it("validates empty spawn inputs before starting the broker", async () => {
    const getAgentMetadata = vi.fn(async () => ({}));
    const { runtime } = createRuntime(
      () => false,
      `spawn-validation-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { getAgentMetadata },
    );

    await expect(runtime.spawnWorker(ctx, { task: "", repo: "." })).rejects.toThrow(
      "spawn requires task",
    );
    await expect(runtime.spawnWorker(ctx, { task: "Task", repo: "" })).rejects.toThrow(
      "spawn requires repo",
    );
    expect(getAgentMetadata).not.toHaveBeenCalled();
    expect(runtime.isActive()).toBe(false);
  });

  it("stops a broker when post-listen initialization fails so startup can retry", async () => {
    const tmux = createTmuxHarness();
    const getAgentMetadata = vi
      .fn<SubtreeBrokerRuntimeDeps["getAgentMetadata"]>()
      .mockRejectedValueOnce(new Error("metadata unavailable"))
      .mockResolvedValue({});
    const { runtime } = createRuntime(
      () => false,
      `startup-rollback-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { getAgentMetadata, runTmuxCommand: tmux.run },
    );

    await expect(runtime.start(ctx)).rejects.toThrow("metadata unavailable");
    tmux.setOnLaunch((facts) => registerChild(runtime, facts, "retry-child"));

    await expect(
      runtime.spawnWorker(ctx, { task: "Retry startup", repo: "." }),
    ).resolves.toMatchObject({
      agentId: "retry-child",
    });
    expect(getAgentMetadata).toHaveBeenCalledTimes(2);
  });

  it("uses the launch-time tmux socket when cleanup runs after the environment changes", async () => {
    const tmux = createTmuxHarness();
    const stableId = `launch-tmux-socket-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const rootDir = buildSubtreeBrokerPaths(stableId).rootDir;
    const launchSocketDir = `${rootDir}/launch-tmux`;
    const cleanupSocketDir = `${rootDir}/cleanup-tmux`;
    const launchSocketPath = `${launchSocketDir}/claude.sock`;
    const cleanupSocketPath = `${cleanupSocketDir}/claude.sock`;
    fs.mkdirSync(launchSocketDir, { recursive: true });
    fs.mkdirSync(cleanupSocketDir, { recursive: true });
    fs.writeFileSync(launchSocketPath, "");
    fs.writeFileSync(cleanupSocketPath, "");
    const originalTmux = process.env.TMUX;
    const originalClaudeTmuxSocketDir = process.env.CLAUDE_TMUX_SOCKET_DIR;

    try {
      process.env.TMUX = `${launchSocketPath},1,0`;
      process.env.CLAUDE_TMUX_SOCKET_DIR = launchSocketDir;
      const { runtime } = createRuntime(() => false, stableId, { runTmuxCommand: tmux.run });

      let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
      try {
        await runtime.spawnWorker(ctx, {
          task: "Never registers",
          repo: ".",
          waitForRegistrationMs: 5,
        });
      } catch (error) {
        if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
        else throw error;
      }
      if (!timeoutError) throw new Error("expected registration timeout");

      tmux.setOnLaunch((facts) => registerChild(runtime, facts, "replacement-child"));
      process.env.TMUX = `${cleanupSocketPath},2,0`;
      process.env.CLAUDE_TMUX_SOCKET_DIR = cleanupSocketDir;
      await runtime.spawnWorker(ctx, {
        task: "Retry",
        repo: ".",
        cleanupHandle: timeoutError.handle,
      });

      const cleanupCommands = tmux.commands.filter(
        (args) => args.includes("has-session") || args.includes("kill-session"),
      );
      expect(cleanupCommands).toHaveLength(2);
      for (const args of cleanupCommands) {
        expect(args.slice(0, 2)).toEqual(["-S", launchSocketPath]);
        expect(args).not.toContain(cleanupSocketPath);
      }
    } finally {
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
      if (originalClaudeTmuxSocketDir === undefined) delete process.env.CLAUDE_TMUX_SOCKET_DIR;
      else process.env.CLAUDE_TMUX_SOCKET_DIR = originalClaudeTmuxSocketDir;
    }
  });

  it("rejects a cleanup handle without a live launch record", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `authenticated-cleanup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand: tmux.run },
    );
    await runtime.start(ctx);
    const socketPath = runtime.getStatus().paths?.socketPath;
    if (!socketPath) throw new Error("subtree broker did not start");
    tmux.liveSessions.add("caller-controlled");

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Do not launch",
        repo: ".",
        cleanupHandle: {
          launchId: "unknown-launch",
          tmuxSessionName: "caller-controlled",
          socketPath,
          state: "launched_unregistered",
        },
      }),
    ).rejects.toThrow("spawn cleanup handle does not belong to this subtree broker");
    expect(tmux.liveSessions).toEqual(new Set(["caller-controlled"]));
  });

  it("cleans up a timed-out launch by handle before retrying", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `retry-cleanup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand: tmux.run },
    );
    let launchCount = 0;
    tmux.setOnLaunch((facts) => {
      launchCount += 1;
      if (launchCount === 2) registerChild(runtime, facts, "retry-child");
    });

    let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Retry me",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
      else throw error;
    }
    if (!timeoutError) throw new Error("expected registration timeout");

    const retried = await runtime.spawnWorker(ctx, {
      task: "Retry me",
      repo: ".",
      cleanupHandle: timeoutError.handle,
    });

    expect(tmux.killedSessions).toEqual([timeoutError.handle.tmuxSessionName]);
    expect(tmux.liveSessions).toEqual(new Set([retried.sessionName]));
    expect(runtime.listAgents()?.filter((agent) => agent.parentAgentId)).toHaveLength(1);
    expect(retried.agentId).toBe("retry-child");

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Retry me",
        repo: ".",
        cleanupHandle: timeoutError.handle,
      }),
    ).rejects.toThrow("spawn cleanup handle has already been consumed");
    expect(launchCount).toBe(2);
  });

  it("does not kill a prefix-related session when the timed-out session already exited", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `exact-cleanup-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand: tmux.run },
    );

    let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Never registers",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
      else throw error;
    }
    if (!timeoutError) throw new Error("expected registration timeout");

    tmux.liveSessions.delete(timeoutError.handle.tmuxSessionName);
    const prefixSession = `${timeoutError.handle.tmuxSessionName}-extra`;
    tmux.liveSessions.add(prefixSession);
    tmux.setOnLaunch((facts) => registerChild(runtime, facts, "replacement-child"));
    const replacement = await runtime.spawnWorker(ctx, {
      task: "Retry",
      repo: ".",
      cleanupHandle: timeoutError.handle,
    });

    expect(tmux.killedSessions).toEqual([]);
    expect(tmux.liveSessions).toEqual(new Set([prefixSession, replacement.sessionName]));
  });

  it("retries when the timed-out session was the last session on the tmux server", async () => {
    const tmux = createTmuxHarness();
    let serverMissing = false;
    const runTmuxCommand = async (args: string[]): Promise<void> => {
      if (serverMissing && args.includes("has-session")) {
        throw Object.assign(new Error("no server running on /tmp/tmux.sock"), {
          stderr: "no server running on /tmp/tmux.sock",
        });
      }
      if (args.includes("new-session")) serverMissing = false;
      await tmux.run(args);
    };
    const { runtime } = createRuntime(
      () => false,
      `missing-tmux-server-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand },
    );

    let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Never registers",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
      else throw error;
    }
    if (!timeoutError) throw new Error("expected registration timeout");

    tmux.liveSessions.clear();
    serverMissing = true;
    tmux.setOnLaunch((facts) => registerChild(runtime, facts, "replacement-child"));
    await expect(
      runtime.spawnWorker(ctx, {
        task: "Retry",
        repo: ".",
        cleanupHandle: timeoutError.handle,
      }),
    ).resolves.toMatchObject({ agentId: "replacement-child" });
  });

  it("returns a cleanup handle when tmux reports an ambiguous launch failure", async () => {
    const tmux = createTmuxHarness();
    let failLaunch = true;
    const runTmuxCommand = async (args: string[]): Promise<void> => {
      await tmux.run(args);
      if (failLaunch && args.includes("new-session")) {
        failLaunch = false;
        throw new Error("tmux transport closed");
      }
    };
    const { runtime } = createRuntime(
      () => false,
      `ambiguous-launch-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand },
    );

    let launchError: SubtreeSpawnLaunchError | null = null;
    try {
      await runtime.spawnWorker(ctx, { task: "Launch ambiguously", repo: "." });
    } catch (error) {
      if (error instanceof SubtreeSpawnLaunchError) launchError = error;
      else throw error;
    }
    if (!launchError) throw new Error("expected ambiguous launch failure");
    expect(tmux.liveSessions).toEqual(new Set([launchError.handle.tmuxSessionName]));

    tmux.setOnLaunch((facts) => registerChild(runtime, facts, "replacement-child"));
    const replacement = await runtime.spawnWorker(ctx, {
      task: "Retry",
      repo: ".",
      cleanupHandle: launchError.handle,
    });

    expect(tmux.killedSessions).toEqual([launchError.handle.tmuxSessionName]);
    expect(tmux.liveSessions).toEqual(new Set([replacement.sessionName]));
  });

  it("keeps a retry handle consumed when its replacement also times out", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `retry-timeout-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand: tmux.run },
    );
    let launchCount = 0;
    tmux.setOnLaunch((facts) => {
      launchCount += 1;
      if (launchCount === 3) registerChild(runtime, facts, "recovered-child");
    });

    let originalTimeout: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Original attempt",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) originalTimeout = error;
      else throw error;
    }
    if (!originalTimeout) throw new Error("expected original registration timeout");

    let replacementTimeout: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Replacement attempt",
        repo: ".",
        waitForRegistrationMs: 5,
        cleanupHandle: originalTimeout.handle,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) replacementTimeout = error;
      else throw error;
    }
    if (!replacementTimeout) throw new Error("expected replacement registration timeout");

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Do not launch another replacement",
        repo: ".",
        cleanupHandle: originalTimeout.handle,
      }),
    ).rejects.toThrow("spawn cleanup handle has already been consumed");
    expect(launchCount).toBe(2);
    expect(tmux.liveSessions).toEqual(new Set([replacementTimeout.handle.tmuxSessionName]));

    const recovered = await runtime.spawnWorker(ctx, {
      task: "Recover using the replacement handle",
      repo: ".",
      cleanupHandle: replacementTimeout.handle,
    });

    expect(launchCount).toBe(3);
    expect(tmux.liveSessions).toEqual(new Set([recovered.sessionName]));
    expect(runtime.listAgents()?.filter((agent) => agent.parentAgentId)).toHaveLength(1);
    expect(recovered.agentId).toBe("recovered-child");
  });

  it("keeps a retry handle retryable when cleanup fails before replacement launch", async () => {
    const tmux = createTmuxHarness();
    let failProbe = false;
    let launchCount = 0;
    const runTmuxCommand = async (args: string[]): Promise<void> => {
      if (failProbe && args.includes("has-session")) {
        throw new Error("tmux transport unavailable");
      }
      await tmux.run(args);
    };
    const { runtime } = createRuntime(
      () => false,
      `cleanup-failure-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand },
    );
    tmux.setOnLaunch(() => {
      launchCount += 1;
    });

    let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Retry cleanup failure",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
      else throw error;
    }
    if (!timeoutError) throw new Error("expected registration timeout");

    failProbe = true;
    await expect(
      runtime.spawnWorker(ctx, {
        task: "Must not relaunch",
        repo: ".",
        cleanupHandle: timeoutError.handle,
      }),
    ).rejects.toThrow("tmux transport unavailable");
    expect(launchCount).toBe(1);
    expect(tmux.liveSessions).toEqual(new Set([timeoutError.handle.tmuxSessionName]));

    failProbe = false;
    tmux.setOnLaunch((facts) => {
      launchCount += 1;
      registerChild(runtime, facts, "retry-child");
    });
    const replacement = await runtime.spawnWorker(ctx, {
      task: "Retry after transport recovery",
      repo: ".",
      cleanupHandle: timeoutError.handle,
    });

    expect(replacement.agentId).toBe("retry-child");
    expect(launchCount).toBe(2);

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Must not launch twice",
        repo: ".",
        cleanupHandle: timeoutError.handle,
      }),
    ).rejects.toThrow("spawn cleanup handle has already been consumed");
    expect(launchCount).toBe(2);
  });

  it("disconnects a child accepted after the final timeout lookup", async () => {
    const tmux = createTmuxHarness();
    const meshSecret = "timeout-race-secret";
    let launchFacts: TmuxLaunchFacts | null = null;
    const racingClients: BrokerClient[] = [];
    const runTmuxCommand = async (args: string[]): Promise<void> => {
      await tmux.run(args);
      if (args.includes("send-keys") && args.at(-1) === "Enter" && launchFacts) {
        const socketPath = runtime.getStatus().paths?.socketPath;
        if (!socketPath) throw new Error("subtree broker did not start");
        const racingClient = new BrokerClient({ path: socketPath, meshSecret });
        racingClients.push(racingClient);
        await racingClient.connect();
        await racingClient.register("Racing Child", "🌱", {
          parentAgentId: runtime.getStatus().selfAgentId,
          launchId: launchFacts.launchId,
          tmuxSession: launchFacts.sessionName,
        });
      }
    };
    const { runtime } = createRuntime(
      () => false,
      `timeout-race-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      {
        getSettings: () => ({ meshSecret }) as SlackBridgeSettings,
        runTmuxCommand,
      },
    );
    tmux.setOnLaunch((facts) => {
      launchFacts = facts;
    });

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Race the timeout",
        repo: ".",
        waitForRegistrationMs: 5,
      }),
    ).rejects.toBeInstanceOf(SubtreeSpawnRegistrationTimeoutError);
    const racingClient = racingClients[0];
    if (!racingClient) throw new Error("racing client did not register");
    await expect(racingClient.heartbeat()).rejects.toThrow();

    const db = runtime.getHibernationRuntimeControl()?.db;
    const racingAgent = db
      ?.getAllAgents()
      .find((agent) => agent.metadata?.launchId === launchFacts?.launchId);
    expect(racingAgent?.disconnectedAt).not.toBeNull();
  });

  it("fences a launch when it times out so late registration cannot survive retry", async () => {
    const tmux = createTmuxHarness();
    const meshSecret = "fenced-retry-secret";
    let launchCount = 0;
    const { runtime } = createRuntime(
      () => false,
      `fenced-retry-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      {
        getSettings: () => ({ meshSecret }) as SlackBridgeSettings,
        runTmuxCommand: tmux.run,
      },
    );
    tmux.setOnLaunch((facts) => {
      launchCount += 1;
      if (launchCount === 2) registerChild(runtime, facts, "replacement-child");
    });

    let timeoutError: SubtreeSpawnRegistrationTimeoutError | null = null;
    try {
      await runtime.spawnWorker(ctx, {
        task: "Retry racing registration",
        repo: ".",
        waitForRegistrationMs: 5,
      });
    } catch (error) {
      if (error instanceof SubtreeSpawnRegistrationTimeoutError) timeoutError = error;
      else throw error;
    }
    if (!timeoutError) throw new Error("expected registration timeout");

    const lateClient = new BrokerClient({ path: timeoutError.handle.socketPath, meshSecret });
    await lateClient.connect();
    await expect(
      lateClient.register("Late Old Child", "🌱", {
        parentAgentId: runtime.getStatus().selfAgentId,
        launchId: timeoutError.handle.launchId,
        tmuxSession: timeoutError.handle.tmuxSessionName,
      }),
    ).rejects.toThrow("spawn launch has already been cleaned up");
    lateClient.disconnect();

    const replacement = await runtime.spawnWorker(ctx, {
      task: "Retry racing registration",
      repo: ".",
      cleanupHandle: timeoutError.handle,
    });
    const db = runtime.getHibernationRuntimeControl()?.db;
    expect(replacement.agentId).toBe("replacement-child");
    expect(db?.getAgents().filter((agent) => agent.parentAgentId)).toHaveLength(1);
    expect(tmux.liveSessions).toEqual(new Set([replacement.sessionName]));
  });
});

describe("subtree broker compaction delivery retry", () => {
  it("leaves rejected steering durable and retries it explicitly", async () => {
    let canDeliver = false;
    const deliverSteeringMessage = vi.fn(() => canDeliver);
    const { runtime } = createRuntime(deliverSteeringMessage);
    await runtime.start(ctx);
    const selfId = queueSteeringMessage(runtime);

    runtime.drainInbox(ctx);
    const db = runtime.getHibernationRuntimeControl()?.db;
    expect(deliverSteeringMessage).toHaveBeenCalledTimes(1);
    expect(db?.getPendingInboxCount(selfId)).toBe(1);

    canDeliver = true;
    runtime.drainInbox(ctx);
    expect(deliverSteeringMessage).toHaveBeenCalledTimes(2);
    expect(db?.getPendingInboxCount(selfId)).toBe(0);
  });

  it("recovers rejected steering after a subtree broker restart", async () => {
    let canDeliver = false;
    const deliverSteeringMessage = vi.fn(() => canDeliver);
    const first = createRuntime(deliverSteeringMessage);
    await first.runtime.start(ctx);
    queueSteeringMessage(first.runtime);
    first.runtime.drainInbox(ctx);
    await first.runtime.stop({ releaseIdentity: true });

    canDeliver = true;
    const { runtime: restarted } = createRuntime(deliverSteeringMessage, first.stableId);
    await restarted.start(ctx);

    const selfId = restarted.getStatus().selfAgentId;
    expect(deliverSteeringMessage).toHaveBeenCalledTimes(2);
    expect(selfId).not.toBeNull();
    expect(
      selfId
        ? restarted.getHibernationRuntimeControl()?.db.getPendingInboxCount(selfId)
        : undefined,
    ).toBe(0);
  });
});
