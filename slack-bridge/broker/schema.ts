import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultDbPath } from "./paths.js";
import type {
  AgentInfo,
  ThreadInfo,
  BrokerMessage,
  InboxEntry,
  BacklogEntry,
  BrokerDBInterface,
  InboundMessage,
  ChannelAssignment,
  TaskAssignmentInfo,
  TaskAssignmentStatus,
  ScheduledWakeupInfo,
  ScheduledWakeupDelivery,
} from "./types.js";
import {
  buildSqliteWalFallbackWarning,
  isSqliteWalEnabled,
  type SqliteJournalModeResult,
} from "../helpers.js";

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
  idle_since: string | null;
  last_activity: string | null;
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
  preferred_agent_id: string | null;
  assigned_agent_id: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskAssignmentRow {
  id: number;
  agent_id: string;
  issue_number: number;
  branch: string | null;
  pr_number: number | null;
  status: string;
  thread_id: string;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
}

interface ScheduledWakeupRow {
  id: number;
  agent_id: string;
  agent_stable_id: string | null;
  thread_id: string;
  body: string;
  fire_at: string;
  created_at: string;
}

// ─── Mappers ─────────────────────────────────────────────

interface RalphCycleRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  ghost_agent_ids: string;
  nudge_agent_ids: string;
  idle_drain_agent_ids: string;
  stuck_agent_ids: string;
  anomalies: string;
  anomaly_signature: string;
  follow_up_delivered: number;
  agent_count: number;
  backlog_count: number;
}

