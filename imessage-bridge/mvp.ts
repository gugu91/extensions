import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";

export const APPLESCRIPT_BINARY_PATH = "/usr/bin/osascript";
export const DEFAULT_MESSAGES_DB_RELATIVE_PATH = path.join("Library", "Messages", "chat.db");

export type IMessageMvpEnvironmentBlocker =
  | "unsupported_platform"
  | "missing_osascript"
  | "missing_messages_db";

export interface IMessageMvpEnvironment {
  platform: NodeJS.Platform;
  homeDir: string;
  messagesDbPath: string;
  osascriptPath: string;
  osascriptAvailable: boolean;
  messagesDbAvailable: boolean;
  canAttemptSend: boolean;
  canAttemptHistoryRead: boolean;
  readyForLocalMvp: boolean;
  blockers: IMessageMvpEnvironmentBlocker[];
}

export interface DetectIMessageMvpEnvironmentOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathExists?: (candidatePath: string) => boolean;
}

export function getDefaultMessagesDbPath(homeDir = os.homedir()): string {
  return path.join(homeDir, DEFAULT_MESSAGES_DB_RELATIVE_PATH);
}

export function detectIMessageMvpEnvironment(
  options: DetectIMessageMvpEnvironmentOptions = {},
): IMessageMvpEnvironment {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const pathExists = options.pathExists ?? existsSync;
  const osascriptPath = APPLESCRIPT_BINARY_PATH;
  const messagesDbPath = getDefaultMessagesDbPath(homeDir);

  const supportedPlatform = platform === "darwin";
  const osascriptAvailable = supportedPlatform && pathExists(osascriptPath);
  const messagesDbAvailable = supportedPlatform && pathExists(messagesDbPath);

  const blockers: IMessageMvpEnvironmentBlocker[] = [];
  if (!supportedPlatform) {
    blockers.push("unsupported_platform");
  }
  if (supportedPlatform && !osascriptAvailable) {
    blockers.push("missing_osascript");
  }
  if (supportedPlatform && !messagesDbAvailable) {
    blockers.push("missing_messages_db");
  }

  const canAttemptSend = supportedPlatform && osascriptAvailable;
  const canAttemptHistoryRead = supportedPlatform && messagesDbAvailable;

  return {
    platform,
    homeDir,
    messagesDbPath,
    osascriptPath,
    osascriptAvailable,
    messagesDbAvailable,
    canAttemptSend,
    canAttemptHistoryRead,
    readyForLocalMvp: canAttemptSend && canAttemptHistoryRead,
    blockers,
  };
}

export function formatIMessageMvpReadiness(environment: IMessageMvpEnvironment): string[] {
  const lines = [
    `platform: ${environment.platform}`,
    `osascript: ${environment.osascriptAvailable ? "ready" : "missing"} (${environment.osascriptPath})`,
    `messages-db: ${environment.messagesDbAvailable ? "ready" : "missing"} (${environment.messagesDbPath})`,
  ];

  if (environment.readyForLocalMvp) {
    lines.push("mvp: local macOS iMessage send/history scaffold is ready");
    return lines;
  }

  if (environment.canAttemptSend && !environment.canAttemptHistoryRead) {
    lines.push("mvp: send-first ready; local history is unavailable");
    lines.push(`mvp blockers: ${environment.blockers.join(", ")}`);
    return lines;
  }

  if (environment.blockers.length === 0) {
    lines.push("mvp: not ready");
    return lines;
  }

  lines.push(`mvp blockers: ${environment.blockers.join(", ")}`);
  return lines;
}
