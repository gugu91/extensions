import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLockPath, LeaderLock } from "./leader.js";

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

  it("writes the current PID to the lock file", () => {
    const lockPath = path.join(dir, "lock");
    const lock = new LeaderLock(lockPath);
    lock.tryAcquire();

    const written = fs.readFileSync(lockPath, "utf-8").trim();
    expect(written).toBe(String(process.pid));

    lock.release();
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
