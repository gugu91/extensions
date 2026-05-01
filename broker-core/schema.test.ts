import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifyPinetMail } from "./mail-classification.js";
import { BrokerDB } from "./schema.js";

function createDb(): { db: BrokerDB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-core-schema-"));
  const db = new BrokerDB(path.join(dir, "broker.db"));
  db.initialize();
  return { db, dir };
}

function createLegacyV11Db(dbPath: string): void {
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        owner_agent TEXT,
        owner_binding TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        branch TEXT,
        pr_number INTEGER,
        status TEXT NOT NULL DEFAULT 'assigned',
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(issue_number)
      );
      PRAGMA user_version = 11;
    `);
  } finally {
    sqlite.close();
  }
}

function createLegacyV12Db(dbPath: string): void {
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT,
        idle_since TEXT,
        last_activity TEXT
      );
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        owner_agent TEXT,
        owner_binding TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        assigned_agent_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE unrouted_backlog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        preferred_agent_id TEXT,
        assigned_agent_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 12;
    `);
  } finally {
    sqlite.close();
  }
}

describe("BrokerDB message sync identity", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates v11 databases before creating indexes for newer columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-core-schema-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "broker.db");
    createLegacyV11Db(dbPath);

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy
        .prepare(
          `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, created_at, updated_at)
           VALUES (?, 'slack', ?, NULL, NULL, ?, ?)`,
        )
        .run("123.456", "C123", "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
      legacy
        .prepare(
          `INSERT INTO messages (thread_id, source, direction, sender, body, metadata, created_at)
           VALUES (?, 'slack', 'inbound', 'U1', 'legacy Slack message', ?, ?)`,
        )
        .run(
          "123.456",
          JSON.stringify({ channel: "C123", timestamp: "123.456" }),
          "2026-04-25T00:00:01.000Z",
        );
      legacy
        .prepare(
          "INSERT INTO inbox (agent_id, message_id, delivered, created_at) VALUES ('agent-1', 1, 0, ?)",
        )
        .run("2026-04-25T00:00:02.000Z");
    } finally {
      legacy.close();
    }

    const db = new BrokerDB(dbPath);
    try {
      db.initialize();
      expect(db.getInbox("agent-1")[0]).toMatchObject({
        entry: { readAt: null },
        message: { externalId: "C123:123.456" },
      });
    } finally {
      db.close();
    }

    const inspect = new DatabaseSync(dbPath);
    try {
      const version = inspect.prepare("PRAGMA user_version").get() as { user_version: number };
      const messageColumns = new Set(
        (inspect.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      const inboxColumns = new Set(
        (inspect.prepare("PRAGMA table_info(inbox)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      const threadColumns = new Set(
        (inspect.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );

      expect(version.user_version).toBe(14);
      expect(messageColumns.has("external_id")).toBe(true);
      expect(messageColumns.has("external_ts")).toBe(true);
      expect(inboxColumns.has("read_at")).toBe(true);
      expect(threadColumns.has("metadata")).toBe(true);
    } finally {
      inspect.close();
    }
  });

  it("migrates v12 message rows before creating sync identity indexes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-core-schema-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "broker.db");
    createLegacyV12Db(dbPath);

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy
        .prepare(
          `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, created_at, updated_at)
           VALUES (?, 'slack', ?, NULL, NULL, ?, ?)`,
        )
        .run("123.456", "C123", "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
      legacy
        .prepare(
          `INSERT INTO messages (thread_id, source, direction, sender, body, metadata, created_at)
           VALUES (?, 'slack', 'inbound', 'U1', 'legacy Slack message', ?, ?)`,
        )
        .run(
          "123.456",
          JSON.stringify({ channel: "C123", timestamp: "123.456" }),
          "2026-04-25T00:00:01.000Z",
        );
      legacy
        .prepare(
          "INSERT INTO inbox (agent_id, message_id, delivered, read_at, created_at) VALUES ('agent-1', 1, 0, NULL, ?)",
        )
        .run("2026-04-25T00:00:02.000Z");
      legacy
        .prepare(
          "INSERT INTO inbox (agent_id, message_id, delivered, read_at, created_at) VALUES ('agent-1', 1, 0, NULL, ?)",
        )
        .run("2026-04-25T00:00:03.000Z");
    } finally {
      legacy.close();
    }

    const db = new BrokerDB(dbPath);
    try {
      db.initialize();
      const migrated = db.insertMessage(
        "123.456",
        "slack",
        "inbound",
        "U1",
        "replayed Slack message",
        ["agent-1", "agent-2"],
        { channel: "C123", timestamp: "123.456" },
      );

      expect(migrated.id).toBe(1);
      expect(migrated.externalId).toBe("C123:123.456");
      expect(db.getInbox("agent-1")).toHaveLength(1);
      expect(db.getInbox("agent-2")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("consolidates legacy duplicate Slack rows onto one replay identity", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-core-schema-"));
    cleanupDirs.push(dir);
    const dbPath = path.join(dir, "broker.db");
    createLegacyV12Db(dbPath);

    const legacy = new DatabaseSync(dbPath);
    try {
      legacy
        .prepare(
          `INSERT INTO threads (thread_id, source, channel, owner_agent, owner_binding, created_at, updated_at)
           VALUES (?, 'slack', ?, NULL, NULL, ?, ?)`,
        )
        .run("123.456", "C123", "2026-04-25T00:00:00.000Z", "2026-04-25T00:00:00.000Z");
      for (const body of ["legacy Slack message", "duplicate legacy Slack message"]) {
        legacy
          .prepare(
            `INSERT INTO messages (thread_id, source, direction, sender, body, metadata, created_at)
             VALUES (?, 'slack', 'inbound', 'U1', ?, ?, ?)`,
          )
          .run(
            "123.456",
            body,
            JSON.stringify({ channel: "C123", timestamp: "123.456" }),
            "2026-04-25T00:00:01.000Z",
          );
      }
      legacy
        .prepare(
          "INSERT INTO inbox (agent_id, message_id, delivered, read_at, created_at) VALUES ('agent-1', 2, 1, ?, ?)",
        )
        .run("2026-04-25T00:00:02.500Z", "2026-04-25T00:00:02.000Z");
      legacy
        .prepare(
          `INSERT INTO task_assignments (task_id, thread_id, source_message_id, assigned_agent_id, status, created_at, updated_at)
           VALUES ('task-1', '123.456', 2, 'agent-1', 'assigned', ?, ?)`,
        )
        .run("2026-04-25T00:00:03.000Z", "2026-04-25T00:00:03.000Z");
      legacy
        .prepare(
          `INSERT INTO unrouted_backlog (thread_id, channel, message_id, reason, status, attempt_count, created_at, updated_at)
           VALUES ('123.456', 'C123', 1, 'unmatched', 'pending', 1, ?, ?)`,
        )
        .run("2026-04-25T00:00:04.000Z", "2026-04-25T00:00:04.000Z");
      legacy
        .prepare(
          `INSERT INTO unrouted_backlog (thread_id, channel, message_id, reason, status, assigned_agent_id, attempt_count, last_attempt_at, created_at, updated_at)
           VALUES ('123.456', 'C123', 2, 'assigned', 'assigned', 'agent-1', 3, ?, ?, ?)`,
        )
        .run("2026-04-25T00:00:05.000Z", "2026-04-25T00:00:03.500Z", "2026-04-25T00:00:05.000Z");
    } finally {
      legacy.close();
    }

    const db = new BrokerDB(dbPath);
    try {
      db.initialize();
      const replay = db.insertMessage(
        "123.456",
        "slack",
        "inbound",
        "U1",
        "replayed Slack message",
        ["agent-1", "agent-2"],
        { channel: "C123", timestamp: "123.456" },
      );

      expect(replay.id).toBe(1);
      expect(replay.externalId).toBe("C123:123.456");
      expect(db.getInbox("agent-1")).toHaveLength(0);
      expect(db.getInbox("agent-2")).toHaveLength(1);
    } finally {
      db.close();
    }

    const inspect = new DatabaseSync(dbPath);
    try {
      const backlog = inspect
        .prepare("SELECT * FROM unrouted_backlog WHERE message_id = 1")
        .get() as
        | {
            status: string;
            assigned_agent_id: string | null;
            attempt_count: number;
            last_attempt_at: string | null;
          }
        | undefined;
      const duplicateBacklog = inspect
        .prepare("SELECT * FROM unrouted_backlog WHERE message_id = 2")
        .get();
      const inbox = inspect
        .prepare("SELECT read_at FROM inbox WHERE agent_id = 'agent-1' AND message_id = 1")
        .get() as { read_at: string | null } | undefined;

      expect(backlog).toMatchObject({
        status: "assigned",
        assigned_agent_id: "agent-1",
        attempt_count: 3,
        last_attempt_at: "2026-04-25T00:00:05.000Z",
      });
      expect(duplicateBacklog).toBeUndefined();
      expect(inbox?.read_at).toBe("2026-04-25T00:00:02.500Z");
    } finally {
      inspect.close();
    }
  });

  it("persists thread metadata", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread({
        threadId: "thread-metadata",
        source: "slack",
        channel: "C123",
        ownerAgent: null,
        metadata: { slackThreadContext: { channelId: "C_TEAM", teamId: "T1" } },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      expect(db.getThread("thread-metadata")?.metadata).toEqual({
        slackThreadContext: { channelId: "C_TEAM", teamId: "T1" },
      });

      db.updateThread("thread-metadata", { metadata: { migrated: true } });
      expect(db.getThread("thread-metadata")?.metadata).toEqual({ migrated: true });
    } finally {
      db.close();
    }
  });

  it("deduplicates Slack messages by channel timestamp while preserving inbox recipients", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("123.456", "slack", "C123", null);

      const first = db.insertMessage(
        "123.456",
        "slack",
        "inbound",
        "U1",
        "hello from Slack",
        ["agent-1"],
        { channel: "C123", timestamp: "123.456", eventId: "Ev1" },
      );
      const replay = db.insertMessage(
        "123.456",
        "slack",
        "inbound",
        "U1",
        "hello from Slack replay",
        ["agent-1", "agent-2"],
        { channel: "C123", timestamp: "123.456", eventId: "Ev1-replay" },
      );

      expect(replay.id).toBe(first.id);
      expect(first.externalId).toBe("C123:123.456");
      expect(first.externalTs).toBe("123.456");
      expect(db.getInbox("agent-1")).toHaveLength(1);
      expect(db.getInbox("agent-2")).toHaveLength(1);
      expect(db.getInbox("agent-2")[0].message.id).toBe(first.id);
    } finally {
      db.close();
    }
  });

  it("stamps queued unrouted Slack backlog mail with an explicit class", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      const backlog = db.queueUnroutedMessage({
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "Please handle issue #608 and report blockers immediately.",
        timestamp: "123.456",
      });
      db.assignBacklogEntry(backlog.id, "agent-1");

      const read = db.readInbox("agent-1", { markRead: false });
      expect(read.messages[0].message.metadata).toMatchObject({
        channel: "C123",
        userId: "U1",
        timestamp: "123.456",
        pinetMailClass: "steering",
        threadAffinityOwnerAgentId: "agent-1",
      });
    } finally {
      db.close();
    }
  });

  it("does not reopen assigned backlog when a Slack message replay is queued unrouted", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      const message = {
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "hello",
        timestamp: "123.456",
        metadata: { channel: "C123", timestamp: "123.456" },
      };
      const backlog = db.queueUnroutedMessage(message);
      const assigned = db.assignBacklogEntry(backlog.id, "agent-1");
      expect(assigned).toMatchObject({ status: "assigned", assignedAgentId: "agent-1" });

      const replay = db.queueUnroutedMessage({ ...message, text: "hello replay" });

      expect(replay.id).toBe(backlog.id);
      expect(replay).toMatchObject({ status: "assigned", assignedAgentId: "agent-1" });
      expect(db.getPendingBacklog()).toHaveLength(0);
      expect(db.getThread("123.456")?.ownerAgent).toBe("agent-1");
    } finally {
      db.close();
    }
  });

  it("drops stale Slack backlog assignments when ownership changes before delivery", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      const backlog = db.queueUnroutedMessage({
        source: "slack",
        threadId: "123.456",
        channel: "C123",
        userId: "U1",
        userName: "User One",
        text: "hello from backlog",
        timestamp: "123.456",
        metadata: { channel: "C123", timestamp: "123.456" },
      });
      const assigned = db.assignBacklogEntry(backlog.id, "agent-1");
      expect(assigned).toMatchObject({ status: "assigned", assignedAgentId: "agent-1" });

      db.updateThread("123.456", { ownerAgent: "agent-2" });

      expect(db.getInbox("agent-1")).toHaveLength(0);
      const read = db.readInbox("agent-1", { markRead: false });
      expect(read.messages).toEqual([]);
      expect(read.unreadCountBefore).toBe(0);
      expect(read.unreadThreads).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not re-enqueue replayed Slack messages after delivery", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);

    try {
      const first = db.insertMessage("123.456", "slack", "inbound", "U1", "hello", ["agent-1"], {
        channel: "C123",
        timestamp: "123.456",
      });
      db.markDelivered([db.getInbox("agent-1")[0]!.entry.id]);

      const replay = db.insertMessage(
        "123.456",
        "slack",
        "inbound",
        "U1",
        "replayed hello",
        ["agent-1", "agent-2"],
        { channel: "C123", timestamp: "123.456" },
      );

      expect(replay.id).toBe(first.id);
      expect(db.getInbox("agent-1")).toHaveLength(0);
      expect(db.getInbox("agent-2")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("stamps worker-routed Slack inbox mail with an explicit class", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-a", "slack", "C123", "agent-a");
      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "Task: handle issue #608. ACK/work/ask/report.",
        timestamp: "123.456",
      });

      const read = db.readInbox("agent-a", { markRead: false });
      expect(read.messages[0].message.metadata).toMatchObject({
        channel: "C123",
        userId: "U1",
        timestamp: "123.456",
        threadAffinityOwnerAgentId: "agent-a",
        pinetMailClass: "steering",
      });
    } finally {
      db.close();
    }
  });

  it("preserves explicit Slack mail class metadata when queueing inbound mail", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-a", "slack", "C123", "agent-a");
      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "Task: handle this now. ACK/work/ask/report.",
        timestamp: "123.456",
        metadata: { pinetMailClass: "maintenance_context" },
      });

      const read = db.readInbox("agent-a", { markRead: false });
      expect(read.messages[0].message.metadata).toMatchObject({
        pinetMailClass: "maintenance_context",
      });
      expect(
        classifyPinetMail({
          source: read.messages[0].message.source,
          threadId: read.messages[0].message.threadId,
          sender: read.messages[0].message.sender,
          body: read.messages[0].message.body,
          metadata: read.messages[0].message.metadata,
        }).class,
      ).toBe("maintenance_context");
    } finally {
      db.close();
    }
  });

  it("drops stale Slack inbox rows when thread ownership changed before delivery", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-a", "slack", "C123", "agent-a");
      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "new reply in thread A",
        timestamp: "123.456",
      });
      db.queueMessage("agent-b", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "new reply in thread A fanout",
        timestamp: "123.457",
      });

      expect(db.getInbox("agent-a")).toHaveLength(1);
      expect(db.getInbox("agent-b")).toHaveLength(0);
      expect(db.getUnreadInboxCount("agent-b")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("stores delivered Slack inbox rows as unread durable mail without pending runtime delivery", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-a", "slack", "C123", "broker");
      const first = db.queueDeliveredMessage("broker", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "durable self-handled Slack mail",
        timestamp: "123.456",
      });
      const replay = db.queueDeliveredMessage("broker", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "durable self-handled Slack mail replay",
        timestamp: "123.456",
      });

      expect(first.freshDelivery).toBe(true);
      expect(replay.freshDelivery).toBe(false);
      expect(replay.message.id).toBe(first.message.id);
      expect(db.getInbox("broker")).toHaveLength(0);
      expect(db.getUnreadInboxCount("broker")).toBe(1);

      const read = db.readInbox("broker", { markRead: false });
      expect(read.messages).toHaveLength(1);
      expect(read.messages[0].message.id).toBe(first.message.id);
      expect(read.messages[0].entry.delivered).toBe(true);
      expect(read.messages[0].message.metadata).toMatchObject({
        channel: "C123",
        userId: "U1",
        timestamp: "123.456",
        threadAffinityOwnerAgentId: "broker",
        pinetMailClass: "fwup",
      });
    } finally {
      db.close();
    }
  });

  it("revalidates stale queued Slack rows on read when the owner changes", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-a", "slack", "C123", "agent-a");
      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "thread-a",
        channel: "C123",
        userId: "U1",
        text: "reply queued before retarget",
        timestamp: "123.789",
      });
      db.updateThread("thread-a", { ownerAgent: "agent-b" });

      const read = db.readInbox("agent-a", { markRead: false });

      expect(read.messages).toEqual([]);
      expect(read.unreadCountBefore).toBe(0);
      expect(read.unreadThreads).toEqual([]);
      expect(db.getInbox("agent-a")).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("does not apply Slack thread-affinity pruning to agent-to-agent inbox rows", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("a2a:one:two", "agent", "", "one");
      db.insertMessage("a2a:one:two", "agent", "inbound", "one", "same", ["two"]);

      expect(db.getInbox("two")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not deduplicate messages without a transport identity", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("a2a:one:two", "agent", "", null);

      const first = db.insertMessage("a2a:one:two", "agent", "inbound", "one", "same", ["two"]);
      const second = db.insertMessage("a2a:one:two", "agent", "inbound", "one", "same", ["two"]);

      expect(second.id).not.toBe(first.id);
      expect(db.getInbox("two")).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it("reclassifies the original Slack message as steering for linked arrow-up reaction mail", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("111.222", "slack", "C123", "agent-a");
      const original = db.insertMessage(
        "111.222",
        "slack",
        "inbound",
        "U_TARGET",
        "Please keep an eye on this later.",
        ["agent-a"],
        { channel: "C123", timestamp: "111.333", userId: "U_TARGET" },
      );

      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "111.222",
        channel: "C123",
        userId: "U_REACTOR",
        userName: "Alice",
        text: "Reaction trigger from Slack: arrow-up",
        timestamp: "999.000",
        metadata: {
          reactionTrigger: true,
          reactionName: "arrow_up",
          reactionAction: "steer",
          reactorUserId: "U_REACTOR",
          reactorName: "Alice",
          reactionEventTs: "999.000",
          referencedSource: "slack",
          referencedChannel: "C123",
          referencedThreadTs: "111.222",
          referencedMessageTs: "111.333",
          referencedExternalId: "C123:111.333",
        },
      });

      const read = db.readInbox("agent-a", { markRead: false });
      const reclassified = read.messages.find((item) => item.message.id === original.id)?.message;
      expect(reclassified?.metadata).toMatchObject({
        pinet_mail_class: "steering",
        pinet_mail_class_reason: "slack_reaction_arrow_up",
      });
      expect(reclassified?.metadata?.pinet_mail_class_audit).toEqual([
        expect.objectContaining({
          class: "steering",
          reason: "slack_reaction_arrow_up",
          reactionName: "arrow_up",
          reactorUserId: "U_REACTOR",
          reactorName: "Alice",
          reactionEventTs: "999.000",
          referencedThreadId: "111.222",
          referencedMessageTs: "111.333",
        }),
      ]);
      expect(
        classifyPinetMail({
          source: reclassified?.source,
          threadId: reclassified?.threadId,
          sender: reclassified?.sender,
          body: reclassified?.body,
          metadata: reclassified?.metadata,
        }).class,
      ).toBe("steering");
    } finally {
      db.close();
    }
  });

  it("reclassifies delivered durable Slack mail from arrow-up reactions", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("222.000", "slack", "C999", "broker");
      const original = db.queueDeliveredMessage("broker", {
        source: "slack",
        threadId: "222.000",
        channel: "C999",
        userId: "U_TARGET",
        text: "Escalate this only if someone reacts upward.",
        timestamp: "222.111",
      });

      const reaction = db.queueDeliveredMessage("broker", {
        source: "slack",
        threadId: "222.000",
        channel: "C999",
        userId: "U_REACTOR",
        userName: "Alice",
        text: "Reaction trigger from Slack: arrow-up",
        timestamp: "999.111",
        metadata: {
          reactionTrigger: true,
          reactionName: "arrow_up",
          reactionAction: "steer",
          reactorUserId: "U_REACTOR",
          referencedSource: "slack",
          referencedExternalId: "C999:222.111",
        },
      });

      expect(reaction.freshDelivery).toBe(true);
      const read = db.readInbox("broker", { markRead: false });
      const reclassified = read.messages.find(
        (item) => item.message.id === original.message.id,
      )?.message;
      expect(reclassified?.metadata).toMatchObject({ pinet_mail_class: "steering" });
      expect(
        classifyPinetMail({
          source: reclassified?.source,
          threadId: reclassified?.threadId,
          sender: reclassified?.sender,
          body: reclassified?.body,
          metadata: reclassified?.metadata,
        }).class,
      ).toBe("steering");
    } finally {
      db.close();
    }
  });

  it("does not reclassify referenced Slack messages for non-arrow reaction mail", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("111.222", "slack", "C123", "agent-a");
      const original = db.insertMessage(
        "111.222",
        "slack",
        "inbound",
        "U_TARGET",
        "Ordinary follow-up context.",
        ["agent-a"],
        { channel: "C123", timestamp: "111.333", userId: "U_TARGET" },
      );

      db.queueMessage("agent-a", {
        source: "slack",
        threadId: "111.222",
        channel: "C123",
        userId: "U_REACTOR",
        userName: "Alice",
        text: "Reaction trigger from Slack: review",
        timestamp: "999.000",
        metadata: {
          reactionTrigger: true,
          reactionName: "eyes",
          reactionAction: "review",
          referencedSource: "slack",
          referencedExternalId: "C123:111.333",
        },
      });

      const read = db.readInbox("agent-a", { markRead: false });
      const unchanged = read.messages.find((item) => item.message.id === original.id)?.message;
      expect(unchanged?.metadata).not.toHaveProperty("pinet_mail_class");
      expect(
        classifyPinetMail({
          source: unchanged?.source,
          threadId: unchanged?.threadId,
          sender: unchanged?.sender,
          body: unchanged?.body,
          metadata: unchanged?.metadata,
        }).class,
      ).toBe("fwup");
    } finally {
      db.close();
    }
  });

  it("prioritizes steering mail for unread reads and thread summaries", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("thread-fwup", "agent", "", null);
      db.createThread("thread-steering", "agent", "", null);
      db.insertMessage(
        "thread-fwup",
        "agent",
        "inbound",
        "broker",
        "Ordinary status follow-up.",
        ["worker"],
        { pinet_mail_class: "fwup" },
      );
      const steering = db.insertMessage(
        "thread-steering",
        "agent",
        "inbound",
        "broker",
        "Escalated operator instruction.",
        ["worker"],
        { pinet_mail_class: "steering" },
      );
      db.insertMessage(
        "thread-steering",
        "agent",
        "inbound",
        "broker",
        "Context-only note.",
        ["worker"],
        { pinet_mail_class: "maintenance_context" },
      );

      const read = db.readInbox("worker", { limit: 1, markRead: false });
      expect(read.messages).toHaveLength(1);
      expect(read.messages[0].message.id).toBe(steering.id);
      expect(read.unreadThreads[0]).toMatchObject({
        threadId: "thread-steering",
        highestMailClass: "steering",
        mailClassCounts: { steering: 1, fwup: 0, maintenance_context: 1 },
      });
      expect(read.unreadThreads[1]).toMatchObject({
        threadId: "thread-fwup",
        highestMailClass: "fwup",
        mailClassCounts: { steering: 0, fwup: 1, maintenance_context: 0 },
      });
    } finally {
      db.close();
    }
  });

  it("keeps mail classification derivable from durable inbox records without changing read state", () => {
    const { db, dir } = createDb();
    cleanupDirs.push(dir);
    try {
      db.createThread("a2a:broker:worker", "agent", "", null);
      db.insertMessage(
        "a2a:broker:worker",
        "agent",
        "inbound",
        "broker",
        "Task: implement issue #606. Workflow: ACK/work/ask/report.",
        ["worker"],
        { a2a: true },
      );
      db.insertMessage(
        "a2a:broker:worker",
        "agent",
        "inbound",
        "broker",
        "Tests passed. Blockers: none.",
        ["worker"],
        { a2a: true },
      );
      db.insertMessage(
        "a2a:broker:worker",
        "agent",
        "inbound",
        "broker",
        "RALPH broker-only maintenance: ghost agents detected.",
        ["worker"],
        { kind: "broker_maintenance" },
      );

      const result = db.readInbox("worker", { markRead: false });
      expect(result.markedReadIds).toEqual([]);
      expect(result.unreadCountBefore).toBe(3);
      expect(result.unreadCountAfter).toBe(3);
      expect(result.messages.map((item) => item.entry.readAt)).toEqual([null, null, null]);
      expect(
        result.messages.map(
          (item) =>
            classifyPinetMail({
              source: item.message.source,
              threadId: item.message.threadId,
              sender: item.message.sender,
              body: item.message.body,
              metadata: item.message.metadata,
            }).class,
        ),
      ).toEqual(["steering", "fwup", "maintenance_context"]);
    } finally {
      db.close();
    }
  });
});
