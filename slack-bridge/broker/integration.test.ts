import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { BrokerClient } from "./client.js";
import { runBrokerMaintenancePass } from "./maintenance.js";
import { MessageRouter } from "./router.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broker-integ-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function waitFor(fn: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ─── Integration: client ↔ server ↔ DB ──────────────────

describe("broker integration — client ↔ server ↔ DB", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;
  let client: BrokerClient;

  beforeEach(async () => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 });
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP connect info");

    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();
  });

  afterEach(async () => {
    client.disconnect();
    await server.stop();
    db.close();
    cleanup(dir);
  });

  it("register → send → pollInbox → ack (full path)", async () => {
    // Register two agents
    const reg1 = await client.register("sender-agent", "📤");
    expect(reg1.agentId).toBeDefined();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    const reg2 = await client2.register("receiver-agent", "📥");
    expect(reg2.agentId).toBeDefined();

    // Send a message
    await client.send("thread-1", "Hello from integration test");

    // Verify message stored in DB
    const thread = db.getThread("thread-1");
    expect(thread).not.toBeNull();
    expect(thread!.threadId).toBe("thread-1");

    // Poll inbox of receiver
    const inbox = await client2.pollInbox();
    expect(inbox.length).toBe(1);
    expect(inbox[0].message.body).toBe("Hello from integration test");
    expect(inbox[0].message.threadId).toBe("thread-1");
    expect(inbox[0].inboxId).toBeGreaterThan(0);

    // Ack the message
    await client2.ackMessages([inbox[0].inboxId]);

    // Poll again — should be empty
    const inbox2 = await client2.pollInbox();
    expect(inbox2.length).toBe(0);

    client2.disconnect();
  });

  it("sender does not receive own messages", async () => {
    await client.register("solo-agent", "🤖");
    await client.send("thread-solo", "Talking to myself");

    const inbox = await client.pollInbox();
    expect(inbox.length).toBe(0);
  });

  it("threads.list returns threads owned by agent", async () => {
    await client.register("thread-owner", "🏠");

    await client.send("t-alpha", "First message");
    await client.send("t-beta", "Second message");

    const threads = await client.listThreads();
    expect(threads.length).toBe(2);
    const ids = threads.map((t) => t.threadId).sort();
    expect(ids).toEqual(["t-alpha", "t-beta"]);
  });

  it("register stores the follower's actual PID, not the broker's", async () => {
    const reg = await client.register("pid-agent", "🔢");

    const agents = db.getAgents();
    const agent = agents.find((a) => a.id === reg.agentId);
    expect(agent).toBeDefined();
    // Client and server run in the same process during tests, so PIDs match.
    // The key assertion: the stored PID equals process.pid (what the client sent),
    // not some hardcoded or different value.
    expect(agent!.pid).toBe(process.pid);
  });

  it("agents.list returns all connected agents", async () => {
    await client.register("agent-alpha", "🅰️");

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("agent-beta", "🅱️");

    const agents = await client.listAgents();
    expect(agents.length).toBe(2);
    const names = agents.map((a) => a.name).sort();
    expect(names).toEqual(["agent-alpha", "agent-beta"]);

    client2.disconnect();
  });

  it("invokes status change callbacks when a client explicitly marks itself free", async () => {
    const changes: Array<{ agentId: string; status: "working" | "idle" }> = [];
    server.onAgentStatusChange((agentId, status) => {
      changes.push({ agentId, status });
    });

    const reg = await client.register("free-agent", "🆓");

    await client.updateStatus("working");
    await client.updateStatus("idle");

    expect(changes).toEqual([
      { agentId: reg.agentId, status: "working" },
      { agentId: reg.agentId, status: "idle" },
    ]);
    expect(db.getAgentById(reg.agentId)?.status).toBe("idle");
  });

  it("schedule.create persists a wake-up and delivers it once due", async () => {
    const reg = await client.register("worker-agent", "⏰");

    const wakeup = await client.scheduleWakeup(
      "2026-04-02T14:05:00.000Z",
      "Check whether PR #62 merged",
    );

    expect(wakeup.id).toBeGreaterThan(0);
    expect(db.listScheduledWakeups(reg.agentId)).toHaveLength(1);

    const earlyDeliveries = db.deliverDueScheduledWakeups("2026-04-02T14:04:59.000Z");
    expect(earlyDeliveries).toHaveLength(0);

    const deliveries = db.deliverDueScheduledWakeups("2026-04-02T14:05:00.000Z");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].wakeup.id).toBe(wakeup.id);
    expect(deliveries[0].message.body).toBe("Check whether PR #62 merged");

    const inbox = await client.pollInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("Check whether PR #62 merged");
    expect((inbox[0].message.metadata as Record<string, unknown>).scheduledWakeup).toBe(true);

    await client.ackMessages([inbox[0].inboxId]);
    expect(db.listScheduledWakeups(reg.agentId)).toHaveLength(0);
  });

  it("maintenance assigns unrouted backlog into a follower inbox", async () => {
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");

    const brokerReg = await client.register("broker-agent", "🛰️", { role: "broker" });

    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("worker-agent", "🛠️");

    db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "t-backlog",
        channel: "C-BACKLOG",
        userId: "U1",
        text: "please help",
        timestamp: "200.1",
      },
      "no_route",
    );

    const result = runBrokerMaintenancePass(db, {
      brokerAgentId: brokerReg.agentId,
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(1);

    const inbox = await client2.pollInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.threadId).toBe("t-backlog");
    expect(inbox[0].message.body).toBe("please help");
    expect(db.getThread("t-backlog")?.ownerAgent).not.toBeNull();

    client2.disconnect();
  });

  it("reconnect with same stableId refreshes identity while preserving thread ownership", async () => {
    const reg1 = await client.register("resume-agent", "🔁", undefined, "host:session:/tmp/resume");
    await client.claimThread("t-resume");
    client.disconnect();

    await waitFor(() => db.getAgents().length === 0, 1000);
    expect(db.getThread("t-resume")?.ownerAgent).toBe(reg1.agentId);

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();

    const reg2 = await client2.register(
      "different-name",
      "❌",
      undefined,
      "host:session:/tmp/resume",
    );

    expect(reg2.agentId).toBe(reg1.agentId);
    expect(reg2.name).toBe("different-name");
    expect(reg2.emoji).toBe("❌");

    const threads = await client2.listThreads();
    expect(threads.map((thread) => thread.threadId)).toContain("t-resume");

    client2.disconnect();
  });

  it("explicit unregister releases ownership so follow-up replies are not routed to the dead owner", async () => {
    const reg = await client.register("owner-agent", "🧵");
    await client.claimThread("t-unregister-followup");
    await client.unregister();

    expect(db.getAgents()).toHaveLength(0);
    expect(db.getThread("t-unregister-followup")?.ownerAgent).toBeNull();

    const router = new MessageRouter(db);
    const decision = router.route({
      source: "slack",
      threadId: "t-unregister-followup",
      channel: "C123",
      userId: "U1",
      text: "follow-up after unregister",
      timestamp: "124",
    });

    expect(decision).toEqual({ action: "unrouted" });
    expect(db.getInbox(reg.agentId)).toHaveLength(0);
  });

  it("maintenance pruning disconnects stale agents and releases claims", async () => {
    const reg = await client.register("stale-agent", "💤");
    await client.claimThread("t-stale");

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 0,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.reapedAgentIds).toContain(reg.agentId);
    expect(db.getThread("t-stale")?.ownerAgent).toBeNull();
    expect(db.getAgentById(reg.agentId)).not.toBeNull();
    expect(db.getAgents()).toEqual([]);
  });

  it("stale pruning disconnects silent agents and releases claims", async () => {
    client.disconnect();
    await server.stop();

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, undefined, {
      heartbeatTimeoutMs: 50,
      pruneIntervalMs: 10,
    });
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    const reg = await client.register("stale-agent", "💤");
    await client.claimThread("t-stale");

    await waitFor(() => db.getAgents().length === 0, 1000);
    expect(db.getThread("t-stale")?.ownerAgent).toBeNull();
    expect(db.getAgentById(reg.agentId)).not.toBeNull();
  });

  it("agent.message delivers to target by name", async () => {
    // Register sender
    await client.register("sender-agent", "📤");

    // Connect and register receiver
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("receiver-agent", "📥");

    // Send agent message by name
    const messageId = await client.sendAgentMessage("receiver-agent", "Hello from agent");
    expect(messageId).toBeGreaterThan(0);

    // Receiver should see the message in inbox
    const inbox = await client2.pollInbox();
    expect(inbox.length).toBe(1);
    expect(inbox[0].message.body).toBe("Hello from agent");
    expect(inbox[0].message.source).toBe("agent");
    expect(inbox[0].message.metadata).toBeTruthy();
    expect((inbox[0].message.metadata as Record<string, unknown>).senderAgent).toBe("sender-agent");
    expect((inbox[0].message.metadata as Record<string, unknown>).a2a).toBe(true);

    // Sender should NOT see the message
    const senderInbox = await client.pollInbox();
    expect(senderInbox.length).toBe(0);

    client2.disconnect();
  });

  it("agent.message resolves target by ID", async () => {
    await client.register("alpha", "🅰️");

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    const reg2 = await client2.register("beta", "🅱️");

    // Send by ID instead of name
    const messageId = await client.sendAgentMessage(reg2.agentId, "Hello by ID");
    expect(messageId).toBeGreaterThan(0);

    const inbox = await client2.pollInbox();
    expect(inbox.length).toBe(1);
    expect(inbox[0].message.body).toBe("Hello by ID");

    client2.disconnect();
  });

  it("agent.message preserves control metadata for the target", async () => {
    await client.register("sender-agent", "📤");

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("receiver-agent", "📥");

    await client.sendAgentMessage("receiver-agent", "/reload", {
      kind: "pinet_control",
      command: "reload",
    });

    const inbox = await client2.pollInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("/reload");
    expect(inbox[0].message.metadata).toMatchObject({
      kind: "pinet_control",
      command: "reload",
      a2a: true,
      senderAgent: "sender-agent",
    });

    client2.disconnect();
  });

  it("agent.broadcast rejects connected clients, even with spoofed broker metadata", async () => {
    await client.register("spoofed-broker", "🎭", {
      capabilities: { repo: "extensions", role: "broker", tags: ["repo:extensions"] },
    });

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");

    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("worker-target", "🎯", {
      capabilities: { repo: "extensions", role: "worker", tags: ["repo:extensions"] },
    });

    await expect(client.sendAgentBroadcast("#extensions", "No fan-out")).rejects.toThrow(
      "Broadcast channels are broker-only and cannot be sent by connected clients.",
    );
    expect(await client2.pollInbox()).toHaveLength(0);
    expect(await client.pollInbox()).toHaveLength(0);

    client2.disconnect();
  });

  it("requeued a2a work stays bound to the intended recipient after unregister", async () => {
    const sender = await client.register(
      "sender-agent",
      "📤",
      undefined,
      "host:session:/tmp/sender",
    );

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    const receiverStableId = "host:session:/tmp/receiver";
    const reg2 = await client2.register("receiver-agent", "📥", undefined, receiverStableId);

    const messageId = await client.sendAgentMessage("receiver-agent", "Hold for receiver only");
    expect(messageId).toBeGreaterThan(0);
    await waitFor(() => db.getInbox(reg2.agentId).length === 1);

    await client2.unregister();

    let result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(0);
    expect(result.pendingBacklogCount).toBe(1);
    expect(db.getPendingBacklog()[0].preferredAgentId).toBe(reg2.agentId);
    expect(await client.pollInbox()).toHaveLength(0);

    const reg3 = await client2.register("receiver-agent", "📥", undefined, receiverStableId);
    expect(reg3.agentId).toBe(reg2.agentId);

    result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:20.000Z"),
    });

    expect(result.assignedBacklogCount).toBe(1);
    const inbox = await client2.pollInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("Hold for receiver only");
    expect(inbox[0].message.threadId).toBe(`a2a:${sender.agentId}:${reg2.agentId}`);
    expect(await client.pollInbox()).toHaveLength(0);

    client2.disconnect();
  });

  it("expires requeued a2a work once the intended recipient is purged", async () => {
    await client.register("sender-agent", "📤", undefined, "host:session:/tmp/sender-expire");

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    const reg2 = await client2.register(
      "receiver-agent",
      "📥",
      undefined,
      "host:session:/tmp/receiver-expire",
    );

    await client.sendAgentMessage("receiver-agent", "Expire if receiver is gone");
    await waitFor(() => db.getInbox(reg2.agentId).length === 1);

    await client2.unregister();

    let result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.pendingBacklogCount).toBe(1);
    expect(db.getPendingBacklog()).toHaveLength(1);

    expect(db.purgeDisconnectedAgents(0)).toEqual([reg2.agentId]);

    result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:20.000Z"),
    });

    expect(result.pendingBacklogCount).toBe(0);
    expect(result.anomalies).toContain("expired 1 stale targeted backlog item");
    expect(db.getPendingBacklog()).toHaveLength(0);
    expect(db.getBacklogCount("dropped")).toBe(1);
    expect(await client.pollInbox()).toHaveLength(0);

    client2.disconnect();
  });

  it("agent.message returns error for unknown target", async () => {
    await client.register("lonely-agent", "😢");
    await expect(client.sendAgentMessage("ghost-agent", "Hello?")).rejects.toThrow(
      "Agent not found: ghost-agent",
    );
  });

  it("onAgentMessage callback fires when a message targets an agent", async () => {
    await client.register("sender-worker", "📤");

    // Register a second client as the target
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    const reg2 = await client2.register("target-agent", "🎯");

    // Set up the callback
    const received: { targetId: string; body: string; meta: Record<string, unknown> }[] = [];
    server.onAgentMessage((targetId, msg, meta) => {
      received.push({ targetId, body: msg.body, meta });
    });

    // Worker sends a message to the target
    await client.sendAgentMessage("target-agent", "Hello broker!");

    // Callback should have fired with the target agent's ID
    expect(received).toHaveLength(1);
    expect(received[0].targetId).toBe(reg2.agentId);
    expect(received[0].body).toBe("Hello broker!");
    expect(received[0].meta.senderAgent).toBe("sender-worker");
    expect(received[0].meta.a2a).toBe(true);

    client2.disconnect();
  });

  it("onAgentMessage callback not called for unrelated targets", async () => {
    await client.register("worker-a", "🅰️");

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("worker-b", "🅱️");

    // Callback that only fires for a specific agent
    const brokerId = "fake-broker-id";
    const received: string[] = [];
    server.onAgentMessage((targetId, msg) => {
      if (targetId === brokerId) received.push(msg.body);
    });

    // Message goes to worker-b, not fake-broker-id
    await client.sendAgentMessage("worker-b", "Not for broker");
    expect(received).toHaveLength(0);

    client2.disconnect();
  });

  it("markDeliveredByMessageId marks DB inbox rows as delivered", async () => {
    const reg = await client.register("sender", "📤");

    // Register target directly in DB (simulating broker agent)
    const brokerAgent = db.registerAgent("broker-self", "Broker", "🤖", process.pid, {});

    // Insert a message targeting the broker
    const threadId = `a2a:${reg.agentId}:${brokerAgent.id}`;
    db.createThread(threadId, "agent", "", reg.agentId);
    const msg = db.insertMessage(threadId, "agent", "inbound", reg.agentId, "Test", [
      brokerAgent.id,
    ]);

    // Inbox should have an undelivered entry
    const before = db.getInbox(brokerAgent.id);
    expect(before).toHaveLength(1);
    expect(before[0].entry.delivered).toBe(false);

    // Mark delivered by message ID
    db.markDeliveredByMessageId(msg.id, brokerAgent.id);

    // Inbox should now be empty (delivered = 1)
    const after = db.getInbox(brokerAgent.id);
    expect(after).toHaveLength(0);
  });

  it("slack.proxy returns error when not configured", async () => {
    await client.register("proxy-tester", "🔌");
    await expect(client.slackProxy("chat.postMessage", { channel: "C1" })).rejects.toThrow(
      "slack.proxy is not configured",
    );
  });

  it("slack.proxy works when configured", async () => {
    // Stop and recreate server with slack proxy function
    client.disconnect();
    await server.stop();

    const slackProxy = async (method: string, params: Record<string, unknown>) => {
      return { ok: true, method, echo: params };
    };

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, slackProxy);
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    await client.register("proxy-agent", "🔌");

    const result = await client.slackProxy("conversations.history", { channel: "C123" });
    expect(result.ok).toBe(true);
    expect(result.method).toBe("conversations.history");
    expect((result.echo as Record<string, unknown>).channel).toBe("C123");
  });

  it("thread.claim claims ownership for the calling agent", async () => {
    await client.register("claimer-agent", "🏷️");

    const result = await client.claimThread("t-claim-rpc");
    expect(result.claimed).toBe(true);

    const thread = db.getThread("t-claim-rpc");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBeDefined();
  });

  it("thread.claim rejects when another agent already owns", async () => {
    const reg1 = await client.register("first-agent", "1️⃣");

    // First agent claims
    const first = await client.claimThread("t-contested");
    expect(first.claimed).toBe(true);

    // Second agent tries to claim the same thread
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    const client2 = new BrokerClient({ host: info.host, port: info.port });
    await client2.connect();
    await client2.register("second-agent", "2️⃣");

    const second = await client2.claimThread("t-contested");
    expect(second.claimed).toBe(false);

    // Original owner unchanged
    const thread = db.getThread("t-contested");
    expect(thread!.ownerAgent).toBe(reg1.agentId);

    client2.disconnect();
  });

  it("thread.claim with channel stores channel on new thread", async () => {
    await client.register("ch-claimer", "📺");

    await client.claimThread("t-with-channel", "C-TEST-123");

    const thread = db.getThread("t-with-channel");
    expect(thread).not.toBeNull();
    expect(thread!.channel).toBe("C-TEST-123");
  });

  it("resolveThread returns the broker channel for an existing thread", async () => {
    await client.register("resolver-agent", "🧭");
    db.createThread("t-resolve", "slack", "C-THREAD-1", null);

    await expect(client.resolveThread("t-resolve")).resolves.toBe("C-THREAD-1");
  });

  it("resolveThread returns null for unknown threads", async () => {
    await client.register("resolver-agent", "🧭");

    await expect(client.resolveThread("missing-thread")).resolves.toBeNull();
  });

  it("slack.proxy chat.postMessage auto-claims thread for calling agent", async () => {
    client.disconnect();
    await server.stop();

    const slackProxy = async (_method: string, params: Record<string, unknown>) => {
      // Simulate Slack chat.postMessage response
      return {
        ok: true,
        ts: "new-msg-ts",
        channel: params.channel,
        message: { ts: "new-msg-ts", text: params.text },
      };
    };

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, slackProxy);
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    const reg = await client.register("auto-claimer", "🤖");

    // Post a new message (no thread_ts) — the response ts becomes the thread
    await client.slackProxy("chat.postMessage", {
      channel: "C-AUTO",
      text: "starting a thread",
    });

    const thread = db.getThread("new-msg-ts");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe(reg.agentId);
  });

  it("slack.proxy chat.postMessage with thread_ts claims the existing thread", async () => {
    client.disconnect();
    await server.stop();

    const slackProxy = async (_method: string, params: Record<string, unknown>) => {
      return {
        ok: true,
        ts: "reply-ts",
        channel: params.channel,
        message: { ts: "reply-ts", text: params.text },
      };
    };

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, slackProxy);
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    const reg = await client.register("thread-replier", "💬");

    // Reply to an existing thread
    await client.slackProxy("chat.postMessage", {
      channel: "C-REPLY",
      text: "replying here",
      thread_ts: "existing-thread-ts",
    });

    // Should claim the parent thread, not the reply ts
    const thread = db.getThread("existing-thread-ts");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe(reg.agentId);

    // The reply ts itself should NOT create a separate thread
    expect(db.getThread("reply-ts")).toBeNull();
  });

  it("slack.proxy non-postMessage methods do not claim threads", async () => {
    client.disconnect();
    await server.stop();

    const slackProxy = async (method: string, _params: Record<string, unknown>) => {
      return { ok: true, method, ts: "some-ts" };
    };

    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, slackProxy);
    await server.start();

    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");
    client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    await client.register("readonly-agent", "👀");

    await client.slackProxy("conversations.history", { channel: "C1" });

    // No thread should be created
    expect(db.getThread("some-ts")).toBeNull();
  });
});

