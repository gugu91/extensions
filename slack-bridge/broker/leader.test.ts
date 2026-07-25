import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultLockPath,
  getProcessStartTime,
  inspectBrokerLock,
  LeaderLock,
  readBrokerLockOwner,
} from "./leader.js";

// ─── Helpers ─────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leader-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── defaultLockPath ─────────────────────────────────────

describe("defaultLockPath", () => {
  it("returns ~/.pi/pinet-broker.lock", () => {
    expect(defaultLockPath()).toBe(path.join(os.homedir(), ".pi", "pinet-broker.lock"));
  });
});

// ─── LeaderLock ──────────────────────────────────────────

describe("LeaderLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("uses the default lock path when none is provided", () => {
    const lock = new LeaderLock();
    expect(lock.getLockPath()).toBe(defaultLockPath());
  });

  it("uses a custom lock path when provided", () => {
    const custom = path.join(dir, "custom.lock");
    const lock = new LeaderLock(custom);
    expect(lock.getLockPath()).toBe(custom);
  });

  it("starts as non-leader", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    expect(lock.isLeader()).toBe(false);
  });

  it("acquires the lock on first call", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);
    lock.release();
  });

  it("tryAcquire is idempotent — second call still returns true", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("writes the current PID as the first line of the lock file", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const [pidLine] = fs.readFileSync(lockPath, "utf-8").split("\n");
    expect(pidLine).toBe(String(process.pid));
    // Legacy readers parse the whole trimmed content with parseInt — the
    // structured metadata must not change the PID they see.
    expect(parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10)).toBe(process.pid);

    lock.release();
  });

  it("writes structured owner metadata alongside the PID", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).not.toBeNull();
    expect(owner?.pid).toBe(process.pid);
    expect(owner?.legacy).toBe(false);
    expect(owner?.instanceId).toBe(lock.getInstanceId());
    expect(owner?.createdAt).toBeTruthy();

    lock.release();
    expect(lock.getInstanceId()).toBeNull();
  });

  it("release removes the lock file", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(lock.isLeader()).toBe(false);
  });

  it("release is safe when not acquired", () => {
    const lock = new LeaderLock(path.join(dir, "lock"));
    // Should not throw
    lock.release();
    expect(lock.isLeader()).toBe(false);
  });

  it("second lock fails while the first one holds", () => {
    const lockPath = path.join(dir, "lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    expect(lock1.tryAcquire()).toBe(true);
    expect(lock2.tryAcquire()).toBe(false);
    expect(lock2.isLeader()).toBe(false);

    lock1.release();
  });

  it("second lock succeeds after the first releases", () => {
    const lockPath = path.join(dir, "lock");
    const lock1 = new LeaderLock(lockPath);
    const lock2 = new LeaderLock(lockPath);

    lock1.tryAcquire();
    lock1.release();

    expect(lock2.tryAcquire()).toBe(true);
    expect(lock2.isLeader()).toBe(true);

    lock2.release();
  });

  it("reclaims a stale lock from a dead PID", () => {
    const lockPath = path.join(dir, "lock");

    // Write a PID that almost certainly does not exist
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.isLeader()).toBe(true);

    lock.release();
  });

  it("creates parent directories if they do not exist", () => {
    const nested = path.join(dir, "a", "b", "lock");
    const lock = new LeaderLock(nested);
    expect(lock.tryAcquire()).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    lock.release();
  });

  it("reclaims a lock whose PID was reused by an unrelated process", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `${process.pid}\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    const lock = new LeaderLock(lockPath, {
      getProcessStartTime: () => "boot-B",
    });
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("does not reclaim a live lock when the start time is unknown", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `${process.pid}\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    // Unknown current start time must never count as evidence of staleness.
    const lock = new LeaderLock(lockPath, {
      getProcessStartTime: () => null,
    });
    expect(lock.tryAcquire()).toBe(false);
  });

  it("reclaims an unreadable lock file", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "not-a-pid\n", "utf-8");

    const lock = new LeaderLock(lockPath);
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });

  it("release does not remove the file if another PID overwrote it", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    // Simulate another process overwriting the lock file
    fs.writeFileSync(lockPath, "999999999", "utf-8");

    lock.release();

    // File should still exist because the PID didn't match
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe("999999999");
  });
});