function rowToAgent(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    stableId: row.stable_id,
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
    idleSince: row.idle_since,
    lastActivity: row.last_activity,
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
    preferredAgentId: row.preferred_agent_id,
    assignedAgentId: row.assigned_agent_id,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskAssignment(row: TaskAssignmentRow): TaskAssignmentInfo {
  return {
    id: row.id,
    agentId: row.agent_id,
    issueNumber: row.issue_number,
    branch: row.branch,
    prNumber: row.pr_number,
    status: row.status as TaskAssignmentStatus,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToScheduledWakeup(row: ScheduledWakeupRow): ScheduledWakeupInfo {
  return {
    id: row.id,
    agentId: row.agent_id,
    threadId: row.thread_id,
    body: row.body,
    fireAt: row.fire_at,
    createdAt: row.created_at,
  };
}

// ─── Default DB path ─────────────────────────────────────

export function defaultDbPath(): string {
  return getDefaultDbPath();
}

export const DEFAULT_RESUMABLE_WINDOW_MS = 15_000;
export const DEFAULT_DISCONNECTED_PURGE_GRACE_MS = 60 * 60_000;
export const CURRENT_BROKER_SCHEMA_VERSION = 10;

const REQUIRED_AGENT_LIFECYCLE_COLUMNS = [
  "stable_id",
  "metadata",
  "status",
  "last_heartbeat",
  "disconnected_at",
  "resumable_until",
] as const;

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, sql: string): void {
  if (!getTableColumns(db, tableName).has(columnName)) {
    db.exec(sql);
  }
}

function createCoreTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      pid INTEGER NOT NULL,
      connected_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
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

    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_agent_delivered
      ON inbox(agent_id, delivered, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_message
      ON inbox(message_id);
  `);
}

function createBacklogTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS unrouted_backlog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      message_id INTEGER NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'assigned', 'dropped')),
      preferred_agent_id TEXT,
      assigned_agent_id TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_backlog_status_created
      ON unrouted_backlog(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_backlog_thread_status
      ON unrouted_backlog(thread_id, status);
    CREATE INDEX IF NOT EXISTS idx_backlog_preferred_agent_status
      ON unrouted_backlog(preferred_agent_id, status);
  `);
}

function createSettingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function addAgentLifecycleColumns(db: DatabaseSync): void {
  ensureColumn(db, "agents", "stable_id", "ALTER TABLE agents ADD COLUMN stable_id TEXT");
  ensureColumn(db, "agents", "metadata", "ALTER TABLE agents ADD COLUMN metadata TEXT");
  ensureColumn(
    db,
    "agents",
    "status",
    "ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'",
  );
  ensureColumn(db, "agents", "last_heartbeat", "ALTER TABLE agents ADD COLUMN last_heartbeat TEXT");
  ensureColumn(
    db,
    "agents",
    "disconnected_at",
    "ALTER TABLE agents ADD COLUMN disconnected_at TEXT",
  );
  ensureColumn(
    db,
    "agents",
    "resumable_until",
    "ALTER TABLE agents ADD COLUMN resumable_until TEXT",
  );

  db.exec(`
    UPDATE agents
    SET last_heartbeat = COALESCE(last_heartbeat, last_seen)
    WHERE last_heartbeat IS NULL;

    CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat
      ON agents(last_heartbeat);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_stable_id
      ON agents(stable_id)
      WHERE stable_id IS NOT NULL;
  `);
}

function addObservabilityColumns(db: DatabaseSync): void {
  ensureColumn(db, "agents", "idle_since", "ALTER TABLE agents ADD COLUMN idle_since TEXT");
  ensureColumn(db, "agents", "last_activity", "ALTER TABLE agents ADD COLUMN last_activity TEXT");

  // Set idle_since for currently idle agents that lack it
  db.exec(`
    UPDATE agents
    SET idle_since = COALESCE(idle_since, last_seen)
    WHERE status = 'idle' AND idle_since IS NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ralph_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      duration_ms INTEGER,
      ghost_agent_ids TEXT NOT NULL DEFAULT '[]',
      nudge_agent_ids TEXT NOT NULL DEFAULT '[]',
      idle_drain_agent_ids TEXT NOT NULL DEFAULT '[]',
      stuck_agent_ids TEXT NOT NULL DEFAULT '[]',
      anomalies TEXT NOT NULL DEFAULT '[]',
      anomaly_signature TEXT NOT NULL DEFAULT '',
      follow_up_delivered INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      backlog_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_ralph_cycles_started
      ON ralph_cycles(started_at);
  `);
}

function addBacklogAffinityColumns(db: DatabaseSync): void {
  ensureColumn(
    db,
    "unrouted_backlog",
    "preferred_agent_id",
    "ALTER TABLE unrouted_backlog ADD COLUMN preferred_agent_id TEXT",
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_backlog_preferred_agent_status
      ON unrouted_backlog(preferred_agent_id, status);
  `);
}

function createTaskAssignmentTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      branch TEXT,
      pr_number INTEGER,
      status TEXT NOT NULL DEFAULT 'assigned'
        CHECK(status IN ('assigned', 'branch_pushed', 'pr_open', 'pr_merged', 'pr_closed')),
      thread_id TEXT NOT NULL,
      source_message_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(issue_number)
    );

    CREATE INDEX IF NOT EXISTS idx_task_assignments_agent_status
      ON task_assignments(agent_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_assignments_branch
      ON task_assignments(branch);
  `);
}

function migrateTaskAssignmentsToIssueOwnership(db: DatabaseSync): void {
  const existingTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_assignments'")
    .get() as { name?: string } | undefined;
  if (!existingTable) {
    createTaskAssignmentTable(db);
    return;
  }

  db.exec(`
    ALTER TABLE task_assignments RENAME TO task_assignments_legacy;
    DROP INDEX IF EXISTS idx_task_assignments_agent_status;
    DROP INDEX IF EXISTS idx_task_assignments_branch;
  `);

  createTaskAssignmentTable(db);

  db.exec(`
    INSERT INTO task_assignments (
      agent_id,
      issue_number,
      branch,
      pr_number,
      status,
      thread_id,
      source_message_id,
      created_at,
      updated_at
    )
    SELECT
      legacy.agent_id,
      legacy.issue_number,
      legacy.branch,
      legacy.pr_number,
      legacy.status,
      legacy.thread_id,
      legacy.source_message_id,
      legacy.created_at,
      legacy.updated_at
    FROM task_assignments_legacy AS legacy
    WHERE legacy.id = (
      SELECT latest.id
      FROM task_assignments_legacy AS latest
      WHERE latest.issue_number = legacy.issue_number
      ORDER BY latest.updated_at DESC, latest.created_at DESC, latest.id DESC
      LIMIT 1
    );

    DROP TABLE task_assignments_legacy;
  `);
}

function createScheduledWakeupsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_wakeups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      agent_stable_id TEXT,
      thread_id TEXT NOT NULL,
      body TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_wakeups_fire_target
      ON scheduled_wakeups(fire_at, agent_stable_id, agent_id);
  `);
}

function addScheduledWakeupStableIdColumn(db: DatabaseSync): void {
  ensureColumn(
    db,
    "scheduled_wakeups",
    "agent_stable_id",
    "ALTER TABLE scheduled_wakeups ADD COLUMN agent_stable_id TEXT",
  );

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_wakeups_fire_target
      ON scheduled_wakeups(fire_at, agent_stable_id, agent_id);
  `);

  db.prepare(
    `UPDATE scheduled_wakeups
     SET agent_stable_id = (
       SELECT stable_id FROM agents WHERE agents.id = scheduled_wakeups.agent_id
     )
     WHERE agent_stable_id IS NULL`,
  ).run();
}