// ─── Integration: router with real DB ────────────────────

describe("broker integration — router with real DB", () => {
  let dir: string;
  let db: BrokerDB;

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "router-test.db"));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("routes inbound message to thread owner", () => {
    const router = new MessageRouter(db);

    db.registerAgent("agent-1", "Agent One", "1️⃣", process.pid);
    db.createThread({
      threadId: "t-owned",
      source: "slack",
      channel: "C123",
      ownerAgent: "agent-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const decision = router.route({
      source: "slack",
      threadId: "t-owned",
      channel: "C123",
      userId: "U1",
      text: "hello",
      timestamp: "123",
    });

    expect(decision).toEqual({ action: "deliver", agentId: "agent-1" });
  });

  it("routes by agent mention when no thread owner", () => {
    const router = new MessageRouter(db);

    db.registerAgent("code-bot", "CodeBot", "🤖", process.pid);

    const decision = router.route({
      source: "slack",
      threadId: "t-new",
      channel: "C123",
      userId: "U1",
      text: "hey CodeBot, review this PR",
      timestamp: "456",
    });

    expect(decision).toEqual({ action: "deliver", agentId: "code-bot" });
    expect(db.getThread("t-new")?.ownerAgent).toBe("code-bot");
  });

  it("binds an existing unclaimed thread when a human directly addresses an agent", () => {
    const router = new MessageRouter(db);

    db.registerAgent("code-bot", "CodeBot", "🤖", process.pid);
    db.createThread({
      threadId: "t-known",
      source: "slack",
      channel: "C123",
      ownerAgent: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const firstDecision = router.route({
      source: "slack",
      threadId: "t-known",
      channel: "C123",
      userId: "U1",
      text: "CodeBot can you pick this up?",
      timestamp: "456",
    });

    expect(firstDecision).toEqual({ action: "deliver", agentId: "code-bot" });
    expect(db.getThread("t-known")?.ownerAgent).toBe("code-bot");

    const followUpDecision = router.route({
      source: "slack",
      threadId: "t-known",
      channel: "C123",
      userId: "U1",
      text: "following up without another mention",
      timestamp: "457",
    });

    expect(followUpDecision).toEqual({ action: "deliver", agentId: "code-bot" });
  });

  it("returns unrouted for unknown thread with no matching agent", () => {
    const router = new MessageRouter(db);

    const decision = router.route({
      source: "slack",
      threadId: "t-unknown",
      channel: "C123",
      userId: "U1",
      text: "just a random message",
      timestamp: "789",
    });

    expect(decision).toEqual({ action: "unrouted" });
  });

  it("claimThread assigns ownership via DB", () => {
    const router = new MessageRouter(db);

    db.registerAgent("claimer", "Claimer", "🏷️", process.pid);

    const claimed = router.claimThread("t-unclaimed", "claimer");
    expect(claimed).toBe(true);

    const thread = db.getThread("t-unclaimed");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe("claimer");

    // Second agent cannot claim same thread
    db.registerAgent("latecomer", "Latecomer", "🐢", process.pid);
    const claimed2 = router.claimThread("t-unclaimed", "latecomer");
    expect(claimed2).toBe(false);
  });

  it("queueMessage via interface stores and delivers", () => {
    db.registerAgent("target", "Target", "🎯", process.pid);
    db.createThread("t-queue", "slack", "C1", null);

    db.queueMessage("target", {
      source: "slack",
      threadId: "t-queue",
      channel: "C1",
      userId: "U1",
      userName: "Alice",
      text: "Hello via interface",
      timestamp: "100.200",
    });

    const inbox = db.getInbox("target");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].message.body).toBe("Hello via interface");
    expect(inbox[0].message.sender).toBe("U1");

    // Metadata should contain the extra fields
    const meta = inbox[0].message.metadata as Record<string, unknown>;
    expect(meta.userName).toBe("Alice");
    expect(meta.channel).toBe("C1");
    expect(meta.userId).toBe("U1");
  });

  it("updateThread changes ownership", () => {
    db.registerAgent("a1", "Agent1", "🔵", process.pid);
    db.registerAgent("a2", "Agent2", "🔴", process.pid);
    db.createThread("t-transfer", "slack", "C1", "a1");

    const before = db.getThread("t-transfer");
    expect(before!.ownerAgent).toBe("a1");

    db.updateThread("t-transfer", { ownerAgent: "a2" });

    const after = db.getThread("t-transfer");
    expect(after!.ownerAgent).toBe("a2");
  });

  it("createThread allows null ownerAgent", () => {
    const thread = db.createThread("t-null-owner", "slack", "C1", null);
    expect(thread.ownerAgent).toBeNull();

    const fetched = db.getThread("t-null-owner");
    expect(fetched).not.toBeNull();
    expect(fetched!.ownerAgent).toBeNull();
  });

  it("getAllowedUsers returns null (unconfigured)", () => {
    expect(db.getAllowedUsers()).toBeNull();
  });

  it("getChannelAssignment returns null (unconfigured)", () => {
    expect(db.getChannelAssignment("C123")).toBeNull();
  });

  it("updateThread upserts when thread does not exist", () => {
    // Thread does not exist yet — updateThread should create it
    db.updateThread("t-upsert", { ownerAgent: "agent-1", channel: "C-UPSERT" });

    const thread = db.getThread("t-upsert");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe("agent-1");
    expect(thread!.channel).toBe("C-UPSERT");
    expect(thread!.source).toBe("slack");
  });

  it("updateThread upsert defaults source to slack and channel to empty", () => {
    db.updateThread("t-upsert-defaults", { ownerAgent: "agent-2" });

    const thread = db.getThread("t-upsert-defaults");
    expect(thread).not.toBeNull();
    expect(thread!.source).toBe("slack");
    expect(thread!.channel).toBe("");
    expect(thread!.ownerAgent).toBe("agent-2");
  });

  it("updateThread still works normally for existing threads", () => {
    db.createThread("t-existing", "slack", "C1", "agent-x");

    db.updateThread("t-existing", { ownerAgent: "agent-y" });

    const thread = db.getThread("t-existing");
    expect(thread!.ownerAgent).toBe("agent-y");
    // channel should be unchanged
    expect(thread!.channel).toBe("C1");
  });
});

