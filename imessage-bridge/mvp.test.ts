import { describe, expect, it } from "vitest";
import {
  APPLESCRIPT_BINARY_PATH,
  detectIMessageMvpEnvironment,
  formatIMessageMvpReadiness,
  getDefaultMessagesDbPath,
} from "./mvp.ts";

describe("getDefaultMessagesDbPath", () => {
  it("builds the canonical macOS Messages database path", () => {
    expect(getDefaultMessagesDbPath("/Users/goose")).toBe("/Users/goose/Library/Messages/chat.db");
  });
});

describe("detectIMessageMvpEnvironment", () => {
  it("reports a ready darwin host when osascript and chat.db are present", () => {
    const environment = detectIMessageMvpEnvironment({
      platform: "darwin",
      homeDir: "/Users/goose",
      pathExists: (candidatePath) =>
        candidatePath === APPLESCRIPT_BINARY_PATH ||
        candidatePath === "/Users/goose/Library/Messages/chat.db",
    });

    expect(environment.blockers).toEqual([]);
    expect(environment.canAttemptSend).toBe(true);
    expect(environment.canAttemptHistoryRead).toBe(true);
    expect(environment.readyForLocalMvp).toBe(true);
  });

  it("flags missing chat.db separately from send capability", () => {
    const environment = detectIMessageMvpEnvironment({
      platform: "darwin",
      homeDir: "/Users/goose",
      pathExists: (candidatePath) => candidatePath === APPLESCRIPT_BINARY_PATH,
    });

    expect(environment.blockers).toEqual(["missing_messages_db"]);
    expect(environment.canAttemptSend).toBe(true);
    expect(environment.canAttemptHistoryRead).toBe(false);
    expect(environment.readyForLocalMvp).toBe(false);
  });

  it("treats non-darwin hosts as unsupported regardless of file presence", () => {
    const environment = detectIMessageMvpEnvironment({
      platform: "linux",
      homeDir: "/home/goose",
      pathExists: () => true,
    });

    expect(environment.blockers).toEqual(["unsupported_platform"]);
    expect(environment.canAttemptSend).toBe(false);
    expect(environment.canAttemptHistoryRead).toBe(false);
    expect(environment.readyForLocalMvp).toBe(false);
  });
});

describe("formatIMessageMvpReadiness", () => {
  it("calls out send-first readiness when only local history is unavailable", () => {
    const lines = formatIMessageMvpReadiness(
      detectIMessageMvpEnvironment({
        platform: "darwin",
        homeDir: "/Users/goose",
        pathExists: (candidatePath) => candidatePath === APPLESCRIPT_BINARY_PATH,
      }),
    );

    expect(lines).toContain("mvp: send-first ready; local history is unavailable");
    expect(lines).toContain("mvp blockers: missing_messages_db");
  });

  it("includes blockers in the human-readable summary", () => {
    const lines = formatIMessageMvpReadiness(
      detectIMessageMvpEnvironment({
        platform: "darwin",
        homeDir: "/Users/goose",
        pathExists: () => false,
      }),
    );

    expect(lines).toContain(`osascript: missing (${APPLESCRIPT_BINARY_PATH})`);
    expect(lines).toContain("mvp blockers: missing_osascript, missing_messages_db");
  });
});
