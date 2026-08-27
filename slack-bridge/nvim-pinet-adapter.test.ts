import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextJsonValue } from "./code-anchor.js";
import {
  NvimPinetAdapter,
  resolveNvimRepositoryContext,
  type NvimAdapterDbPort,
} from "./nvim-pinet-adapter.js";
import { BrokerDB } from "./broker/schema.js";
import type { BrokerMessage, DocumentInfo, ThreadInfo } from "./broker/types.js";

function request(
  socketPath: string,
  type: string,
  payload: object,
): Promise<Record<string, ContextJsonValue>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const parsed = JSON.parse(line) as Record<string, ContextJsonValue>;
        if (parsed.id !== "req-1") continue;
        socket.destroy();
        if (parsed.type === "error") reject(new Error(JSON.stringify(parsed.error)));
        else resolve(parsed.result as Record<string, ContextJsonValue>);
        return;
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "req-1", type, payload })}\n`);
    });
  });
}

function createDb(): NvimAdapterDbPort {
  const threads = new Map<string, ThreadInfo>();
  const documents = new Map<string, DocumentInfo>();
  const aliases = new Map<string, string>();
  const subscribers = new Map<string, Set<string>>();
  const messages: BrokerMessage[] = [];
  return {
    getThread: (threadId) => threads.get(threadId) ?? null,
    getDocument: (documentId) => documents.get(documentId) ?? null,
    getDocumentByAlias: (source, externalId) => {
      const documentId = aliases.get(`${source}\0${externalId}`);
      return documentId ? (documents.get(documentId) ?? null) : null;
    },
    upsertDocument: (document) => {
      const now = new Date().toISOString();
      const existing = documents.get(document.documentId);
      const stored = { ...document, createdAt: existing?.createdAt ?? now, updatedAt: now };
      documents.set(document.documentId, stored);
      return stored;
    },
    bindDocumentAlias: (source, externalId, documentId) => {
      aliases.set(`${source}\0${externalId}`, documentId);
    },
    setDocumentOwner: (documentId, ownerAgent) => {
      const existing = documents.get(documentId);
      if (!existing) throw new Error(`Unknown document ${documentId}`);
      const updated = { ...existing, ownerAgent, ownerBinding: "explicit" as const };
      documents.set(documentId, updated);
      return updated;
    },
    subscribeDocument: (documentId, agentId) => {
      const values = subscribers.get(documentId) ?? new Set<string>();
      values.add(agentId);
      subscribers.set(documentId, values);
    },
    unsubscribeDocument: (documentId, agentId) => subscribers.get(documentId)?.delete(agentId),
    listDocumentSubscribers: (documentId) => [...(subscribers.get(documentId) ?? [])].sort(),
    getDocumentRecipients: (documentId) => {
      const document = documents.get(documentId);
      return [
        ...new Set([
          ...(document?.ownerAgent ? [document.ownerAgent] : []),
          ...(subscribers.get(documentId) ?? []),
        ]),
      ];
    },
    createThread: (thread) => {
      threads.set(thread.threadId, thread);
      return thread;
    },
    updateThread: (threadId, updates) => {
      const existing = threads.get(threadId);
      if (existing) threads.set(threadId, { ...existing, ...updates });
    },
    getThreads: () => [...threads.values()],
    getMessagesForThread: (threadId) => messages.filter((message) => message.threadId === threadId),
    insertMessage: (threadId, source, direction, sender, body, _targetAgentIds, metadata) => {
      const message = {
        id: messages.length + 1,
        threadId,
        source,
        direction,
        sender,
        body,
        metadata: metadata ?? null,
        createdAt: new Date().toISOString(),
      } satisfies BrokerMessage;
      messages.push(message);
      return message;
    },
  };
}

describe("NvimPinetAdapter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates, revision-filters, replies, and resolves ordinary Pinet threads", async () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "nvim-pinet-repo-")));
    dirs.push(repoRoot);
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "app.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot });
    const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const blobOid = execFileSync("git", ["hash-object", "app.ts"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    const db = createDb();
    const adapter = new NvimPinetAdapter({
      repository: repoRoot,
      worktree: repoRoot,
      branch: "main",
      headOid,
      baseOid: null,
      db,
      getAgentById: (agentId) =>
        agentId === "agent-1" || agentId === "agent-2"
          ? { id: agentId, name: `Agent ${agentId}` }
          : null,
    });
    const inboundBodies: string[] = [];
    adapter.onInbound((message) => inboundBodies.push(message.text));
    await adapter.connect();
    try {
      const socketPath =
        "/tmp/pi-nvim/" + createHash("sha256").update(`${repoRoot}:main`).digest("hex") + ".sock";
      const editorSocket = net.createConnection(socketPath);
      await new Promise<void>((resolve, reject) => {
        editorSocket.once("connect", resolve);
        editorSocket.once("error", reject);
      });
      const opened = new Promise<Record<string, ContextJsonValue>>((resolve) => {
        editorSocket.on("data", (data) => {
          for (const line of data.toString().split("\n")) {
            if (!line) continue;
            const message = JSON.parse(line) as Record<string, ContextJsonValue>;
            if (message.type === "open_file") resolve(message);
          }
        });
      });
      await expect(
        request(socketPath, "editor.open", { file: "app.ts", line: 1 }),
      ).resolves.toMatchObject({ delivered: true });
      await expect(opened).resolves.toMatchObject({ type: "open_file", file: "app.ts", line: 1 });
      editorSocket.destroy();
      await expect(request(socketPath, "", {})).rejects.toThrow("type is required");

      const anchor = {
        repository: repoRoot,
        worktree: repoRoot,
        path: "app.ts",
        baseOid: null,
        headOid,
        blobOid,
        anchorKind: "diff",
        side: "new",
      };
      const created = await request(socketPath, "pinet.thread.create", {
        targetAgentId: "agent-1",
        body: "Please inspect this line",
        anchor,
        startLine: 1,
        endLine: 1,
      });
      const threadId = created.threadId as string;
      expect(threadId).toMatch(/^nvim:/);
      expect(inboundBodies[0]).toContain(`[code-anchor app.ts:1 side=new head=${headOid}`);

      const normalAnchor = {
        repository: repoRoot,
        worktree: repoRoot,
        path: "app.ts",
        baseOid: null,
        headOid,
        blobOid,
        anchorKind: "normal",
        headBlobOid: blobOid,
        dirty: false,
      };
      await expect(
        request(socketPath, "pinet.document.subscribe", {
          anchor: normalAnchor,
          agentId: "agent-2",
        }),
      ).resolves.toMatchObject({ ownerAgentId: "agent-1", subscribers: ["agent-2"] });
      const normalCreated = await request(socketPath, "pinet.thread.create", {
        body: "Normal buffer comment",
        anchor: normalAnchor,
        startLine: 1,
        endLine: 1,
      });
      expect(normalCreated.threadId).toMatch(/^nvim:/);
      await expect(
        request(socketPath, "pinet.thread.list", { anchor: normalAnchor }),
      ).resolves.toMatchObject({
        threads: [
          {
            threadId: normalCreated.threadId,
            metadata: {
              schemaVersion: 2,
              codeAnchor: { anchorKind: "normal", dirty: false, headBlobOid: blobOid },
            },
          },
        ],
      });
      await request(socketPath, "pinet.document.owner", {
        anchor: normalAnchor,
        agentId: "agent-2",
      });
      expect(db.getThread(normalCreated.threadId as string)?.ownerAgent).toBe("agent-2");
      expect(db.getThread(threadId)?.ownerAgent).toBe("agent-2");

      db.upsertDocument({
        documentId: "doc:slack-thread:old",
        kind: "slack_thread",
        title: "Slack C123/111.222",
        ownerAgent: "agent-1",
        ownerBinding: "explicit",
        metadata: null,
      });
      db.subscribeDocument("doc:slack-thread:old", "agent-1");
      db.createThread({
        threadId: "111.222",
        source: "slack",
        channel: "C123",
        ownerAgent: "agent-1",
        ownerBinding: "explicit",
        metadata: {
          documentId: "doc:slack-thread:old",
          documentAliasExternalId: "workspace\\0C123\\0111.222",
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const bound = await request(socketPath, "pinet.document.bind_thread", {
        anchor: normalAnchor,
        threadId: "111.222",
      });
      expect(db.getThread("111.222")?.metadata?.documentId).toBe(bound.documentId);
      expect(db.getThread("111.222")?.ownerAgent).toBe("agent-2");
      expect(bound.subscribers).toEqual(["agent-1", "agent-2"]);

      await request(socketPath, "pinet.thread.reply", { threadId, body: "Follow-up" });
      expect(inboundBodies).toContain("Follow-up");

      const listed = await request(socketPath, "pinet.thread.list", {
        anchor,
        includeResolved: false,
      });
      expect(listed.threads as ContextJsonValue[]).toHaveLength(1);
      const stale = await request(socketPath, "pinet.thread.list", {
        anchor: { ...anchor, blobOid: "different" },
        includeResolved: false,
      });
      expect(stale.threads as ContextJsonValue[]).toHaveLength(0);

      await request(socketPath, "pinet.thread.resolve", { threadId, resolved: true });
      const openOnly = await request(socketPath, "pinet.thread.list", {
        anchor,
        includeResolved: false,
      });
      expect(openOnly.threads as ContextJsonValue[]).toHaveLength(0);
    } finally {
      await adapter.disconnect();
    }
  });

  it("restores anchored messages from BrokerDB after adapter and database restart", async () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "nvim-pinet-persist-")));
    dirs.push(repoRoot);
    const dbPath = join(repoRoot, "broker.db");
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, "app.ts"), "persisted\n");
    execFileSync("git", ["add", "app.ts"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot });
    const headOid = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const blobOid = execFileSync("git", ["hash-object", "app.ts"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const anchor = {
      repository: repoRoot,
      worktree: repoRoot,
      path: "app.ts",
      baseOid: null,
      headOid,
      blobOid,
      anchorKind: "diff",
      side: "new",
    };
    const socketPath =
      "/tmp/pi-nvim/" +
      createHash("sha256").update(`${repoRoot}:persistence`).digest("hex") +
      ".sock";

    const firstDb = new BrokerDB(dbPath);
    firstDb.initialize();
    const first = new NvimPinetAdapter({
      repository: repoRoot,
      worktree: repoRoot,
      branch: "persistence",
      headOid,
      baseOid: null,
      db: firstDb,
      getAgentById: (id) => ({ id, name: "Agent" }),
    });
    first.onInbound((message) => {
      firstDb.insertMessage(
        message.threadId,
        message.source,
        "inbound",
        message.userName ?? message.userId,
        message.text,
        ["agent-1"],
        message.metadata,
      );
    });
    await first.connect();
    await request(socketPath, "pinet.thread.create", {
      targetAgentId: "agent-1",
      body: "Persist me",
      anchor,
      startLine: 1,
      endLine: 1,
    });
    await first.disconnect();
    firstDb.close();

    const secondDb = new BrokerDB(dbPath);
    secondDb.initialize();
    const second = new NvimPinetAdapter({
      repository: repoRoot,
      worktree: repoRoot,
      branch: "persistence",
      headOid,
      baseOid: null,
      db: secondDb,
      getAgentById: (id) => ({ id, name: "Agent" }),
    });
    await second.connect();
    try {
      const listed = await request(socketPath, "pinet.thread.list", {
        anchor,
        includeResolved: false,
      });
      const threads = listed.threads as Array<Record<string, ContextJsonValue>>;
      expect(threads).toHaveLength(1);
      expect(threads[0]?.messages).toEqual([
        expect.objectContaining({ body: expect.stringContaining("Persist me") }),
      ]);
    } finally {
      await second.disconnect();
      secondDb.close();
    }
  });

  it("canonicalizes a Pi subdirectory to the same worktree socket identity", () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "nvim-pinet-root-")));
    dirs.push(repoRoot);
    execFileSync("git", ["init"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoRoot });
    const nested = join(repoRoot, "src", "nested");
    mkdirSync(nested, { recursive: true });

    expect(resolveNvimRepositoryContext(nested)?.worktree).toBe(repoRoot);
  });
});
