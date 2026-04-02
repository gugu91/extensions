import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { BrokerDB, CURRENT_BROKER_SCHEMA_VERSION } from "./schema.js";
import { LeaderLock } from "./leader.js";
import { runBrokerMaintenancePass } from "./maintenance.js";
import { BrokerSocketServer } from "./socket-server.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * JSON-RPC client over TCP for testing.
 */
class RpcClient {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<
    number | string,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const response = JSON.parse(line) as JsonRpcResponse;
        const id = response.id;
        if (id !== null && this.pending.has(id)) {
          this.pending.get(id)!.resolve(response);
          this.pending.delete(id);
        }
      }
    });
  }

  call(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(request) + "\n");
    });
  }

  destroy(): void {
    this.socket.destroy();
    for (const p of this.pending.values()) {
      p.reject(new Error("Connection destroyed"));
    }
    this.pending.clear();
  }
}

function connectClient(info: { type: "tcp"; host: string; port: number }): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: info.host, port: info.port }, () => {
      resolve(new RpcClient(socket));
    });
    socket.on("error", reject);
  });
}

function connectRawSocket(info: { type: "tcp"; host: string; port: number }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: info.host, port: info.port }, () => {
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

// ─── Schema tests ────────────────────────────────────────

describe("BrokerDB", () => {
  let dir: string;
  let db: BrokerDB;

  beforeEach(() => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("creates tables without error", () => {
    // initialize() already ran — just verify we can query
    expect(db.getAgents()).toEqual([]);
  });

  it("migrates a legacy agents table and stamps the schema version", () => {
    const dbPath = path.join(dir, "legacy.db");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO agents (id, name, emoji, pid, connected_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "Legacy Agent",
        "🧓",
        42,
        "2026-04-01T10:00:00.000Z",
        "2026-04-01T10:05:00.000Z",
      );
    legacyDb.close();

    const migratedDb = new BrokerDB(dbPath);
    expect(() => migratedDb.initialize()).not.toThrow();

    const migratedAgent = migratedDb.getAgentById("legacy-1");
    expect(migratedAgent?.lastHeartbeat).toBe("2026-04-01T10:05:00.000Z");
    expect(migratedAgent?.disconnectedAt).toBeTruthy();
    expect(migratedDb.getAgents()).toEqual([]);
    migratedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    const columns = inspectDb.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    inspectDb.close();

    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "stable_id",
        "metadata",
        "status",
        "last_heartbeat",
        "disconnected_at",
        "resumable_until",
      ]),
    );
  });

  it("recreates an invalid database file from scratch instead of crashing", () => {
    const dbPath = path.join(dir, "invalid.db");
    fs.writeFileSync(dbPath, "not a sqlite database", "utf-8");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const recreatedDb = new BrokerDB(dbPath);
    expect(() => recreatedDb.initialize()).not.toThrow();
    expect(recreatedDb.getAgents()).toEqual([]);
    recreatedDb.close();

    const inspectDb = new DatabaseSync(dbPath);
    const versionRow = inspectDb.prepare("PRAGMA user_version").get() as { user_version: number };
    inspectDb.close();

    expect(errorSpy).toHaveBeenCalled();
    expect(versionRow.user_version).toBe(CURRENT_BROKER_SCHEMA_VERSION);
    errorSpy.mockRestore();
  });

  it("registerAgent and getAgents", () => {
    const agent = db.registerAgent("a1", "TestAgent", "🤖", 1234);
    expect(agent.id).toBe("a1");
    expect(agent.name).toBe("TestAgent");
    expect(agent.emoji).toBe("🤖");
    expect(agent.pid).toBe(1234);

    const agents = db.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("a1");
  });

  it("registerAgent upserts on conflict", () => {
    db.registerAgent("a1", "First", "🔵", 100);
    db.registerAgent("a1", "Updated", "🔴", 200);

    const agents = db.getAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("Updated");
    expect(agents[0].pid).toBe(200);
  });

  it("registerAgent resumes previous identity by stableId", () => {
    const first = db.registerAgent("a1", "Original", "🧠", 100, undefined, "host:session:/tmp/a");
    db.unregisterAgent(first.id);

    const resumed = db.registerAgent(
      "a2",
      "Different",
      "🤖",
      200,
      undefined,
      "host:session:/tmp/a",
    );

    expect(resumed.id).toBe(first.id);
    expect(resumed.name).toBe("Original");
    expect(resumed.emoji).toBe("🧠");
    expect(db.getAgents()).toHaveLength(1);
  });

  it("registerAgent enforces unique names for different identities", () => {
    const first = db.registerAgent("a1", "Hyper Owl", "🦉", 100, undefined, "host:session:/tmp/a");
    const second = db.registerAgent("a2", "Hyper Owl", "🦎", 200, undefined, "host:session:/tmp/b");

    expect(first.name).toBe("Hyper Owl");
    expect(second.name).toBe("Hyper Owl 2");
    expect(db.getAgents().map((agent) => agent.name)).toEqual(["Hyper Owl", "Hyper Owl 2"]);
  });

  it("startup reconciliation marks prior agents disconnected until they reconnect by stableId", () => {
    const dbPath = path.join(dir, "restart.db");
    const firstDb = new BrokerDB(dbPath);
    firstDb.initialize();

    const original = firstDb.registerAgent(
      "a1",
      "Hyper Owl",
      "🦉",
      100,
      undefined,
      "host:session:/tmp/a",
    );
    firstDb.createThread("t-restart", "slack", "C1", original.id);
    firstDb.close();

    const restartedDb = new BrokerDB(dbPath);
    restartedDb.initialize();

    expect(restartedDb.getAgents()).toEqual([]);
    expect(restartedDb.getAgentById(original.id)?.disconnectedAt).toBeTruthy();
    expect(restartedDb.getAgentById(original.id)?.resumableUntil).toBeTruthy();
    expect(restartedDb.getThread("t-restart")?.ownerAgent).toBe(original.id);

    const resumed = restartedDb.registerAgent(
      "a2",
      "Different Owl",
      "🦎",
      200,
      undefined,
      "host:session:/tmp/a",
    );

    expect(resumed.id).toBe(original.id);
    expect(resumed.name).toBe("Hyper Owl");
    expect(resumed.emoji).toBe("🦉");
    expect(restartedDb.getThread("t-restart")?.ownerAgent).toBe(original.id);

    restartedDb.close();
  });

  it("unregisterAgent hides agent from connected list, keeps the record, and releases claims", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t-unregister", "slack", "#general", "a1");

    db.unregisterAgent("a1");

    expect(db.getAgents()).toEqual([]);
    expect(db.getAgentById("a1")?.name).toBe("Agent");
    expect(db.getAgentById("a1")?.resumableUntil).toBeNull();
    expect(db.getThread("t-unregister")?.ownerAgent).toBeNull();
  });

  it("getAllAgents includes recently disconnected agents for visibility", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.unregisterAgent("a1");

    const allAgents = db.getAllAgents();
    expect(allAgents).toHaveLength(1);
    expect(allAgents[0]?.id).toBe("a1");
    expect(allAgents[0]?.disconnectedAt).toBeTruthy();
  });

  it("touchAgent updates last_seen", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    const before = db.getAgents()[0].lastSeen;

    // Small delay to ensure timestamp differs
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    db.touchAgent("a1");
    const after = db.getAgents()[0].lastSeen;
    expect(after >= before).toBe(true);
  });

  it("heartbeatAgent updates last_heartbeat", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    const before = db.getAgents()[0].lastHeartbeat;

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    db.heartbeatAgent("a1");
    const after = db.getAgentById("a1")?.lastHeartbeat;
    expect(after).toBeDefined();
    expect(after! >= before).toBe(true);
  });

  it("disconnectAgent keeps claims during the resumable window", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t-resumable", "slack", "#general", "a1");

    db.disconnectAgent("a1", 60_000);

    expect(db.getAgents()).toEqual([]);
    expect(db.getAgentById("a1")?.disconnectedAt).toBeTruthy();
    expect(db.getAgentById("a1")?.resumableUntil).toBeTruthy();
    expect(db.getThread("t-resumable")?.ownerAgent).toBe("a1");
  });

  it("pruneStaleAgents disconnects stale agents and releases their thread claims", () => {
    db.registerAgent("a1", "Agent", "🤖", 1);
    db.createThread("t1", "slack", "#general", "a1");

    const pruned = db.pruneStaleAgents(0);

    expect(pruned).toContain("a1");
    expect(db.getAgents()).toEqual([]);
    expect(db.getThread("t1")?.ownerAgent).toBeNull();
    expect(db.getAgentById("a1")).not.toBeNull();
  });

  it("purgeDisconnectedAgents waits for the grace window before deleting ghosts", () => {
    db.registerAgent("active", "Active", "🟢", 1);
    db.registerAgent("resumable", "Resumable", "🟡", 2);
    db.registerAgent("ghost", "Ghost", "⚫️", 3);
    db.registerAgent("gone", "Gone", "⚪️", 4);
    db.createThread("t-gone", "slack", "C1", "gone");
    db.insertMessage("t-gone", "slack", "inbound", "U1", "recover me", ["gone"], {
      channel: "C1",
    });

    db.disconnectAgent("resumable", 60_000);
    db.disconnectAgent("ghost", 0);
    db.unregisterAgent("gone");

    expect(db.purgeDisconnectedAgents()).toEqual([]);

    const purged = db.purgeDisconnectedAgents(0);

    expect(purged.sort()).toEqual(["ghost", "gone"]);
    expect(db.getAgentById("active")).not.toBeNull();
    expect(db.getAgentById("resumable")).not.toBeNull();
    expect(db.getAgentById("ghost")).toBeNull();
    expect(db.getAgentById("gone")).toBeNull();
    expect(db.getInbox("gone")).toHaveLength(0);
    expect(db.getPendingBacklog().map((entry) => entry.threadId)).toContain("t-gone");
  });

  it("queueUnroutedMessage persists pending backlog without assigning an owner", () => {
    const backlog = db.queueUnroutedMessage(
      {
        source: "slack",
        threadId: "t-unrouted",
        channel: "C1",
        userId: "U1",
        text: "hello backlog",
        timestamp: "100.200",
      },
      "no_route",
    );

    expect(backlog.threadId).toBe("t-unrouted");
    expect(backlog.status).toBe("pending");
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getThread("t-unrouted")?.ownerAgent).toBeNull();
  });

  it("requeueUndeliveredMessages moves pending slack work back into backlog", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    db.createThread("t-requeue", "slack", "C1", "worker-1");
    db.insertMessage("t-requeue", "slack", "inbound", "U1", "hello", ["worker-1"], {
      channel: "C1",
    });

    const moved = db.requeueUndeliveredMessages("worker-1");

    expect(moved).toBe(1);
    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0].threadId).toBe("t-requeue");
  });

  it("maintenance requeues messages orphaned in a disconnected agent inbox", () => {
    db.registerAgent("worker-1", "Worker", "🤖", 1);
    db.createThread("t-orphan", "slack", "C1", "worker-1");
    // Use disconnectAgent with 0ms window so resumable_until expires immediately
    db.disconnectAgent("worker-1", 0);

    db.queueMessage("worker-1", {
      source: "slack",
      threadId: "t-orphan",
      channel: "C1",
      userId: "U1",
      text: "stuck during resume window",
      timestamp: "100.200",
    });

    // Ensure resumable_until is in the past
    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    const result = runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(result.reapedAgentIds).toContain("worker-1");
    expect(db.getAgentById("worker-1")).not.toBeNull();
    expect(db.getInbox("worker-1")).toHaveLength(0);
    expect(db.getPendingBacklog()).toHaveLength(1);
    expect(db.getPendingBacklog()[0].threadId).toBe("t-orphan");
    expect(db.getThread("t-orphan")?.ownerAgent).toBeNull();
  });

  it("maintenance purge requeues inbox work before deleting expired disconnected agents", () => {
    db.registerAgent("gone", "Gone", "⚪️", 4);
    db.createThread("t-gone-maint", "slack", "C1", "gone");
    db.insertMessage("t-gone-maint", "slack", "inbound", "U1", "recover me too", ["gone"], {
      channel: "C1",
    });
    db.unregisterAgent("gone");

    const sqlite = (db as unknown as { getDb(): DatabaseSync }).getDb();
    sqlite
      .prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?")
      .run(new Date(Date.now() - 2 * 60 * 60_000).toISOString(), "gone");

    runBrokerMaintenancePass(db, {
      staleAfterMs: 15_000,
      now: Date.parse("2026-04-01T00:00:10.000Z"),
    });

    expect(db.getAgentById("gone")).toBeNull();
    expect(db.getInbox("gone")).toHaveLength(0);
    expect(db.getPendingBacklog().map((entry) => entry.threadId)).toContain("t-gone-maint");
    expect(db.getThread("t-gone-maint")?.ownerAgent).toBeNull();
  });

  it("createThread and getThread", () => {
    const thread = db.createThread("t1", "slack", "#general", "a1");
    expect(thread.threadId).toBe("t1");
    expect(thread.source).toBe("slack");
    expect(thread.channel).toBe("#general");
    expect(thread.ownerAgent).toBe("a1");

    const fetched = db.getThread("t1");
    expect(fetched).not.toBeNull();
    expect(fetched!.threadId).toBe("t1");
  });

  it("getThread returns null for missing thread", () => {
    expect(db.getThread("nonexistent")).toBeNull();
  });

  it("getThreads filters by owner", () => {
    db.createThread("t1", "slack", "#a", "agent-1");
    db.createThread("t2", "slack", "#b", "agent-2");
    db.createThread("t3", "slack", "#c", "agent-1");

    const agent1Threads = db.getThreads("agent-1");
    expect(agent1Threads).toHaveLength(2);

    const allThreads = db.getThreads();
    expect(allThreads).toHaveLength(3);
  });

  it("getOwnedThreadCount returns the number of claimed threads", () => {
    db.createThread("t1", "slack", "#a", "agent-1");
    db.createThread("t2", "slack", "#b", "agent-2");
    db.createThread("t3", "slack", "#c", "agent-1");

    expect(db.getOwnedThreadCount("agent-1")).toBe(2);
    expect(db.getOwnedThreadCount("agent-2")).toBe(1);
    expect(db.getOwnedThreadCount("missing")).toBe(0);
  });

  it("claimThread creates a new thread and claims it", () => {
    const claimed = db.claimThread("t-new", "agent-1", "slack", "#general");
    expect(claimed).toBe(true);
    const thread = db.getThread("t-new");
    expect(thread).not.toBeNull();
    expect(thread!.ownerAgent).toBe("agent-1");
  });

  it("claimThread succeeds on unclaimed existing thread", () => {
    db.createThread("t-unclaimed", "slack", "#general", null);
    const claimed = db.claimThread("t-unclaimed", "agent-1");
    expect(claimed).toBe(true);
    expect(db.getThread("t-unclaimed")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread allows re-claim by same agent", () => {
    db.claimThread("t-mine", "agent-1");
    const reclaimed = db.claimThread("t-mine", "agent-1");
    expect(reclaimed).toBe(true);
    expect(db.getThread("t-mine")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread rejects claim when another agent owns the thread", () => {
    db.claimThread("t-taken", "agent-1");
    const claimed = db.claimThread("t-taken", "agent-2");
    expect(claimed).toBe(false);
    expect(db.getThread("t-taken")!.ownerAgent).toBe("agent-1");
  });

  it("claimThread is atomic — no TOCTOU window between read and write", () => {
    // Simulate the race: agent-1 claims, then agent-2 tries to claim.
    // With the old read-then-write pattern, a race could let both succeed.
    // The atomic INSERT...ON CONFLICT...WHERE ensures only one wins.
    const first = db.claimThread("t-race", "agent-1");
    const second = db.claimThread("t-race", "agent-2");
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(db.getThread("t-race")!.ownerAgent).toBe("agent-1");
  });

  it("insertMessage and getInbox", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.registerAgent("a2", "Agent2", "🔴", 2);
    db.createThread("t1", "slack", "#general", "a1");

    const msg = db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1", "a2"]);
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.body).toBe("hello");

    const inbox1 = db.getInbox("a1");
    expect(inbox1).toHaveLength(1);
    expect(inbox1[0].message.body).toBe("hello");
    expect(inbox1[0].entry.delivered).toBe(false);

    const inbox2 = db.getInbox("a2");
    expect(inbox2).toHaveLength(1);
  });

  it("markDelivered removes from pending inbox", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");
    db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1"]);

    const before = db.getInbox("a1");
    expect(before).toHaveLength(1);

    db.markDelivered([before[0].entry.id], "a1");

    const after = db.getInbox("a1");
    expect(after).toHaveLength(0);
  });

  it("markDelivered scoped to agent does not affect other agents", () => {
    db.registerAgent("a1", "Agent1", "🔵", 1);
    db.registerAgent("a2", "Agent2", "🔴", 2);
    db.createThread("t1", "slack", "#general", "a1");
    db.insertMessage("t1", "slack", "inbound", "user1", "hello", ["a1", "a2"]);

    const inbox1 = db.getInbox("a1");
    const inbox2 = db.getInbox("a2");

    // Ack only for agent a1
    db.markDelivered([inbox1[0].entry.id], "a1");

    expect(db.getInbox("a1")).toHaveLength(0);
    expect(db.getInbox("a2")).toHaveLength(1);

    // Attempting to ack a2's inbox entry with a1 should be a no-op
    db.markDelivered([inbox2[0].entry.id], "a1");
    expect(db.getInbox("a2")).toHaveLength(1);
  });

  it("insertMessage with metadata round-trips JSON", () => {
    db.registerAgent("a1", "Agent", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");

    db.insertMessage("t1", "slack", "inbound", "user1", "hi", ["a1"], {
      priority: "high",
      tags: ["urgent"],
    });

    const inbox = db.getInbox("a1");
    expect(inbox[0].message.metadata).toEqual({
      priority: "high",
      tags: ["urgent"],
    });
  });

  it("insertMessage without metadata stores null", () => {
    db.registerAgent("a1", "Agent", "🔵", 1);
    db.createThread("t1", "slack", "#general", "a1");

    db.insertMessage("t1", "slack", "inbound", "user1", "hi", ["a1"]);

    const inbox = db.getInbox("a1");
    expect(inbox[0].message.metadata).toBeNull();
  });

  it("direction CHECK constraint rejects invalid values", () => {
    db.createThread("t1", "slack", "#general", "a1");
    expect(() => {
      db.insertMessage("t1", "slack", "invalid" as "inbound", "u", "x", []);
    }).toThrow();
  });

  it("double initialize is safe", () => {
    db.initialize(); // second call
    expect(db.getAgents()).toEqual([]);
  });

  it("throws when used before initialize", () => {
    const db2 = new BrokerDB(path.join(dir, "uninit.db"));
    expect(() => db2.getAgents()).toThrow("not initialized");
    // no close needed — never opened
  });
});

