import fs from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxMessage, PinetControlCommand, SlackBridgeSettings } from "./helpers.js";
import {
  buildSubtreeBrokerPaths,
  createSubtreeBrokerRuntime,
  type SubtreeBrokerRuntime,
  type SubtreeBrokerRuntimeDeps,
} from "./subtree-broker-runtime.js";

const ctx = {} as ExtensionContext;
const runtimes: SubtreeBrokerRuntime[] = [];
const roots: string[] = [];

function createRuntime(
  deliverSteeringMessage: SubtreeBrokerRuntimeDeps["deliverSteeringMessage"],
  stableId = `compaction-gate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  queuedInbox: InboxMessage[] = [],
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
    pushInboxMessages: (messages) => queuedInbox.push(...messages),
    discardQueuedInboxMessages: () => {
      for (let index = queuedInbox.length - 1; index >= 0; index -= 1) {
        if (queuedInbox[index]?.brokerInboxOrigin === "subtree") queuedInbox.splice(index, 1);
      }
    },
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
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop({ releaseIdentity: true })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("subtree broker inbox delivery", () => {
  it("queues each regular inbox entry once and recovers it across restart", async () => {
    const queuedInbox: InboxMessage[] = [];
    const first = createRuntime(() => false, undefined, queuedInbox);
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

    await first.runtime.stop({ releaseIdentity: true });
    expect(queuedInbox).toHaveLength(0);

    const { runtime: restarted } = createRuntime(() => false, first.stableId, queuedInbox);
    await restarted.start(ctx);
    restarted.drainInbox(ctx);
    expect(queuedInbox).toHaveLength(1);

    const inboxId = queuedInbox[0]?.brokerInboxId;
    if (inboxId == null) throw new Error("queued message has no inbox id");
    restarted.markDelivered([inboxId]);

    expect(restarted.getHibernationRuntimeControl()?.db.getPendingInboxCount(selfId)).toBe(0);
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
