import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildActivityLogBlocks,
  buildActivityLogText,
  formatRecentActivityLogEntries,
  normalizeActivityLogLevel,
  redactSensitiveText,
  shouldLogActivity,
  SlackActivityLogger,
} from "./activity-log.js";
import type { LoggedActivityLogEntry } from "./activity-log.js";
import type { SlackResult } from "./slack-api.js";

describe("normalizeActivityLogLevel", () => {
  it("defaults invalid values to actions", () => {
    expect(normalizeActivityLogLevel(undefined)).toBe("actions");
    expect(normalizeActivityLogLevel("wat")).toBe("actions");
  });

  it("accepts supported values", () => {
    expect(normalizeActivityLogLevel("errors")).toBe("errors");
    expect(normalizeActivityLogLevel("actions")).toBe("actions");
    expect(normalizeActivityLogLevel("verbose")).toBe("verbose");
  });
});

describe("shouldLogActivity", () => {
  it("filters by configured level", () => {
    expect(shouldLogActivity("errors", "errors")).toBe(true);
    expect(shouldLogActivity("errors", "actions")).toBe(false);
    expect(shouldLogActivity("actions", "errors")).toBe(true);
    expect(shouldLogActivity("actions", "verbose")).toBe(false);
    expect(shouldLogActivity("verbose", "verbose")).toBe(true);
  });
});

describe("redactSensitiveText", () => {
  it("redacts common token and secret patterns", () => {
    const input =
      "token=xoxb-secret-value Bearer abc123 password: hunter2 SLACK_BOT_TOKEN=xoxp-foo";
    const output = redactSensitiveText(input);
    expect(output).not.toContain("xoxb-secret-value");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("abc123");
    expect(output).toContain("[REDACTED]");
  });
});

describe("activity log rendering", () => {
  const entry: LoggedActivityLogEntry = {
    kind: "task_assignment",
    level: "actions",
    title: "Task assigned",
    summary: "Assigned #30 to Ultra Rabbit.",
    fields: [
      { label: "Issue", value: "#30" },
      { label: "Branch", value: "feat/activity-log-channel" },
    ],
    details: ["Created worktree .worktrees/feat-30"],
    tone: "info",
    timestamp: "2026-04-02T20:00:00.000Z",
  };

  it("builds fallback text", () => {
    const text = buildActivityLogText("Solar Mantis", "🦗", entry);
    expect(text).toContain("Task assigned");
    expect(text).toContain("Assigned #30 to Ultra Rabbit.");
    expect(text).toContain("🦗 Solar Mantis");
  });

  it("builds block kit payload", () => {
    const blocks = buildActivityLogBlocks("Solar Mantis", "🦗", entry);
    expect(blocks).toHaveLength(4);
    expect(JSON.stringify(blocks)).toContain("Task assigned");
    expect(JSON.stringify(blocks)).toContain("feat/activity-log-channel");
  });

  it("formats recent entries for TUI", () => {
    const text = formatRecentActivityLogEntries([entry]);
    expect(text).toContain("Task assigned");
    expect(text).toContain("Assigned #30 to Ultra Rabbit.");
  });
});

describe("SlackActivityLogger", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts entries into a daily thread and rate-limits sends", async () => {
    vi.useFakeTimers();

    const slack = vi.fn<
      (method: string, token: string, body?: Record<string, unknown>) => Promise<SlackResult>
    >(async (_method, _token, body) => {
      if (!body?.thread_ts) {
        return { ok: true, ts: "100.200" } as SlackResult;
      }
      return { ok: true, ts: `${body.thread_ts}.reply` } as SlackResult;
    });
    const resolveChannel = vi.fn(async () => "CLOGS");

    const logger = new SlackActivityLogger({
      getBotToken: () => "xoxb-test",
      getLogChannel: () => "#pinet-logs",
      getLogLevel: () => "actions",
      getAgentName: () => "Solar Mantis",
      getAgentEmoji: () => "🦗",
      resolveChannel,
      slack,
      now: () => new Date("2026-04-02T20:00:00.000Z"),
    });

    logger.log({
      kind: "task_assignment",
      level: "actions",
      title: "Task assigned",
      summary: "Assigned #30 to Ultra Rabbit.",
    });
    logger.log({
      kind: "task_progress",
      level: "actions",
      title: "PR opened",
      summary: "Issue #30 is now in review.",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(resolveChannel).toHaveBeenCalledTimes(1);
    expect(slack).toHaveBeenCalledTimes(2);
    expect(slack).toHaveBeenNthCalledWith(
      1,
      "chat.postMessage",
      "xoxb-test",
      expect.objectContaining({ channel: "CLOGS" }),
    );
    expect(slack).toHaveBeenNthCalledWith(
      2,
      "chat.postMessage",
      "xoxb-test",
      expect.objectContaining({ channel: "CLOGS", thread_ts: "100.200" }),
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(slack).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(slack).toHaveBeenCalledTimes(3);
    expect(slack).toHaveBeenNthCalledWith(
      3,
      "chat.postMessage",
      "xoxb-test",
      expect.objectContaining({ channel: "CLOGS", thread_ts: "100.200" }),
    );
  });

  it("filters entries below the configured level", async () => {
    vi.useFakeTimers();
    const slack = vi.fn(async () => ({ ok: true, ts: "100.200" }) as SlackResult);

    const logger = new SlackActivityLogger({
      getBotToken: () => "xoxb-test",
      getLogChannel: () => "CLOGS",
      getLogLevel: () => "errors",
      getAgentName: () => "Solar Mantis",
      getAgentEmoji: () => "🦗",
      resolveChannel: async (channel) => channel,
      slack,
      now: () => new Date("2026-04-02T20:00:00.000Z"),
    });

    logger.log({
      kind: "task_assignment",
      level: "actions",
      title: "Task assigned",
      summary: "Assigned #30 to Ultra Rabbit.",
    });
    logger.log({
      kind: "activity_error",
      level: "errors",
      title: "Log failure",
      summary: "Slack chat.postMessage failed.",
      tone: "error",
    });

    await vi.runAllTimersAsync();
    expect(slack).toHaveBeenCalledTimes(2);
    expect(logger.getRecentEntries()).toHaveLength(1);
    expect(logger.getRecentEntries()[0]?.title).toBe("Log failure");
  });
});