// ─── Leader election tests ───────────────────────────────

describe("LeaderLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("acquires lock when file does not exist", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
    expect(lock.isLeader()).toBe(false);
  });

  it("writes current PID to lock file", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const content = fs.readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
    lock.release();
  });

  it("release removes lock file", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("fails when lock is held by current process via different instance", () => {
    const lockPath = path.join(dir, "test.lock");

    // Simulate another instance holding the lock by writing our own PID
    // (process.pid is always running)
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(false);
    expect(lock.isLeader()).toBe(false);
  });

  it("reclaims stale lock (dead PID)", () => {
    const lockPath = path.join(dir, "test.lock");

    // Write a PID that almost certainly doesn't exist
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
  });

  it("second lock on same file fails", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    expect(lock1.tryAcquire()).toBe(true);
    expect(lock2.tryAcquire()).toBe(false);

    lock1.release();
  });

  it("second lock succeeds after first releases", () => {
    const lockPath = path.join(dir, "test.lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    lock1.tryAcquire();
    lock1.release();

    expect(lock2.tryAcquire()).toBe(true);
    lock2.release();
  });

  it("tryAcquire is idempotent", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("release is safe when not acquired", () => {
    const lock = new LeaderLock(path.join(dir, "test.lock"));
    lock.release(); // should not throw
    expect(lock.isLeader()).toBe(false);
  });
});

