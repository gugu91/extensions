import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerDB } from "./schema.js";
import { BrokerSocketServer } from "./socket-server.js";
import {
  BrokerLockConflictError,
  classifyBrokerLockConflict,
  formatBrokerLockConflictMessage,
  probeBrokerSocket,
  replaceBrokerOwner,
  requestBrokerShutdown,
} from "./lock-conflict.js";
import type { BrokerLockProbes } from "./leader.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lock-conflict-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeStructuredLock(
  lockPath: string,
  pid: number,
  overrides: Partial<{ processStartTime: string; instanceId: string }> = {},
): void {
  fs.writeFileSync(
    lockPath,
    `${pid}\n${JSON.stringify({
      version: 2,
      processStartTime: overrides.processStartTime ?? "boot-A",
      instanceId: overrides.instanceId ?? "inst-1",
      hostname: "host",
      createdAt: "2026-01-01T00:00:00.000Z",
    })}\n`,
    "utf-8",
  );
}

const aliveProbes: BrokerLockProbes = {
  isProcessRunning: () => true,
  getProcessStartTime: () => "boot-A",
};

// ─── probeBrokerSocket ───────────────────────────────────

describe("probeBrokerSocket", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("classifies a real broker socket as healthy", async () => {
    const db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    const sockPath = path.join(dir, "pinet.sock");
    const server = new BrokerSocketServer(db, sockPath);
    await server.start();
    try {
      const result = await probeBrokerSocket({ socketPath: sockPath });
      expect(result).toBe("healthy");
    } finally {
      await server.stop();
      db.close();
    }
  });

  it("classifies a mesh-secret-protected broker as healthy without knowing the secret", async () => {
    const db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    const sockPath = path.join(dir, "pinet.sock");
    const server = new BrokerSocketServer(db, sockPath, { meshSecret: "sekrit" });
    await server.start();
    try {
      // An auth error is still a well-formed response — the broker is serving.
      const result = await probeBrokerSocket({ socketPath: sockPath });
      expect(result).toBe("healthy");
    } finally {
      await server.stop();
      db.close();
    }
  });

  it("classifies a missing socket as unreachable", async () => {
    const result = await probeBrokerSocket({ socketPath: path.join(dir, "missing.sock") });
    expect(result).toBe("unreachable");
  });

  it("classifies a silent server as unresponsive", async () => {
    const sockPath = path.join(dir, "silent.sock");
    const connections = new Set<net.Socket>();
    const silent = net.createServer((socket) => {
      // accept and never respond
      connections.add(socket);
    });
    await new Promise<void>((resolve) => silent.listen(sockPath, resolve));
    try {
      const result = await probeBrokerSocket({ socketPath: sockPath, timeoutMs: 150 });
      expect(result).toBe("unresponsive");
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

// ─── requestBrokerShutdown ───────────────────────────────

describe("requestBrokerShutdown", () => {
  let dir: string;
  let db: BrokerDB;
  let server: BrokerSocketServer;
  let sockPath: string;

  beforeEach(async () => {
    dir = tmpDir();
    db = new BrokerDB(path.join(dir, "test.db"));
    db.initialize();
    sockPath = path.join(dir, "pinet.sock");
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    cleanup(dir);
  });

  it("reports accepted and invokes the wired handler", async () => {
    server = new BrokerSocketServer(db, sockPath);
    const handler = vi.fn(async () => {});
    server.setAdminShutdownHandler(handler);
    await server.start();

    const result = await requestBrokerShutdown({ socketPath: sockPath });
    expect(result).toBe("accepted");
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it("reports unsupported when no handler is wired", async () => {
    server = new BrokerSocketServer(db, sockPath);
    await server.start();

    const result = await requestBrokerShutdown({ socketPath: sockPath });
    expect(result).toBe("unsupported");
  });

  it("reports accepted with the correct mesh secret", async () => {
    server = new BrokerSocketServer(db, sockPath, { meshSecret: "sekrit" });
    const handler = vi.fn(async () => {});
    server.setAdminShutdownHandler(handler);
    await server.start();

    const result = await requestBrokerShutdown({ socketPath: sockPath, meshSecret: "sekrit" });
    expect(result).toBe("accepted");
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it("reports rejected with a wrong mesh secret and never invokes the handler", async () => {
    server = new BrokerSocketServer(db, sockPath, { meshSecret: "sekrit" });
    const handler = vi.fn(async () => {});
    server.setAdminShutdownHandler(handler);
    await server.start();

    const result = await requestBrokerShutdown({ socketPath: sockPath, meshSecret: "wrong" });
    expect(result).toBe("rejected");
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports rejected without a mesh secret when the broker requires one", async () => {
    server = new BrokerSocketServer(db, sockPath, { meshSecret: "sekrit" });
    const handler = vi.fn(async () => {});
    server.setAdminShutdownHandler(handler);
    await server.start();

    const result = await requestBrokerShutdown({ socketPath: sockPath });
    expect(result).toBe("rejected");
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports unreachable when the socket does not exist", async () => {
    server = new BrokerSocketServer(db, sockPath);
    await server.start();

    const result = await requestBrokerShutdown({
      socketPath: path.join(dir, "missing.sock"),
    });
    expect(result).toBe("unreachable");
  });
});

// ─── classifyBrokerLockConflict ──────────────────────────

describe("classifyBrokerLockConflict", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("reports reclaimable when no lock exists", async () => {
    const conflict = await classifyBrokerLockConflict({
      lockPath: path.join(dir, "missing"),
      probeSocket: async () => "healthy",
    });
    expect(conflict.kind).toBe("reclaimable");
    if (conflict.kind === "reclaimable") {
      expect(conflict.inspection.state).toBe("none");
    }
  });

  it("reports reclaimable for a dead-PID lock", async () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const conflict = await classifyBrokerLockConflict({
      lockPath,
      probeSocket: async () => "healthy",
    });
    expect(conflict.kind).toBe("reclaimable");
    if (conflict.kind === "reclaimable") {
      expect(conflict.inspection.state).toBe("stale-dead");
    }
  });

  it("classifies a live owner with a responding socket as active-broker", async () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid);

    const conflict = await classifyBrokerLockConflict({
      lockPath,
      probes: aliveProbes,
      probeSocket: async () => "healthy",
    });
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.classification).toBe("active-broker");
      expect(conflict.owner.pid).toBe(process.pid);
      expect(conflict.probe).toBe("healthy");
    }
  });

  it("classifies a live owner with a dead socket as unresponsive-broker", async () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid);

    const conflict = await classifyBrokerLockConflict({
      lockPath,
      probes: aliveProbes,
      probeSocket: async () => "unreachable",
    });
    expect(conflict.kind).toBe("conflict");
    if (conflict.kind === "conflict") {
      expect(conflict.classification).toBe("unresponsive-broker");
      expect(conflict.probe).toBe("unreachable");
    }
  });
});

