import { describe, expect, it } from "vitest";
import {
  buildCompactPinetReadDetails,
  formatPinetReadResultCompact,
  formatPinetReadResultFull,
  type PinetReadResult,
} from "./pinet-read-formatting.js";

function makeReadResult(body = "please inspect issue context"): PinetReadResult {
  return {
    messages: [
      {
        inboxId: 31,
        delivered: true,
        readAt: "2026-04-25T12:00:00.000Z",
        message: {
          id: 44,
          threadId: "a2a:broker:worker",
          source: "agent",
          direction: "inbound",
          sender: "broker",
          body,
          metadata: { a2a: true },
          createdAt: "2026-04-25T11:59:00.000Z",
        },
      },
    ],
    unreadCountBefore: 2,
    unreadCountAfter: 1,
    unreadThreads: [
      {
        threadId: "a2a:broker:worker",
        source: "agent",
        channel: "",
        unreadCount: 1,
        latestMessageId: 45,
        latestAt: "2026-04-25T12:01:00.000Z",
        highestMailClass: "steering",
        mailClassCounts: { steering: 1, fwup: 0, maintenance_context: 0 },
      },
    ],
    markedReadIds: [31],
  };
}

describe("Pinet read formatting", () => {
  it("keeps default read output compact", () => {
    expect(formatPinetReadResultCompact(makeReadResult(), { threadId: "a2a:broker:worker" })).toBe(
      "Pinet read: 1 unread message; unread 2→1; marked 1; 1 unread thread.",
    );
  });

  it("preserves the full read text for explicit verbose output", () => {
    const full = formatPinetReadResultFull(makeReadResult(), { threadId: "a2a:broker:worker" });

    expect(full).toContain("Pinet read (unread) from thread a2a:broker:worker: 1 message.");
    expect(full).toContain("broker: please inspect issue context");
    expect(full).toContain("pointer=pinet action=read args.thread_id=a2a:broker:worker");
    expect(full).toContain("Marked read: 31.");
  });

  it("returns compact details without dropping backward-compatible full bodies", () => {
    const body = `please inspect ${"important context ".repeat(20)}and keep exact body`;
    const compactDetails = buildCompactPinetReadDetails(makeReadResult(body)) as {
      messages: Array<{ preview: string }>;
    };

    expect(compactDetails.messages[0]?.preview).not.toBe(body);
    expect(compactDetails.messages[0]?.preview).toContain("please inspect important context");
  });
});
