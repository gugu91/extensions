import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import { BrokerClient } from "./client.js";
import { MessageRouter } from "./router.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broker-integ-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
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

  it("agent.message returns error for unknown target", async () => {
    await client.register("lonely-agent", "😢");
    await expect(client.sendAgentMessage("ghost-agent", "Hello?")).rejects.toThrow(
      "Agent not found: ghost-agent",
    );
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
});
