import { describe, expect, it, vi } from "vitest";
import { createIMessageAdapter } from "./adapter.ts";
import {
  APPLESCRIPT_BINARY_PATH,
  buildIMessageSendAppleScript,
  getDefaultIMessageThreadId,
  resolveIMessageBody,
  sendIMessage,
} from "./index.ts";

describe("iMessage send helpers", () => {
  it("builds a stable default thread id from the recipient", () => {
    expect(getDefaultIMessageThreadId("Alice@Example.com")).toBe("imessage:alice@example.com");
  });

  it("builds the AppleScript lines for an argv-driven send", () => {
    expect(buildIMessageSendAppleScript()).toEqual([
      "on run argv",
      "set recipientHandle to item 1 of argv",
      "set messageBody to item 2 of argv",
      'tell application "Messages"',
      "set targetService to 1st service whose service type = iMessage",
      "set targetBuddy to buddy recipientHandle of targetService",
      "send messageBody to targetBuddy",
      "end tell",
      "end run",
    ]);
  });

  it("prefers plain text when markdown is also present for outbound iMessage rendering", () => {
    expect(resolveIMessageBody({ text: "hello from pi", markdown: "**hello** from pi" })).toBe(
      "hello from pi",
    );
  });

  it("falls back to markdown only when the plain text body is missing", () => {
    expect(resolveIMessageBody({ text: "   ", markdown: "**hello** from pi" })).toBe(
      "**hello** from pi",
    );
  });

  it("runs osascript with argv-based recipient and canonical plain-text body values", async () => {
    const runAppleScript = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await sendIMessage({
      recipient: "chat:alice",
      text: "hello from pi",
      markdown: "**hello** from pi",
      runAppleScript,
    });

    expect(runAppleScript).toHaveBeenCalledWith({
      osascriptPath: APPLESCRIPT_BINARY_PATH,
      scriptLines: buildIMessageSendAppleScript(),
      args: ["chat:alice", "hello from pi"],
    });
  });
});

describe("AppleScriptIMessageAdapter", () => {
  it("permits send-first mode when AppleScript is available but chat.db is missing", async () => {
    const runAppleScript = vi.fn(async () => ({ stdout: "sent", stderr: "" }));
    const adapter = createIMessageAdapter({
      runAppleScript,
      detectEnvironment: () => ({
        platform: "darwin",
        homeDir: "/Users/goose",
        messagesDbPath: "/Users/goose/Library/Messages/chat.db",
        osascriptPath: APPLESCRIPT_BINARY_PATH,
        osascriptAvailable: true,
        messagesDbAvailable: false,
        canAttemptSend: true,
        canAttemptHistoryRead: false,
        readyForLocalMvp: false,
        blockers: ["missing_messages_db"],
      }),
    });

    await adapter.connect();
    await adapter.send({ threadId: "imessage:alice", channel: "chat:alice", text: "hi" });

    expect(runAppleScript).toHaveBeenCalledTimes(1);
  });

  it("fails connect when the host cannot attempt iMessage sends", async () => {
    const adapter = createIMessageAdapter({
      detectEnvironment: () => ({
        platform: "linux",
        homeDir: "/home/goose",
        messagesDbPath: "/home/goose/Library/Messages/chat.db",
        osascriptPath: APPLESCRIPT_BINARY_PATH,
        osascriptAvailable: false,
        messagesDbAvailable: false,
        canAttemptSend: false,
        canAttemptHistoryRead: false,
        readyForLocalMvp: false,
        blockers: ["unsupported_platform"],
      }),
    });

    await expect(adapter.connect()).rejects.toThrow("iMessage send-first adapter is not ready");
  });

  it("treats onInbound as a no-op for the send-first adapter", async () => {
    const runAppleScript = vi.fn(async () => ({ stdout: "sent", stderr: "" }));
    const handler = vi.fn();
    const adapter = createIMessageAdapter({
      runAppleScript,
      detectEnvironment: () => ({
        platform: "darwin",
        homeDir: "/Users/goose",
        messagesDbPath: "/Users/goose/Library/Messages/chat.db",
        osascriptPath: APPLESCRIPT_BINARY_PATH,
        osascriptAvailable: true,
        messagesDbAvailable: false,
        canAttemptSend: true,
        canAttemptHistoryRead: false,
        readyForLocalMvp: false,
        blockers: ["missing_messages_db"],
      }),
    });

    adapter.onInbound(handler);
    await adapter.connect();
    await adapter.send({ threadId: "imessage:alice", channel: "chat:alice", text: "hi" });
    await adapter.disconnect();

    expect(runAppleScript).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });
});