// ─── BrokerLockConflictError ─────────────────────────────

describe("BrokerLockConflictError", () => {
  const owner = {
    pid: 1336,
    processStartTime: "boot-A",
    instanceId: "inst-1",
    hostname: "host",
    createdAt: "2026-01-01T00:00:00.000Z",
    legacy: false,
  };

  it("describes an active broker with follow/replace guidance", () => {
    const err = new BrokerLockConflictError({
      classification: "active-broker",
      owner,
      probe: "healthy",
    });
    expect(err.message).toContain("Another pinet broker is already running");
    expect(err.message).toContain("pid 1336");
    expect(err.message).toContain("/pinet follow");
    expect(err.message).toContain("/pinet start replace");
    expect(err.classification).toBe("active-broker");
  });

  it("describes a stranded broker with replace guidance", () => {
    const message = formatBrokerLockConflictMessage({
      classification: "unresponsive-broker",
      owner,
      probe: "unreachable",
    });
    expect(message).toContain("pid 1336");
    expect(message).toContain("stranded");
    expect(message).toContain("/pinet start replace");
  });
});

// ─── replaceBrokerOwner ──────────────────────────────────

describe("replaceBrokerOwner", () => {
  // A PID that is not this process; liveness comes from the stubbed probes.
  const OWNER_PID = 54321;
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = tmpDir();
    lockPath = path.join(dir, "lock");
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("reports no-conflict when the lock is missing", async () => {
    const result = await replaceBrokerOwner({ lockPath });
    expect(result.outcome).toBe("no-conflict");
  });

  it("reports no-conflict for a stale dead-PID lock", async () => {
    fs.writeFileSync(lockPath, "2147483647", "utf-8");
    const result = await replaceBrokerOwner({ lockPath });
    expect(result.outcome).toBe("no-conflict");
  });

  it("refuses to replace a lock held by the calling process itself", async () => {
    writeStructuredLock(lockPath, process.pid);
    const kill = vi.fn();
    const requestShutdown = vi.fn(async () => "accepted" as const);

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown,
      kill,
      sleep: async () => {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("this session's own process");
    expect(kill).not.toHaveBeenCalled();
    expect(requestShutdown).not.toHaveBeenCalled();
  });

  it("replaces gracefully when the broker honors admin.shutdown", async () => {
    writeStructuredLock(lockPath, OWNER_PID);
    const kill = vi.fn();

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => {
        fs.unlinkSync(lockPath);
        return "accepted";
      },
      kill,
      sleep: async () => {},
    });

    expect(result.outcome).toBe("replaced-graceful");
    expect(kill).not.toHaveBeenCalled();
    expect(result.owner?.pid).toBe(OWNER_PID);
  });

  it("falls back to a fenced SIGTERM when shutdown is unsupported", async () => {
    writeStructuredLock(lockPath, OWNER_PID);
    const kill = vi.fn((pid: number, _signal: NodeJS.Signals) => {
      expect(pid).toBe(OWNER_PID);
      fs.unlinkSync(lockPath);
    });

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => "unsupported",
      kill,
      sleep: async () => {},
    });

    expect(result.outcome).toBe("replaced-terminated");
    expect(kill).toHaveBeenCalledWith(OWNER_PID, "SIGTERM");
  });

  it("refuses automatic SIGTERM for a legacy lock without a start-time fence", async () => {
    // Legacy PID-only lock: no instanceId, no processStartTime — PID reuse
    // cannot be detected, so the owner must never be signalled automatically.
    fs.writeFileSync(lockPath, String(OWNER_PID), "utf-8");
    const kill = vi.fn();

    const result = await replaceBrokerOwner({
      lockPath,
      probes: { isProcessRunning: () => true, getProcessStartTime: () => "whatever" },
      requestShutdown: async () => "unsupported",
      kill,
      sleep: async () => {},
    });

    expect(result.outcome).toBe("failed");
    expect(kill).not.toHaveBeenCalled();
    expect(result.error).toContain("predates identity fencing");
    expect(result.error).toContain(`ps -p ${OWNER_PID}`);
  });

  it("aborts without SIGTERM when the broker rejects the shutdown request", async () => {
    // A responsive broker refusing shutdown (e.g. mesh secret mismatch) is
    // not stranded — escalating to signals would bypass its refusal.
    writeStructuredLock(lockPath, OWNER_PID);
    const kill = vi.fn();

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => "rejected",
      kill,
      sleep: async () => {},
    });

    expect(result.outcome).toBe("failed");
    expect(kill).not.toHaveBeenCalled();
    expect(result.error).toContain("rejected the shutdown request");
    expect(result.error).toContain("mesh secret");
  });

  it("aborts when the lock owner changes mid-flight", async () => {
    writeStructuredLock(lockPath, OWNER_PID, { instanceId: "inst-1" });

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => {
        // A different broker instance takes over during the graceful wait.
        writeStructuredLock(lockPath, OWNER_PID, { instanceId: "inst-2" });
        return "accepted";
      },
      kill: vi.fn(),
      sleep: async () => {},
    });

    expect(result.outcome).toBe("owner-changed");
    expect(result.error).toContain("changed owners");
  });

  it("fails without SIGKILL escalation when the owner survives SIGTERM", async () => {
    writeStructuredLock(lockPath, OWNER_PID);
    const kill = vi.fn();

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => "unsupported",
      kill,
      sleep: async () => {},
      terminateWaitMs: 30,
      pollIntervalMs: 5,
    });

    expect(result.outcome).toBe("failed");
    expect(kill).toHaveBeenCalledWith(OWNER_PID, "SIGTERM");
    expect(result.error).toContain(`pid ${OWNER_PID}`);
    expect(result.error).toContain("Not escalating to SIGKILL");
  });

  it("continues to the release wait when signal delivery fails", async () => {
    writeStructuredLock(lockPath, OWNER_PID);

    const result = await replaceBrokerOwner({
      lockPath,
      probes: aliveProbes,
      requestShutdown: async () => "unreachable",
      kill: () => {
        // Simulate ESRCH — the owner exited between the fence check and the
        // signal; the lock is gone by the time we wait.
        fs.unlinkSync(lockPath);
        throw new Error("kill ESRCH");
      },
      sleep: async () => {},
    });

    expect(result.outcome).toBe("replaced-terminated");
  });
});