// ─── Observability (#103) ────────────────────────────────────

describe("idle_since and last_activity tracking", () => {
  let dir: string;
  let db: BrokerDB;

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "obs.db"));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("sets idle_since on registration", () => {
    const agent = db.registerAgent("a-1", "Obs Agent", "🐺", 1);
    expect(agent.status).toBe("idle");
    expect(agent.idleSince).toBeTruthy();
  });

  it("clears idle_since and sets last_activity when transitioning to working", () => {
    db.registerAgent("a-1", "Obs Agent", "🐺", 1);

    db.updateAgentStatus("a-1", "working");
    const working = db.getAgentById("a-1");
    expect(working!.idleSince).toBeNull();
    expect(working!.lastActivity).toBeTruthy();
  });

  it("sets idle_since when transitioning to idle", () => {
    db.registerAgent("a-1", "Obs Agent", "🐺", 1);
    db.updateAgentStatus("a-1", "working");

    db.updateAgentStatus("a-1", "idle");
    const idle = db.getAgentById("a-1");
    expect(idle!.idleSince).toBeTruthy();
    // last_activity should be preserved from when it was working
    expect(idle!.lastActivity).toBeTruthy();
  });

  it("does not overwrite idle_since on repeated idle status updates", () => {
    db.registerAgent("a-1", "Obs Agent", "🐺", 1);

    const first = db.getAgentById("a-1");
    const firstIdleSince = first!.idleSince;

    // Small delay to ensure timestamps differ
    db.updateAgentStatus("a-1", "idle");
    const second = db.getAgentById("a-1");
    expect(second!.idleSince).toBe(firstIdleSince);
  });

  it("touchAgentActivity updates last_activity", () => {
    db.registerAgent("a-1", "Obs Agent", "🐺", 1);
    db.updateAgentStatus("a-1", "working");
    const before = db.getAgentById("a-1");

    db.touchAgentActivity("a-1");
    const after = db.getAgentById("a-1");
    expect(Date.parse(after!.lastActivity!)).toBeGreaterThanOrEqual(
      Date.parse(before!.lastActivity!),
    );
  });
});