function runSchemaMigrations(db: DatabaseSync): void {
  const currentVersion = getUserVersion(db);
  if (currentVersion >= CURRENT_BROKER_SCHEMA_VERSION) {
    return;
  }

  for (
    let nextVersion = currentVersion + 1;
    nextVersion <= CURRENT_BROKER_SCHEMA_VERSION;
    nextVersion += 1
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      switch (nextVersion) {
        case 1:
          createCoreTables(db);
          break;
        case 2:
          createBacklogTable(db);
          break;
        case 3:
          addAgentLifecycleColumns(db);
          break;
        case 4:
          addObservabilityColumns(db);
          break;
        case 5:
          addBacklogAffinityColumns(db);
          break;
        case 6:
          createTaskAssignmentTable(db);
          break;
        case 7:
          migrateTaskAssignmentsToIssueOwnership(db);
          break;
        case 8:
          createScheduledWakeupsTable(db);
          break;
        case 9:
          addScheduledWakeupStableIdColumn(db);
          break;
        case 10:
          createSettingsTable(db);
          break;
        default:
          throw new Error(`Unsupported broker schema migration target: ${nextVersion}`);
      }
      setUserVersion(db, nextVersion);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best effort */
      }
      throw new Error(`Broker schema migration v${nextVersion} failed`, { cause: error });
    }
  }
}

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

    try {
      this.openAndMigrate();
    } catch (error) {
      console.error(
        `[BrokerDB] Failed to open or migrate ${this.dbPath}; recreating from scratch`,
        error,
      );
      this.resetDatabaseFiles();

      try {
        this.openAndMigrate();
      } catch (recreateError) {
        console.error(`[BrokerDB] Failed to recreate ${this.dbPath} from scratch`, recreateError);
        this.close();
        throw recreateError;
      }
    }

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
    const missingColumns = this.getMissingRequiredAgentLifecycleColumns(db);
    if (missingColumns.length > 0) {
      console.error(
        `[BrokerDB] Skipping startup reconciliation; agents table is missing columns: ${missingColumns.join(", ")}`,
      );
      return;
    }

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
    const existingRow = existingById ?? existing;
    const agentId = existing?.id ?? id;
    const finalName = this.ensureUniqueAgentName(name, agentId);
    const finalEmoji = emoji.trim() || existingRow?.emoji || "";
    const persistedStableId = stableId ?? existing?.stable_id ?? existingById?.stable_id ?? null;
    // Reconnecting agents are authoritative for their current runtime identity. If a
    // stable session comes back with a new name/emoji, refresh the broker roster
    // instead of replaying stale values from the previous broker DB row.
    const finalMetadata =
      metadata ??
      (existingRow?.metadata
        ? (JSON.parse(existingRow.metadata) as Record<string, unknown>)
        : undefined);
    const meta = finalMetadata ? JSON.stringify(finalMetadata) : null;

    db.prepare(
      `INSERT INTO agents (
         id, stable_id, name, emoji, pid,
         connected_at, last_seen, last_heartbeat,
         metadata, status, disconnected_at, resumable_until,
         idle_since, last_activity
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, NULL)
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
         resumable_until = NULL,
         idle_since = excluded.idle_since,
         last_activity = NULL`,
    ).run(agentId, persistedStableId, finalName, finalEmoji, pid, now, now, now, meta, now);

    return {
      id: agentId,
      name: finalName,
      emoji: finalEmoji,
      pid,
      connectedAt: now,
      lastSeen: now,
      lastHeartbeat: now,
      metadata: finalMetadata ?? null,
      status: "idle" as const,
      idleSince: now,
      lastActivity: null,
    };
  }

  unregisterAgent(id: string): void {
    const db = this.getDb();
    const now = new Date().toISOString();

    this.withTransaction(() => {
      this.requeueUndeliveredMessagesInternal(id, "agent_disconnected");
      db.prepare("DELETE FROM inbox WHERE agent_id = ?").run(id);
      db.prepare("UPDATE agents SET disconnected_at = ?, resumable_until = NULL WHERE id = ?").run(
        now,
        id,
      );
      db.prepare("UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?").run(id);
    });
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

  getSetting<T = unknown>(key: string): T | null {
    const db = this.getDb();
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  setSetting(key: string, value: unknown): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), now);
  }

  deleteSetting(key: string): void {
    const db = this.getDb();
    db.prepare("DELETE FROM settings WHERE key = ?").run(key);
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

  purgeDisconnectedAgents(graceMs = DEFAULT_DISCONNECTED_PURGE_GRACE_MS): string[] {
    const db = this.getDb();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const cutoff = new Date(now - graceMs).toISOString();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT id FROM agents
           WHERE disconnected_at IS NOT NULL
             AND disconnected_at <= ?
             AND (resumable_until IS NULL OR resumable_until <= ?)`,
        )
        .all(cutoff, nowIso) as Array<{ id: string }>;

      if (rows.length === 0) {
        return [];
      }

      const releaseThreads = db.prepare(
        "UPDATE threads SET owner_agent = NULL WHERE owner_agent = ?",
      );
      const deleteInbox = db.prepare("DELETE FROM inbox WHERE agent_id = ?");

      for (const row of rows) {
        // Requeue undelivered messages to the backlog
        this.requeueUndeliveredMessagesInternal(row.id, "agent_disconnected");
        // Release thread ownership for the purged agent
        releaseThreads.run(row.id);
        // Clean up all inbox entries (both delivered and undelivered) for the agent
        deleteInbox.run(row.id);
      }

      db.prepare(
        `DELETE FROM agents
         WHERE disconnected_at IS NOT NULL
           AND disconnected_at <= ?
           AND (resumable_until IS NULL OR resumable_until <= ?)`,
      ).run(cutoff, nowIso);

      return rows.map((row) => row.id);
    });
  }

  updateAgentStatus(id: string, status: "working" | "idle"): void {
    const db = this.getDb();
    const now = new Date().toISOString();
    if (status === "idle") {
      // Transitioning to idle: set idle_since, preserve last_activity
      db.prepare(
        `UPDATE agents
         SET status = ?, last_seen = ?,
             idle_since = COALESCE(CASE WHEN status = 'idle' THEN idle_since ELSE NULL END, ?)
         WHERE id = ?`,
      ).run(status, now, now, id);
    } else {
      // Transitioning to working: clear idle_since, update last_activity
      db.prepare(
        "UPDATE agents SET status = ?, last_seen = ?, idle_since = NULL, last_activity = ? WHERE id = ?",
      ).run(status, now, now, id);
    }
  }

  updateAgentIdentity(
    id: string,
    identity: { name: string; emoji: string; metadata?: Record<string, unknown> | null },
  ): AgentInfo | null {
    const db = this.getDb();
    const existing = this.getAgentRowById(id);
    if (!existing) return null;

    const finalName = this.ensureUniqueAgentName(identity.name, id);
    const finalEmoji = identity.emoji.trim() || existing.emoji;
    const metadata =
      identity.metadata ?? (existing.metadata ? JSON.parse(existing.metadata) : null);
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    db.prepare(
      `UPDATE agents
       SET name = ?, emoji = ?, metadata = ?, last_seen = ?
       WHERE id = ?`,
    ).run(finalName, finalEmoji, metadataJson, new Date().toISOString(), id);

    const updated = this.getAgentRowById(id);
    return updated ? rowToAgent(updated) : null;
  }

  touchAgentActivity(id: string): void {
    const db = this.getDb();
    db.prepare("UPDATE agents SET last_activity = ?, last_seen = ? WHERE id = ?").run(
      new Date().toISOString(),
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
      const row = db
        .prepare("SELECT id FROM agents WHERE lower(name) = lower(?) AND id != ? LIMIT 1")
        .get(candidate, agentId) as { id: string } | undefined;
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

  getAgentByStableId(stableId: string): AgentInfo | null {
    const row = this.getAgentRowByStableId(stableId);
    return row ? rowToAgent(row) : null;
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

  claimThread(threadId: string, agentId: string, source = "slack", channel = ""): boolean {
    const db = this.getDb();
    const now = new Date().toISOString();

    // Atomic claim: insert the thread if new, or update the owner only
    // if the thread is currently unclaimed or already owned by this agent.
    // A single statement avoids the TOCTOU race of read-then-write. (#125)
    db.prepare(
      `INSERT INTO threads (thread_id, source, channel, owner_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         owner_agent = excluded.owner_agent,
         updated_at = excluded.updated_at
       WHERE threads.owner_agent IS NULL OR threads.owner_agent = excluded.owner_agent`,
    ).run(threadId, source, channel, agentId, now, now);

    // Verify: read back the owner.  If the WHERE clause above didn't
    // match (another agent owns the thread), the row was not updated
    // and the owner will differ from agentId.
    const thread = this.getThread(threadId);
    return thread?.ownerAgent === agentId;
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

  dropBacklogEntry(id: number, reason: string): BacklogEntry | null {
    const db = this.getDb();
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE unrouted_backlog
         SET status = 'dropped',
             reason = ?,
             assigned_agent_id = NULL,
             updated_at = ?
         WHERE id = ?
           AND status = 'pending'`,
      )
      .run(reason, now, id);

    if (Number(result.changes ?? 0) === 0) {
      return null;
    }

    return this.getBacklogById(id);
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

  getOwnedThreadCount(agentId: string): number {
    const db = this.getDb();
    const row = db
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE owner_agent = ?")
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

  // ─── Task assignments ───────────────────────────────

  recordTaskAssignment(
    agentId: string,
    issueNumber: number,
    branch: string | null,
    threadId: string,
    sourceMessageId: number | null,
  ): TaskAssignmentInfo {
    const db = this.getDb();
    const now = new Date().toISOString();
    const existing = db
      .prepare("SELECT * FROM task_assignments WHERE issue_number = ?")
      .get(issueNumber) as TaskAssignmentRow | undefined;

    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO task_assignments (
             agent_id, issue_number, branch, pr_number, status,
             thread_id, source_message_id, created_at, updated_at
           ) VALUES (?, ?, ?, NULL, 'assigned', ?, ?, ?, ?)`,
        )
        .run(agentId, issueNumber, branch, threadId, sourceMessageId, now, now);

      const row = db
        .prepare("SELECT * FROM task_assignments WHERE id = ?")
        .get(Number(info.lastInsertRowid)) as TaskAssignmentRow | undefined;
      if (!row) {
        throw new Error(`Failed to create task assignment for ${agentId}#${issueNumber}`);
      }
      return rowToTaskAssignment(row);
    }

    const isReassignment = existing.agent_id !== agentId;
    const nextBranch = isReassignment ? branch : (branch ?? existing.branch);
    const shouldResetProgress = isReassignment || nextBranch !== existing.branch;
    db.prepare(
      `UPDATE task_assignments
       SET agent_id = ?,
           branch = ?,
           pr_number = CASE WHEN ? THEN NULL ELSE pr_number END,
           status = CASE WHEN ? THEN 'assigned' ELSE status END,
           thread_id = ?,
           source_message_id = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      agentId,
      nextBranch,
      shouldResetProgress ? 1 : 0,
      shouldResetProgress ? 1 : 0,
      threadId,
      sourceMessageId,
      now,
      existing.id,
    );

    const row = db.prepare("SELECT * FROM task_assignments WHERE id = ?").get(existing.id) as
      | TaskAssignmentRow
      | undefined;
    if (!row) {
      throw new Error(`Failed to update task assignment for ${agentId}#${issueNumber}`);
    }
    return rowToTaskAssignment(row);
  }

  listTaskAssignments(): TaskAssignmentInfo[] {
    const db = this.getDb();
    const rows = db
      .prepare(
        `SELECT * FROM task_assignments
         ORDER BY updated_at DESC, created_at DESC, id DESC`,
      )
      .all() as unknown as TaskAssignmentRow[];
    return rows.map(rowToTaskAssignment);
  }

  updateTaskAssignmentProgress(
    id: number,
    status: TaskAssignmentStatus,
    prNumber: number | null,
  ): void {
    const db = this.getDb();
    db.prepare(
      `UPDATE task_assignments
       SET status = ?,
           pr_number = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(status, prNumber, new Date().toISOString(), id);
  }

  // ─── Scheduled wake-ups ──────────────────────────────

  scheduleWakeup(
    agentId: string,
    body: string,
    fireAt: string,
    threadId = `wakeup:${agentId}`,
  ): ScheduledWakeupInfo {
    const db = this.getDb();
    const createdAt = new Date().toISOString();
    const canonicalFireAt = new Date(fireAt).toISOString();
    const agentStableId = this.getAgentRowById(agentId)?.stable_id ?? null;

    const info = db
      .prepare(
        `INSERT INTO scheduled_wakeups (
           agent_id,
           agent_stable_id,
           thread_id,
           body,
           fire_at,
           created_at
         )
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentId, agentStableId, threadId, body, canonicalFireAt, createdAt);

    const row = db
      .prepare("SELECT * FROM scheduled_wakeups WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as ScheduledWakeupRow | undefined;
    if (!row) {
      throw new Error(`Failed to create scheduled wake-up for ${agentId}`);
    }
    return rowToScheduledWakeup(row);
  }

  listScheduledWakeups(agentId?: string): ScheduledWakeupInfo[] {
    const db = this.getDb();
    const agentStableId = agentId ? (this.getAgentRowById(agentId)?.stable_id ?? null) : null;
    const rows = (agentId
      ? agentStableId
        ? db
            .prepare(
              `SELECT * FROM scheduled_wakeups
               WHERE agent_stable_id = ?
                  OR (agent_stable_id IS NULL AND agent_id = ?)
               ORDER BY fire_at ASC, id ASC`,
            )
            .all(agentStableId, agentId)
        : db
            .prepare(
              `SELECT * FROM scheduled_wakeups
               WHERE agent_id = ?
               ORDER BY fire_at ASC, id ASC`,
            )
            .all(agentId)
      : db
          .prepare(
            `SELECT * FROM scheduled_wakeups
             ORDER BY fire_at ASC, id ASC`,
          )
          .all()) as unknown as ScheduledWakeupRow[];
    return rows.map(rowToScheduledWakeup);
  }

  deliverDueScheduledWakeups(
    now = new Date().toISOString(),
    limit = 50,
  ): ScheduledWakeupDelivery[] {
    const db = this.getDb();

    return this.withTransaction(() => {
      const rows = db
        .prepare(
          `SELECT
             sw.*,
             COALESCE(stable_agent.id, direct_agent.id) AS target_agent_id
           FROM scheduled_wakeups sw
           LEFT JOIN agents stable_agent
             ON sw.agent_stable_id IS NOT NULL
            AND stable_agent.stable_id = sw.agent_stable_id
            AND stable_agent.disconnected_at IS NULL
           LEFT JOIN agents direct_agent
             ON sw.agent_stable_id IS NULL
            AND direct_agent.id = sw.agent_id
            AND direct_agent.disconnected_at IS NULL
           WHERE sw.fire_at <= ?
             AND COALESCE(stable_agent.id, direct_agent.id) IS NOT NULL
           ORDER BY sw.fire_at ASC, sw.id ASC
           LIMIT ?`,
        )
        .all(now, limit) as unknown as Array<ScheduledWakeupRow & { target_agent_id: string }>;

      if (rows.length === 0) {
        return [];
      }

      const deleteWakeup = db.prepare("DELETE FROM scheduled_wakeups WHERE id = ?");
      const deliveries: ScheduledWakeupDelivery[] = [];

      for (const row of rows) {
        const targetAgentId = row.target_agent_id;

        if (!this.getThread(row.thread_id)) {
          this.createThread(row.thread_id, "agent", "", targetAgentId);
        } else {
          this.updateThread(row.thread_id, { ownerAgent: targetAgentId });
        }

        const message = this.insertMessage(
          row.thread_id,
          "agent",
          "inbound",
          "scheduler",
          row.body,
          [targetAgentId],
          {
            senderAgent: "Pinet Scheduler",
            scheduledWakeup: true,
            wakeupId: row.id,
            fireAt: row.fire_at,
          },
        );
        deleteWakeup.run(row.id);
        deliveries.push({ wakeup: rowToScheduledWakeup(row), message });
      }

      return deliveries;
    });
  }

  // ─── Ralph cycles ────────────────────────────────────

  recordRalphCycle(record: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    ghostAgentIds: string[];
    nudgeAgentIds: string[];
    idleDrainAgentIds: string[];
    stuckAgentIds: string[];
    anomalies: string[];
    anomalySignature: string;
    followUpDelivered: boolean;
    agentCount: number;
    backlogCount: number;
  }): number {
    const db = this.getDb();
    const info = db
      .prepare(
        `INSERT INTO ralph_cycles (
           started_at, completed_at, duration_ms,
           ghost_agent_ids, nudge_agent_ids, idle_drain_agent_ids, stuck_agent_ids,
           anomalies, anomaly_signature, follow_up_delivered,
           agent_count, backlog_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.startedAt,
        record.completedAt,
        record.durationMs,
        JSON.stringify(record.ghostAgentIds),
        JSON.stringify(record.nudgeAgentIds),
        JSON.stringify(record.idleDrainAgentIds),
        JSON.stringify(record.stuckAgentIds),
        JSON.stringify(record.anomalies),
        record.anomalySignature,
        record.followUpDelivered ? 1 : 0,
        record.agentCount,
        record.backlogCount,
      );
    return Number(info.lastInsertRowid);
  }

  getRecentRalphCycles(limit = 20): Array<{
    id: number;
    startedAt: string;
    completedAt: string | null;
    durationMs: number | null;
    ghostAgentIds: string[];
    nudgeAgentIds: string[];
    idleDrainAgentIds: string[];
    stuckAgentIds: string[];
    anomalies: string[];
    anomalySignature: string;
    followUpDelivered: boolean;
    agentCount: number;
    backlogCount: number;
  }> {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM ralph_cycles ORDER BY started_at DESC LIMIT ?")
      .all(limit) as unknown as RalphCycleRow[];
    return rows.map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      ghostAgentIds: JSON.parse(row.ghost_agent_ids) as string[],
      nudgeAgentIds: JSON.parse(row.nudge_agent_ids) as string[],
      idleDrainAgentIds: JSON.parse(row.idle_drain_agent_ids) as string[],
      stuckAgentIds: JSON.parse(row.stuck_agent_ids) as string[],
      anomalies: JSON.parse(row.anomalies) as string[],
      anomalySignature: row.anomaly_signature,
      followUpDelivered: row.follow_up_delivered === 1,
      agentCount: row.agent_count,
      backlogCount: row.backlog_count,
    }));
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

  /** Mark all undelivered inbox rows for a given message+agent as delivered. */
  markDeliveredByMessageId(messageId: number, agentId: string): void {
    const db = this.getDb();
    db.prepare(
      "UPDATE inbox SET delivered = 1 WHERE message_id = ? AND agent_id = ? AND delivered = 0",
    ).run(messageId, agentId);
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
           i.agent_id AS target_agent_id,
           m.id AS message_id,
           m.thread_id AS thread_id,
           m.source AS source,
           m.metadata AS metadata
         FROM inbox i
         JOIN messages m ON m.id = i.message_id
         WHERE i.agent_id = ?
           AND i.delivered = 0
           AND m.direction = 'inbound'`,
      )
      .all(agentId) as Array<{
      inbox_id: number;
      target_agent_id: string;
      message_id: number;
      thread_id: string;
      source: string;
      metadata: string | null;
    }>;

    if (rows.length === 0) {
      return 0;
    }

    const markDelivered = db.prepare("UPDATE inbox SET delivered = 1 WHERE id = ?");
    for (const row of rows) {
      const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      const channel = typeof metadata.channel === "string" ? metadata.channel : "";
      const preferredAgentId = row.source === "agent" ? row.target_agent_id : null;
      this.upsertBacklogEntry(
        row.message_id,
        row.thread_id,
        channel,
        reason,
        "pending",
        preferredAgentId,
        null,
      );
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
    preferredAgentId: string | null,
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
         preferred_agent_id,
         assigned_agent_id,
         attempt_count,
         last_attempt_at,
         created_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         channel = excluded.channel,
         reason = excluded.reason,
         status = excluded.status,
         preferred_agent_id = excluded.preferred_agent_id,
         assigned_agent_id = excluded.assigned_agent_id,
         updated_at = excluded.updated_at`,
    ).run(
      threadId,
      channel,
      messageId,
      reason,
      status,
      preferredAgentId,
      assignedAgentId,
      now,
      now,
    );

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

  private openAndMigrate(): void {
    const db = this.openDatabase();
    this.db = db;
    runSchemaMigrations(db);
    this.ensureRequiredAgentLifecycleColumns(db);
  }

  private openDatabase(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath, { timeout: 5000 });
    const journalMode = db.prepare("PRAGMA journal_mode=WAL").get() as
      | SqliteJournalModeResult
      | undefined;
    if (!isSqliteWalEnabled(journalMode)) {
      console.warn(buildSqliteWalFallbackWarning("BrokerDB", journalMode));
    }
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }

  private resetDatabaseFiles(): void {
    this.close();
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  private getMissingRequiredAgentLifecycleColumns(db: DatabaseSync): string[] {
    const columns = getTableColumns(db, "agents");
    return REQUIRED_AGENT_LIFECYCLE_COLUMNS.filter((column) => !columns.has(column));
  }

  private ensureRequiredAgentLifecycleColumns(db: DatabaseSync): void {
    const missingColumns = this.getMissingRequiredAgentLifecycleColumns(db);
    if (missingColumns.length > 0) {
      throw new Error(`agents table missing required columns: ${missingColumns.join(", ")}`);
    }
  }

  private getDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("BrokerDB not initialized — call initialize() first");
    }
    return this.db;
  }
}
