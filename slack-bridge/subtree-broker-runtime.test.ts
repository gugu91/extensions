import fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinetControlCommand, SlackBridgeSettings } from "./helpers.js";
import {
  buildSubtreeBrokerPaths,
  createSubtreeBrokerRuntime,
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

interface TmuxLaunchFacts {
  launchId: string;
  sessionName: string;
}

function createTmuxHarness(): {
  run: (args: string[]) => Promise<void>;
  liveSessions: Set<string>;
  killedSessions: string[];
  setOnLaunch: (callback: ((facts: TmuxLaunchFacts) => void) | null) => void;
} {
  const liveSessions = new Set<string>();
  const killedSessions: string[] = [];
  let onLaunch: ((facts: TmuxLaunchFacts) => void) | null = null;

  return {
    liveSessions,
    killedSessions,
    setOnLaunch: (callback) => {
      onLaunch = callback;
    },
    run: async (args) => {
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
        onLaunch?.({ launchId, sessionName });
        return;
      }

      const target = args[args.indexOf("-t") + 1];
      if (args.includes("has-session") && (!target || !liveSessions.has(target))) {
        throw new Error("missing tmux session");
      }
      if (args.includes("kill-session") && target) {
        liveSessions.delete(target);
        killedSessions.push(target);
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

  it("returns a durable timeout handle and cleans up only its tmux session", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `timeout-handle-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
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

    expect(timeoutError?.handle).toMatchObject({
      launchId: expect.any(String),
      tmuxSessionName: expect.any(String),
      socketPath: expect.stringContaining("pinet.sock"),
      state: "launched_unregistered",
    });
    tmux.liveSessions.add("unrelated-session");
    if (!timeoutError) throw new Error("expected registration timeout");
    await runtime.cleanupSpawn(timeoutError.handle);
    expect(tmux.killedSessions).toEqual([timeoutError.handle.tmuxSessionName]);
    expect(tmux.liveSessions).toEqual(new Set(["unrelated-session"]));
  });

  it("adopts a child that registers after the observer timeout", async () => {
    const tmux = createTmuxHarness();
    const { runtime } = createRuntime(
      () => false,
      `late-adoption-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      { runTmuxCommand: tmux.run },
    );
    tmux.setOnLaunch((facts) => {
      setTimeout(() => registerChild(runtime, facts, "late-child"), 15);
    });

    await expect(
      runtime.spawnWorker(ctx, {
        task: "Registers late",
        repo: ".",
        waitForRegistrationMs: 5,
      }),
    ).rejects.toBeInstanceOf(SubtreeSpawnRegistrationTimeoutError);
    expect(runtime.listAgents()?.some((agent) => agent.id === "late-child")).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const lateChild = runtime.listAgents()?.find((agent) => agent.id === "late-child");
    expect(lateChild).toMatchObject({ id: "late-child", parentAgentId: expect.any(String) });
    expect(runtime.getStatus().spawnedWorkers[0]?.agentId).toBe("late-child");
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
