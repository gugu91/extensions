/**
 * Centralized Pinet broker file paths.
 * All socket and database path constants are defined here to ensure consistency
 * across the broker, client, and schema modules.
 */

import * as os from "node:os";
import * as path from "node:path";

// ─── Directories ─────────────────────────────────────────

/** Default Pinet config directory: ~/.pi */
export function getPinetConfigDir(): string {
  return path.join(os.homedir(), ".pi");
}

// ─── Socket Paths ────────────────────────────────────────

/** Default Unix socket path for broker communication: ~/.pi/pinet.sock */
export function getDefaultSocketPath(): string {
  return path.join(getPinetConfigDir(), "pinet.sock");
}

// Re-export as static constant for backward compatibility
export const DEFAULT_SOCKET_PATH = getDefaultSocketPath();

// ─── Database Paths ──────────────────────────────────────

/** Default SQLite database path for broker: ~/.pi/pinet-broker.db */
export function getDefaultDbPath(): string {
  return path.join(getPinetConfigDir(), "pinet-broker.db");
}

// ─── Mesh auth paths ─────────────────────────────────────

/** Shared secret file used to authenticate local Pinet mesh clients: ~/.pi/pinet.secret */
export function getDefaultMeshSecretPath(): string {
  return path.join(getPinetConfigDir(), "pinet.secret");
}