// ─── Socket server tests (TCP mode for sandbox compat) ───

describe("BrokerSocketServer", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;

  beforeEach(async () => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    // Use TCP with port 0 (auto-assign) since Unix sockets may be
    // blocked in sandboxed environments
    server = new BrokerSocketServer(db, { type: "tcp", host: "127.0.0.1", port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
  });

  function getInfo() {
    return server.getConnectInfo() as { type: "tcp"; host: string; port: number };
  }

  it("accepts connections", async () => {
    const client = await connectClient(getInfo());
    client.destroy();
  });

  it("register returns agentId", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("register", { name: "TestBot", emoji: "🤖" });

    expect(res.error).toBeUndefined();
    const result = res.result as { agentId: string; name: string; emoji: string };
    expect(result.agentId).toBeTruthy();
    expect(result.name).toBe("TestBot");
    expect(result.emoji).toBe("🤖");

    client.destroy();
  });

  it("unregister removes agent", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });
    const res = await client.call("unregister");

    expect(res.error).toBeUndefined();
    expect((res.result as { ok: boolean }).ok).toBe(true);

    // Agent should be gone from DB
    expect(db.getAgents()).toHaveLength(0);

    client.destroy();
  });

  it("unregister fails when not registered", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("unregister");

    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("Not registered");

    client.destroy();
  });

  it("heartbeat updates last_heartbeat for registered agents", async () => {
    const client = await connectClient(getInfo());
    const registerRes = await client.call("register", { name: "Pulse", emoji: "💓", pid: 1 });
    const agentId = (registerRes.result as { agentId: string }).agentId;
    const before = db.getAgentById(agentId)?.lastHeartbeat;
    expect(before).toBeDefined();

    const start = Date.now();
    while (Date.now() - start < 10) {
      /* spin */
    }

    const heartbeatRes = await client.call("heartbeat");
    expect(heartbeatRes.error).toBeUndefined();
    expect((heartbeatRes.result as { ok: boolean }).ok).toBe(true);

    const after = db.getAgentById(agentId)?.lastHeartbeat;
    expect(after).toBeDefined();
    expect(after! >= before!).toBe(true);

    client.destroy();
  });

  it("agents.list returns connected agents", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Alpha", emoji: "🅰️" });
    await client2.call("register", { name: "Beta", emoji: "🅱️" });

    const res = await client1.call("agents.list");
    expect(res.error).toBeUndefined();
    const agents = res.result as Array<{ name: string }>;
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["Alpha", "Beta"]);

    client1.destroy();
    client2.destroy();
  });

  it("agents.list can include disconnected agents for visibility", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Alpha", emoji: "🅰️" });
    const beta = await client2.call("register", { name: "Beta", emoji: "🅱️" });
    const betaId = (beta.result as { agentId: string }).agentId;
    await client2.call("unregister");

    const res = await client1.call("agents.list", { includeDisconnected: true });
    expect(res.error).toBeUndefined();
    const agents = res.result as Array<{ id: string; disconnectedAt?: string | null }>;
    expect(agents.map((a) => a.id)).toContain(betaId);
    expect(agents.find((a) => a.id === betaId)?.disconnectedAt).toBeTruthy();

    client1.destroy();
    client2.destroy();
  });

  it("send creates message and routes to other agents", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Sender", emoji: "📤" });
    await client2.call("register", { name: "Receiver", emoji: "📥" });

    const sendRes = await client1.call("send", {
      threadId: "thread-1",
      body: "Hello from sender",
      source: "test",
      channel: "#test",
    });
    expect(sendRes.error).toBeUndefined();
    expect((sendRes.result as { messageId: number }).messageId).toBeGreaterThan(0);

    // Receiver should see it in inbox
    const pollRes = await client2.call("inbox.poll");
    expect(pollRes.error).toBeUndefined();
    const items = pollRes.result as Array<{ inboxId: number; message: { body: string } }>;
    expect(items).toHaveLength(1);
    expect(items[0].message.body).toBe("Hello from sender");

    // Sender should NOT see it in their own inbox
    const senderPoll = await client1.call("inbox.poll");
    expect((senderPoll.result as unknown[]).length).toBe(0);

    client1.destroy();
    client2.destroy();
  });

  it("inbox.ack marks messages as delivered", async () => {
    const client1 = await connectClient(getInfo());
    const client2 = await connectClient(getInfo());

    await client1.call("register", { name: "Sender", emoji: "📤" });
    await client2.call("register", { name: "Receiver", emoji: "📥" });

    await client1.call("send", {
      threadId: "t1",
      body: "test msg",
      source: "test",
      channel: "#test",
    });

    const poll1 = await client2.call("inbox.poll");
    const items = poll1.result as Array<{ inboxId: number }>;
    expect(items).toHaveLength(1);

    const ackRes = await client2.call("inbox.ack", { ids: [items[0].inboxId] });
    expect(ackRes.error).toBeUndefined();

    // Should be empty after ack
    const poll2 = await client2.call("inbox.poll");
    expect((poll2.result as unknown[]).length).toBe(0);

    client1.destroy();
    client2.destroy();
  });

  it("threads.list returns agent threads", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });

    await client.call("send", {
      threadId: "t1",
      body: "msg1",
      source: "test",
      channel: "#general",
    });
    await client.call("send", {
      threadId: "t2",
      body: "msg2",
      source: "test",
      channel: "#random",
    });

    const res = await client.call("threads.list");
    expect(res.error).toBeUndefined();
    const threads = res.result as Array<{ threadId: string }>;
    expect(threads).toHaveLength(2);

    client.destroy();
  });

  it("unknown method returns error", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("nonexistent.method");

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
    expect(res.error!.message).toContain("Unknown method");

    client.destroy();
  });

  it("invalid JSON returns parse error", async () => {
    const socket = await connectRawSocket(getInfo());

    const response = new Promise<JsonRpcResponse>((resolve) => {
      socket.on("data", (chunk) => {
        const line = chunk.toString("utf-8").trim();
        resolve(JSON.parse(line) as JsonRpcResponse);
      });
    });

    socket.write("not valid json\n");
    const res = await response;

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32700);

    socket.destroy();
  });

  it("cleans up agent on disconnect", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Ephemeral", emoji: "💨" });

    expect(db.getAgents()).toHaveLength(1);

    client.destroy();

    // Wait for close event to propagate
    await new Promise((r) => setTimeout(r, 50));

    expect(db.getAgents()).toHaveLength(0);
  });

  it("send without registration fails", async () => {
    const client = await connectClient(getInfo());
    const res = await client.call("send", { threadId: "t1", body: "hi" });

    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("Not registered");

    client.destroy();
  });

  it("inbox.ack with invalid ids param returns error", async () => {
    const client = await connectClient(getInfo());
    await client.call("register", { name: "Bot", emoji: "🤖" });

    const res = await client.call("inbox.ack", { ids: "not-an-array" });
    expect(res.error).toBeDefined();
    expect(res.error!.message).toContain("array");

    client.destroy();
  });
});
