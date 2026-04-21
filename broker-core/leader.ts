import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function defaultLockPath(): string {
  return path.join(os.homedir(), ".pi", "pinet-broker.lock");
}

/**
 * Leader election via PID lock file.
 *
 * Only one broker process should run at a time. The leader writes its
 * PID to the lock file. Stale locks (PID no longer running) are
 * automatically reclaimed.
 */
export class LeaderLock {
  private readonly lockPath: string;
  private acquired = false;

  constructor(lockPath?: string) {
    this.lockPath = lockPath ?? defaultLockPath();
  }

  /**
   * Try to acquire the lock. Returns true if this process is now the leader.
   */
  tryAcquire(): boolean {
    if (this.acquired) return true;

    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });

    // Check existing lock
    if (fs.existsSync(this.lockPath)) {
      const content = fs.readFileSync(this.lockPath, "utf-8").trim();
      const existingPid = parseInt(content, 10);

      if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
        // Another live process holds the lock
        return false;
      }

      // Stale lock — remove it
      fs.unlinkSync(this.lockPath);
    }

    // Write our PID atomically (write to temp, rename)
    const pid = process.pid;
    const tmpPath = `${this.lockPath}.${pid}.tmp`;
    fs.writeFileSync(tmpPath, String(pid), "utf-8");
    fs.renameSync(tmpPath, this.lockPath);

    // Verify we actually won (guard against race)
    const written = fs.readFileSync(this.lockPath, "utf-8").trim();
    if (written !== String(pid)) {
      return false;
    }

    this.acquired = true;
    return true;
  }

  /**
   * Release the lock if we hold it.
   */
  release(): void {
    if (!this.acquired) return;

    try {
      // Only remove if it's still our PID
      if (fs.existsSync(this.lockPath)) {
        const content = fs.readFileSync(this.lockPath, "utf-8").trim();
        if (content === String(process.pid)) {
          fs.unlinkSync(this.lockPath);
        }
      }
    } catch {
      // Best-effort cleanup
    }

    this.acquired = false;
  }

  /**
   * Check if this instance currently holds the lock.
   */
  isLeader(): boolean {
    return this.acquired;
  }

  /**
   * Get the lock file path (for testing).
   */
  getLockPath(): string {
    return this.lockPath;
  }
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