// ─── readBrokerLockOwner ─────────────────────────────────

describe("readBrokerLockOwner", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("returns null when the lock file does not exist", () => {
    expect(readBrokerLockOwner(path.join(dir, "missing"))).toBeNull();
  });

  it("parses a legacy plain-PID lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "12345", "utf-8");

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).toEqual({
      pid: 12345,
      processStartTime: null,
      instanceId: null,
      hostname: null,
      createdAt: null,
      legacy: true,
    });
  });

  it("parses a structured lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(
      lockPath,
      `12345\n${JSON.stringify({
        version: 2,
        processStartTime: "boot-A",
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );

    const owner = readBrokerLockOwner(lockPath);
    expect(owner).toEqual({
      pid: 12345,
      processStartTime: "boot-A",
      instanceId: "inst-1",
      hostname: "host",
      createdAt: "2026-01-01T00:00:00.000Z",
      legacy: false,
    });
  });

  it("treats a PID followed by corrupt metadata as a legacy lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "12345\nnot-json", "utf-8");

    const owner = readBrokerLockOwner(lockPath);
    expect(owner?.pid).toBe(12345);
    expect(owner?.legacy).toBe(true);
  });

  it("returns null for unparsable content", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "garbage", "utf-8");
    expect(readBrokerLockOwner(lockPath)).toBeNull();
  });
});

// ─── inspectBrokerLock ───────────────────────────────────

describe("inspectBrokerLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  function writeStructuredLock(lockPath: string, pid: number, processStartTime: string): void {
    fs.writeFileSync(
      lockPath,
      `${pid}\n${JSON.stringify({
        version: 2,
        processStartTime,
        instanceId: "inst-1",
        hostname: "host",
        createdAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf-8",
    );
  }

  it("reports none when the lock file does not exist", () => {
    expect(inspectBrokerLock(path.join(dir, "missing"))).toEqual({ state: "none", owner: null });
  });

  it("reports unreadable for unparsable content", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "garbage", "utf-8");
    expect(inspectBrokerLock(lockPath)).toEqual({ state: "unreadable", owner: null });
  });

  it("reports stale-dead when the recorded PID is not running", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, "2147483647", "utf-8");

    const inspection = inspectBrokerLock(lockPath);
    expect(inspection.state).toBe("stale-dead");
    if (inspection.state === "stale-dead") {
      expect(inspection.owner.pid).toBe(2147483647);
    }
  });

  it("reports alive for a live legacy lock", () => {
    const lockPath = path.join(dir, "lock");
    fs.writeFileSync(lockPath, String(process.pid), "utf-8");

    const inspection = inspectBrokerLock(lockPath);
    expect(inspection.state).toBe("alive");
  });

  it("reports stale-pid-reused when start times differ", () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid, "boot-A");

    const inspection = inspectBrokerLock(lockPath, {
      getProcessStartTime: () => "boot-B",
    });
    expect(inspection.state).toBe("stale-pid-reused");
    if (inspection.state === "stale-pid-reused") {
      expect(inspection.owner.pid).toBe(process.pid);
      expect(inspection.currentStartTime).toBe("boot-B");
    }
  });

  it("reports alive when start times match", () => {
    const lockPath = path.join(dir, "lock");
    writeStructuredLock(lockPath, process.pid, "boot-A");

    const inspection = inspectBrokerLock(lockPath, {
      getProcessStartTime: () => "boot-A",
    });
    expect(inspection.state).toBe("alive");
  });
});

// ─── getProcessStartTime ─────────────────────────────────

describe("getProcessStartTime", () => {
  it("returns a stable non-empty value for the current process", () => {
    const first = getProcessStartTime(process.pid);
    const second = getProcessStartTime(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("returns null for an invalid pid", () => {
    expect(getProcessStartTime(-1)).toBeNull();
    expect(getProcessStartTime(0)).toBeNull();
  });
});