describe("ralph_cycles recording", () => {
  let dir: string;
  let db: BrokerDB;

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "cycles.db"));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("records and retrieves ralph cycles", () => {
    const id = db.recordRalphCycle({
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: "2026-04-01T00:00:01.000Z",
      durationMs: 1000,
      ghostAgentIds: ["ghost-1"],
      nudgeAgentIds: ["idle-1"],
      idleDrainAgentIds: ["ready-1"],
      stuckAgentIds: [],
      anomalies: ["ghost agents detected: ghost-1"],
      anomalySignature: "ghost agents detected: ghost-1",
      followUpDelivered: true,
      agentCount: 3,
      backlogCount: 2,
    });

    expect(id).toBeGreaterThan(0);

    const cycles = db.getRecentRalphCycles(10);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].ghostAgentIds).toEqual(["ghost-1"]);
    expect(cycles[0].nudgeAgentIds).toEqual(["idle-1"]);
    expect(cycles[0].stuckAgentIds).toEqual([]);
    expect(cycles[0].followUpDelivered).toBe(true);
    expect(cycles[0].durationMs).toBe(1000);
    expect(cycles[0].agentCount).toBe(3);
    expect(cycles[0].backlogCount).toBe(2);
  });

  it("returns cycles in reverse chronological order", () => {
    db.recordRalphCycle({
      startedAt: "2026-04-01T00:00:00.000Z",
      completedAt: "2026-04-01T00:00:01.000Z",
      durationMs: 1000,
      ghostAgentIds: [],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: [],
      anomalies: [],
      anomalySignature: "",
      followUpDelivered: false,
      agentCount: 1,
      backlogCount: 0,
    });

    db.recordRalphCycle({
      startedAt: "2026-04-01T00:01:00.000Z",
      completedAt: "2026-04-01T00:01:01.000Z",
      durationMs: 1000,
      ghostAgentIds: ["ghost-2"],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: ["stuck-1"],
      anomalies: ["anomaly"],
      anomalySignature: "anomaly",
      followUpDelivered: true,
      agentCount: 2,
      backlogCount: 1,
    });

    const cycles = db.getRecentRalphCycles(10);
    expect(cycles).toHaveLength(2);
    // Most recent first
    expect(cycles[0].startedAt).toBe("2026-04-01T00:01:00.000Z");
    expect(cycles[0].stuckAgentIds).toEqual(["stuck-1"]);
    expect(cycles[1].startedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      db.recordRalphCycle({
        startedAt: `2026-04-01T00:0${i}:00.000Z`,
        completedAt: `2026-04-01T00:0${i}:01.000Z`,
        durationMs: 1000,
        ghostAgentIds: [],
        nudgeAgentIds: [],
        idleDrainAgentIds: [],
        stuckAgentIds: [],
        anomalies: [],
        anomalySignature: "",
        followUpDelivered: false,
        agentCount: 1,
        backlogCount: 0,
      });
    }

    expect(db.getRecentRalphCycles(3)).toHaveLength(3);
  });
});

