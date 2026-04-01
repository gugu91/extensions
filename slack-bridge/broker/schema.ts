import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AgentInfo,
  ThreadInfo,
  BrokerMessage,
  InboxEntry,
  BacklogEntry,
  BrokerDBInterface,
  InboundMessage,
  ChannelAssignment,
} from "./types.js";

// ─── Row types (raw SQLite rows) ─────────────────────────

interface AgentRow {
  id: string;
  stable_id: string | null;
  name: string;
  emoji: string;
  pid: number;
  connected_at: string;
  last_seen: string;
  last_heartbeat: string;
  metadata: string | null;
  status: string;
  disconnected_at: string | null;
  resumable_until: string | null;
}

interface ThreadRow {
  thread_id: string;
  source: string;
  channel: string;
  owner_agent: string | null;
  created_at: string;
  updated_at: string;
}

interface BacklogRow {
  id: number;
  thread_id: string;
  channel: string;
  message_id: number;
  reason: string;
  status: string;
  assigned_agent_id: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Mappers ─────────────────────────────────────────────

function rowToAgent(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    pid: row.pid,
    connectedAt: row.connected_at,
    lastSeen: row.last_seen,
    lastHeartbeat: row.last_heartbeat,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null,
    status: row.status === "working" ? "working" : "idle",
    disconnectedAt: row.disconnected_at,
    resumableUntil: row.resumable_until,
  };
}