describe("broker integration — mesh auth", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;

  beforeEach(async () => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "auth.db"));
    db.initialize();
    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 }, undefined, {
      meshSecret: "shared-secret",
      authTimeoutMs: 100,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
  });

  it("accepts clients that present the correct mesh secret", async () => {
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");

    const client = new BrokerClient({
      host: info.host,
      port: info.port,
      meshSecret: "shared-secret",
    });
    await client.connect();

    const reg = await client.register("trusted-agent", "🔐");
    expect(reg.agentId).toBeDefined();

    client.disconnect();
  });

  it("rejects clients that do not authenticate before calling broker methods", async () => {
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");

    const client = new BrokerClient({ host: info.host, port: info.port });
    await client.connect();

    await expect(client.register("intruder", "🚫")).rejects.toThrow(
      "Authentication required before calling broker methods.",
    );
    await waitFor(() => !client.isConnected());
  });

  it("rejects clients that present the wrong mesh secret", async () => {
    const info = server.getConnectInfo();
    if (info.type !== "tcp") throw new Error("Expected TCP");

    const client = new BrokerClient({
      host: info.host,
      port: info.port,
      meshSecret: "wrong-secret",
    });

    await expect(client.connect()).rejects.toThrow("Invalid mesh secret.");
    expect(client.isConnected()).toBe(false);
  });
});