function rowToThread(row: ThreadRow): ThreadInfo {
  return {
    threadId: row.thread_id,
    source: row.source,
    channel: row.channel,
    ownerAgent: row.owner_agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToBacklog(row: BacklogRow): BacklogEntry {
  return {
    id: row.id,
    threadId: row.thread_id,
    channel: row.channel,
    messageId: row.message_id,
    reason: row.reason,
    status:
      row.status === "assigned" ? "assigned" : row.status === "dropped" ? "dropped" : "pending",
    assignedAgentId: row.assigned_agent_id,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Default DB path ─────────────────────────────────────

export function defaultDbPath(): string {
  return path.join(os.homedir(), ".pi", "pinet-broker.db");
}

export const DEFAULT_RESUMABLE_WINDOW_MS = 15_000;

// ─── BrokerDB ────────────────────────────────────────────

export class BrokerDB implements BrokerDBInterface {
  private db: DatabaseSync | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? defaultDbPath();
  }

  initialize(): void {
    if (this.db) return;

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY NOT NULL,
        stable_id TEXT,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        pid INTEGER NOT NULL,
        connected_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        metadata TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        disconnected_at TEXT,
        resumable_until TEXT
      );

      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        owner_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        source TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS unrouted_backlog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        message_id INTEGER NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'dropped')),
        assigned_agent_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_thread
        ON messages(thread_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_agent_delivered
        ON inbox(agent_id, delivered, created_at);
      CREATE INDEX IF NOT EXISTS idx_inbox_message
        ON inbox(message_id);
      CREATE INDEX IF NOT EXISTS idx_backlog_status_created
        ON unrouted_backlog(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_backlog_thread_status
        ON unrouted_backlog(thread_id, status);
      CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat
        ON agents(last_heartbeat);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_stable_id
        ON agents(stable_id)
        WHERE stable_id IS NOT NULL;
    `);

    // Migrations
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN stable_id TEXT");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN metadata TEXT");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN last_heartbeat TEXT");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN disconnected_at TEXT");
    } catch {
      /* exists */
    }
    try {
      this.db.exec("ALTER TABLE agents ADD COLUMN resumable_until TEXT");
    } catch {
      /* exists */
    }

    this.db.exec(`
      UPDATE agents
      SET last_heartbeat = COALESCE(last_heartbeat, last_seen)
      WHERE last_heartbeat IS NULL
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_stable_id
      ON agents(stable_id)
      WHERE stable_id IS NOT NULL
    `);

    // Broker startup reconciliation: any connected rows belong to a previous
    // broker session, so mark them resumably disconnected and wait for workers
    // to reconnect by stableId.
    this.reconcileStartupAgents();
  }

  /**
   * Mark all previously connected agents as resumably disconnected on broker
   * startup. Their inbox/thread ownership stays intact during the lease window
   * so reconnecting workers can resume by stableId.
   */
  reconcileStartupAgents(resumableForMs = DEFAULT_RESUMABLE_WINDOW_MS): void {
    const db = this.getDb();
    const now = new Date();
    const disconnectedAt = now.toISOString();
    const resumableUntil = new Date(now.getTime() + resumableForMs).toISOString();

    db.prepare(
      `UPDATE agents
       SET disconnected_at = ?,
           resumable_until = COALESCE(resumable_until, ?)
       WHERE disconnected_at IS NULL`,
    ).run(disconnectedAt, resumableUntil);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Agents ──────────────────────────────────────────

  registerAgent(
    id: string,
    name: string,
    emoji: string,
    pid: number,
    metadata?: Record<string, unknown>,
    stableId?: string,
  ): AgentInfo {
    const db = this.getDb();
    const now = new Date().toISOString();
    const existing = stableId ? this.getAgentRowByStableId(stableId) : null;
    const existingById = this.getAgentRowById(existing?.id ?? id);
    const agentId = existing?.id ?? id;
    const finalName = existing?.name ?? this.ensureUniqueAgentName(name, agentId);
    const finalEmoji = existing?.emoji ?? emoji;
    const persistedStableId = stableId ?? existing?.stable_id ?? existingById?.stable_id ?? null;
    const meta = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `INSERT INTO agents (
         id, stable_id, name, emoji, pid,
         connected_at, last_seen, last_heartbeat,
         metadata, status, disconnected_at, resumable_until
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL)
       ON CONFLICT(id) DO UPDATE SET
         stable_id = COALESCE(excluded.stable_id, agents.stable_id),
         name = excluded.name,
         emoji = excluded.emoji,
         pid = excluded.pid,
         connected_at = excluded.connected_at,
         last_seen = excluded.last_seen,
         last_heartbeat = excluded.last_heartbeat,
         metadata = excluded.metadata,
         status = 'idle',
         disconnected_at = NULL,
         resumable_until = NULL`,
    ).run(agentId, persistedStableId, finalName, finalEmoji, pid, now, now, now, meta);

    return {
      id: agentId,
      name: finalName,
      emoji: finalEmoji,
      pid,
      connectedAt: now,
      lastSeen: now,
      lastHeartbeat: now,
      metadata: metadata ?? null,
      status: "idle" as const,
    };
  }

  unregisterAgent(id: string): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?").run(
      now,
      id,
    );
    db.prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?").run(id);
  }

  disconnectAgent(id: string, resumableForMs = DEFAULT_RESUMABLE_WINDOW_MS): void {
    const db = this.getDb();
    const now = new Date();
    const resumableUntil = new Date(now.getTime() + resumableForMs).toISOString();
    db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = ? WHERE id = ?").run(
      now.toISOString(),
      resumableUntil,
      id,
    );
  }

  getAgentById(id: string): AgentInfo | null {
    const row = this.getAgentRowById(id);
    return row ? rowToAgent(row) : null;
  }

  getAgents(): AgentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM agents WHERE disconnected_at IS NULL ORDER BY connected_at ASC")
      .all() as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  getAllAgents(): AgentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM agents
         ORDER BY CASE WHEN disconnected_at IS NULL THEN 0 ELSE 1 END, connected_at ASC`,
      )
      .all() as unknown as AgentRow[];
    return rows.map(rowToAgent);
  }

  touchAgent(id: string): void {
    const db = this.getDb();
    db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  heartbeatAgent(id: string): void {
    const db = this.getDb();
    db.prepare(
      "UPDATE agents SET last_heartbeat = ?, disconnected_at = NULL, resumable_until = NULL WHERE id = ?",
    ).run(new Date().toISOString(), id);
  }

  pruneStaleAgents(staleAfterMs: number): string[] {
    const db = this.getDb();
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const now = new Date().toISOString();

    return this.withTransaction(() => {
      const staleRows = db
        .prepare(
          `SELECT id FROM agents
           WHERE (disconnected_at IS NULL AND last_heartbeat <= ?)
              OR (disconnected_at IS NOT NULL AND resumable_until IS NOT NULL AND resumable_until <= ?)`,
        )
        .all(cutoff, now) as Array<{ id: string }>;

      if (staleRows.length === 0) {
        return [];
      }

      const disconnectAgent = db.prepare(
        "UPDATE agents SET disconnected_at = COALESCE(disconnected_at, ?), resumable_until = NULL WHERE id = ?",
      );
      const releaseClaims = db.prepare(
        "UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?",
      );

      for (const row of staleRows) {
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        disconnectAgent.run(now, row.id);
        releaseClaims.run(row.id);
      }

      return staleRows.map((row) => row.id);
    });
  }

  updateAgentStatus(id: string, status: "working" | "idle"): void {
    const db = this.getDb();
    db.prepare("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?").run(
      status,
      new Date().toISOString(),
      id,
    );
  }

  private ensureUniqueAgentName(name: string, agentId: string): string {
    const db = this.getDb();
    const baseName = name.trim() || "Agent";
    let candidate = baseName;
    let suffix = 2;

    while (true) {
      const row = db.prepare("SELECT id FROM agents WHERE lower(name) = lower(?) AND id != ? LIMIT 1").get(
        candidate,
        agentId,
      ) as { id: string } | undefined;
      if (!row) {
        return candidate;
      }
      candidate = `${baseName} ${suffix}`;
      suffix += 1;
    }
  }

  private getAgentRowById(id: string): AgentRow | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ?? null;
  }

  private getAgentRowByStableId(stableId: string): AgentRow | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM agents WHERE stable_id = ?").get(stableId) as
      | AgentRow
      | undefined;
    return row ?? null;
  }

  // ─── Threads ─────────────────────────────────────────

  createThread(thread: ThreadInfo): ThreadInfo;
  createThread(
    threadId: string,
    source: string,
    channel: string,
    ownerAgent: string | null,
  ): ThreadInfo;
  createThread(
    threadOrId: ThreadInfo | string,
    source?: string,
    channel?: string,
    ownerAgent?: string | null,
  ): ThreadInfo {
    const db = this.getDb();
    const now = new Date().toISOString();

    const tId = typeof threadOrId === "string" ? threadOrId : threadOrId.threadId;
    const src = typeof threadOrId === "string" ? source! : threadOrId.source;
    const ch = typeof threadOrId === "string" ? channel! : threadOrId.channel;
    const owner = typeof threadOrId === "string" ? (ownerAgent ?? null) : threadOrId.ownerAgent;

    db.prepare(
      `INSERT INTO threads (thread_id, source, channel, owner_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run(tId, src, ch, owner, now, now);

    return {
      threadId: tId,
      source: src,
      channel: ch,
      ownerAgent: owner,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateThread(threadId: string, updates: Partial<ThreadInfo>): void {
    const db = this.getDb();
    const now = new Date().toISOString();

    // Upsert: create the thread if it doesn't exist yet
    const existing = this.getThread(threadId);
    if (!existing) {
      db.prepare(
        `INSERT INTO threads (thread_id, source, channel, owner_agent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        threadId,
        updates.source ?? "slack",
        updates.channel ?? "",
        updates.ownerAgent !== undefined ? updates.ownerAgent : null,
        now,
        now,
      );
      return;
    }

    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (updates.ownerAgent !== undefined) {
      sets.push("owner_agent = ?");
      values.push(updates.ownerAgent);
    }
    if (updates.channel !== undefined) {
      sets.push("channel = ?");
      values.push(updates.channel);
    }
    if (updates.source !== undefined) {
      sets.push("source = ?");
      values.push(updates.source);
    }

    sets.push("updated_at = ?");
    values.push(now);
    values.push(threadId);

    db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE thread_id = ?`).run(...values);
  }

  getAllowedUsers(): Set<string> | null {
    return null;
  }

  getChannelAssignment(_channel: string): ChannelAssignment | null {
    return null;
  }

  getThread(threadId: string): ThreadInfo | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as unknown as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : null;
  }

  getThreads(ownerAgent?: string): ThreadInfo[] {
    const db = this.getDb();
    if (ownerAgent) {
      const rows = db
        .prepare("SELECT * FROM threads WHERE owner_agent = ? ORDER BY updated_at DESC")
        .all(ownerAgent) as unknown as ThreadRow[];
      return rows.map(rowToThread);
    }
    const rows = db
      .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
      .all() as unknown as ThreadRow[];
    return rows.map(rowToThread);
  }

  getPendingBacklog(limit = 50): BacklogEntry[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM unrouted_backlog
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as BacklogRow[];
    return rows.map(rowToBacklog);
  }

  getBacklogCount(status: BacklogEntry["status"] = "pending"): number {
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM unrouted_backlog WHERE status = ?")
      .get(status) as { count: number };
    return row.count;
  }

  queueUnroutedMessage(message: InboundMessage, reason = "no_route"): BacklogEntry {
    const metadata: Record<string, unknown> = {
      ...message.metadata,
      channel: message.channel,
      userName: message.userName,
      userId: message.userId,
      timestamp: message.timestamp,
      ...(message.isChannelMention ? { isChannelMention: true } : {}),
    };

    const existingThread = this.getThread(message.threadId);
    if (!existingThread) {
      this.createThread(message.threadId, message.source, message.channel, null);
    } else {
      this.updateThread(message.threadId, {
        channel: message.channel,
        source: message.source,
        ownerAgent: null,
      });
    }

    const brokerMessage = this.insertMessage(
      message.threadId,
      message.source,
      "inbound",
      message.userId,
      message.text,
      [],
      metadata,
    );

    return this.upsertBacklogEntry(
      brokerMessage.id,
      message.threadId,
      message.channel,
      reason,
      "pending",
      null,
    );
  }

  assignBacklogEntry(id: number, agentId: string): BacklogEntry | null {
    const db = this.getDb();

    return this.withTransaction(() => {
      const row = db
        .prepare("SELECT * FROM unrouted_backlog WHERE id = ? AND status = 'pending'")
        .get(id) as BacklogRow | undefined;
      if (!row) return null;

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO inbox (agent_id, message_id, delivered, created_at)
         VALUES (?, ?, 0, ?)`,
      ).run(agentId, row.message_id, now);

      db.prepare(
        `UPDATE unrouted_backlog
         SET status = 'assigned',
             assigned_agent_id = ?,
             attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(agentId, now, now, id);

      this.updateThread(row.thread_id, { ownerAgent: agentId, channel: row.channel });

      return this.getBacklogById(id);
    });
  }

  requeueUndeliveredMessages(agentId: string, reason = "agent_disconnected"): number {
    return this.withTransaction(() => this.requeueUndeliveredMessagesInternal(agentId, reason));
  }

  getPendingInboxCount(agentId: string): number {
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM inbox WHERE agent_id = ? AND delivered = 0")
      .get(agentId) as { count: number };
    return row.count;
  }

  releaseThreadClaims(agentId: string): number {
    const db = this.getDb();
    const result = db
      .prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?")
      .run(agentId);
    return Number(result.changes ?? 0);
  }

  repairThreadOwnership(): { releasedClaimCount: number; releasedAgentIds: string[] } {
    const db = this.getDb();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT owner_agent, COUNT(*) AS claim_count
           FROM threads
           WHERE owner_agent IS NOT NULL
             AND owner_agent NOT IN (
               SELECT id FROM agents WHERE disconnected_at IS NULL
             )
           GROUP BY owner_agent`,
        )
        .all() as Array<{ owner_agent: string; claim_count: number }>;

      if (rows.length === 0) {
        return { releasedClaimCount: 0, releasedAgentIds: [] };
      }

      db.prepare(
        `UPDATE threads
         SET owner_agent = NULL
         WHERE owner_agent IS NOT NULL
           AND owner_agent NOT IN (
             SELECT id FROM agents WHERE disconnected_at IS NULL
           )`,
      ).run();

      return {
        releasedClaimCount: rows.reduce((count, row) => count + Number(row.claim_count), 0),
        releasedAgentIds: rows.map((row) => row.owner_agent),
      };
    });
  }

  // ─── Messages + Inbox ────────────────────────────────

  // ─── Interface-compatible queueMessage (single agent) ──

  queueMessage(agentId: string, message: InboundMessage): void {
    const metadata: Record<string, unknown> = {
      ...message.metadata,
      channel: message.channel,
      userName: message.userName,
      userId: message.userId,
      timestamp: message.timestamp,
      ...(message.isChannelMention ? { isChannelMention: true } : {}),
    };
    this.insertMessage(
      message.threadId,
      message.source,
      "inbound",
      message.userId,
      message.text,
      [agentId],
      metadata,
    );
  }

  // ─── Detailed message insert (used by socket server) ──

  insertMessage(
    threadId: string,
    source: string,
    direction: "inbound" | "outbound",
    sender: string,
    body: string,
    targetAgentIds: string[],
    metadata?: Record<string, unknown>,
  ): BrokerMessage {
    const db = this.getDb();
    const now = new Date().toISOString();
    const metaJson = metadata ? JSON.stringify(metadata) : null;

    const info = db
      .prepare(
        `INSERT INTO messages (thread_id, source, direction, sender, body, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, source, direction, sender, body, metaJson, now);

    const messageId = Number(info.lastInsertRowid);

    const insertInbox = db.prepare(
      `INSERT INTO inbox (agent_id, message_id, delivered, created_at)
       VALUES (?, ?, 0, ?)`,
    );

    for (const agentId of targetAgentIds) {
      insertInbox.run(agentId, messageId, now);
    }

    // Update thread timestamp
    db.prepare("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(now, threadId);

    return {
      id: messageId,
      threadId,
      source,
      direction,
      sender,
      body,
      metadata: metadata ?? null,
      createdAt: now,
    };
  }

  getInbox(agentId: string, limit = 50): { entry: InboxEntry; message: BrokerMessage }[] {
    const db = this.getDb();

    const rows = db
      .prepare(
        `SELECT
           i.id AS i_id, i.agent_id AS i_agent_id, i.message_id AS i_message_id,
           i.delivered AS i_delivered, i.created_at AS i_created_at,
           m.id AS m_id, m.thread_id AS m_thread_id, m.source AS m_source,
           m.direction AS m_direction, m.sender AS m_sender, m.body AS m_body,
           m.metadata AS m_metadata, m.created_at AS m_created_at
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE i.agent_id = ? AND i.delivered = 0
         ORDER BY i.created_at ASC
         LIMIT ?`,
      )
      .all(agentId, limit) as unknown as Array<{
      i_id: number;
      i_agent_id: string;
      i_message_id: number;
      i_delivered: number;
      i_created_at: string;
      m_id: number;
      m_thread_id: string;
      m_source: string;
      m_direction: string;
      m_sender: string;
      m_body: string;
      m_metadata: string | null;
      m_created_at: string;
    }>;

    return rows.map((r) => ({
      entry: {
        id: r.i_id,
        agentId: r.i_agent_id,
        messageId: r.i_message_id,
        delivered: r.i_delivered === 1,
        createdAt: r.i_created_at,
      },
      message: {
        id: r.m_id,
        threadId: r.m_thread_id,
        source: r.m_source,
        direction: r.m_direction as "inbound" | "outbound",
        sender: r.m_sender,
        body: r.m_body,
        metadata: r.m_metadata ? (JSON.parse(r.m_metadata) as Record<string, unknown>) : null,
        createdAt: r.m_created_at,
      },
    }));
  }

  markDelivered(inboxIds: number[], agentId?: string): void {
    if (inboxIds.length === 0) return;
    const db = this.getDb();
    if (agentId) {
      const stmt = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ? AND agent_id = ?");
      for (const id of inboxIds) {
        stmt.run(id, agentId);
      }
    } else {
      const stmt = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
      for (const id of inboxIds) {
        stmt.run(id);
      }
    }
  }

  // ─── Internal ────────────────────────────────────────

  private requeueUndeliveredMessagesInternal(
    agentId: string,
    reason = "agent_disconnected",
  ): number {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT
           i.id AS inbox_id,
           m.id AS message_id,
           m.thread_id AS thread_id,
           m.metadata AS metadata
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE i.agent_id = ?
           AND i.delivered = 0
           AND m.direction = 'inbound'
           AND m.source = 'slack'`,
      )
      .all(agentId) as Array<{
      inbox_id: number;
      message_id: number;
      thread_id: string;
      metadata: string | null;
    }>;

    if (rows.length === 0) {
      return 0;
    }

    const markDelivered = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
    for (const row of rows) {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      const channel = typeof metadata.channel === "string" ? metadata.channel : "";
      this.upsertBacklogEntry(row.message_id, row.thread_id, channel, reason, "pending", null);
      markDelivered.run(row.inbox_id);
    }

    return rows.length;
  }

  private getBacklogById(id: number): BacklogEntry | null {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM unrouted_backlog WHERE id = ?").get(id) as
      | BacklogRow
      | undefined;
    return row ? rowToBacklog(row) : null;
  }

  private upsertBacklogEntry(
    messageId: number,
    threadId: string,
    channel: string,
    reason: string,
    status: BacklogEntry["status"],
    assignedAgentId: string | null,
  ): BacklogEntry {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO unrouted_backlog (
         thread_id,
         channel,
         message_id,
         reason,
         status,
         assigned_agent_id,
         attempt_count,
         last_attempt_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         channel = excluded.channel,
         reason = excluded.reason,
         status = excluded.status,
         assigned_agent_id = excluded.assigned_agent_id,
         updated_at = excluded.updated_at`,
    ).run(threadId, channel, messageId, reason, status, assignedAgentId, now, now);

    const row = db.prepare("SELECT * FROM unrouted_backlog WHERE message_id = ?").get(messageId) as
      | BacklogRow
      | undefined;
    if (!row) {
      throw new Error(`Failed to upsert backlog entry for message ${messageId}`);
    }
    return rowToBacklog(row);
  }

  private withTransaction<T>(operation: () => T): T {
    const db = this.getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("BrokerDB not initialized — call initialize() first");
    }
    return this.db;
  }
}

