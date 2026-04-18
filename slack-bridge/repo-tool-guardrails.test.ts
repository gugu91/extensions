import { describe, expect, it } from "vitest";
import {
  evaluateSlackOriginRepoToolPolicy,
  summarizeRepoToolAction,
} from "./repo-tool-guardrails.js";

describe("repo tool Slack guardrails", () => {
  it("blocks Slack-triggered repo tools covered by readOnly or blockedTools", () => {
    const turn = { threadTs: "100.1", threadCount: 1 };

    const commentAddBlocked = evaluateSlackOriginRepoToolPolicy({
      turn,
      toolName: "comment_add",
      input: { comment: "hi" },
      guardrails: { readOnly: true },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(commentAddBlocked).toEqual({
      block: true,
      reason: 'Tool "comment_add" is blocked by Slack security guardrails.',
    });

    const psqlBlocked = evaluateSlackOriginRepoToolPolicy({
      turn,
      toolName: "psql",
      input: { query: "select 1" },
      guardrails: { blockedTools: ["psql"] },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(psqlBlocked).toEqual({
      block: true,
      reason: 'Tool "psql" is blocked by Slack security guardrails.',
    });
  });

  it("requires confirmation for Slack-triggered repo tools with a real Slack thread", () => {
    const result = evaluateSlackOriginRepoToolPolicy({
      turn: { threadTs: "100.1", threadCount: 1 },
      toolName: "psql",
      input: { query: "select *\nfrom users", format: "csv" },
      guardrails: { requireConfirmation: ["psql"] },
      requireToolPolicy: (toolName, threadTs, action) => {
        throw new Error(
          `Tool "${toolName}" requires confirmation for action ${JSON.stringify(action)}. Call slack_confirm_action in thread ${threadTs} first.`,
        );
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(result).toEqual({
      block: true,
      reason:
        'Tool "psql" requires confirmation for action "format=csv | query=select * from users". Call slack_confirm_action in thread 100.1 first.',
    });
  });

  it("refuses confirmation-required repo tools when a Slack batch spans multiple threads", () => {
    const result = evaluateSlackOriginRepoToolPolicy({
      turn: { threadTs: undefined, threadCount: 2 },
      toolName: "open_in_editor",
      input: { file: "README.md", line: 7 },
      guardrails: { requireConfirmation: ["open_in_editor"] },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(result).toEqual({
      block: true,
      reason:
        'Tool "open_in_editor" requires Slack confirmation for action "file=README.md | line=7", but this Slack-triggered turn currently batches 2 threads. Process one Slack thread at a time before using that tool.',
    });
  });

  it("does not interfere with non-Slack turns or tools outside the five-tool slice", () => {
    expect(
      evaluateSlackOriginRepoToolPolicy({
        turn: null,
        toolName: "psql",
        input: { query: "select 1" },
        guardrails: { blockedTools: ["psql"] },
        requireToolPolicy: () => {
          throw new Error("should not run");
        },
        formatAction: (action) => JSON.stringify(action),
        formatError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    ).toBeUndefined();

    expect(
      evaluateSlackOriginRepoToolPolicy({
        turn: { threadTs: "100.1", threadCount: 1 },
        toolName: "slack_send",
        input: { text: "hi" },
        guardrails: { blockedTools: ["slack_send"] },
        requireToolPolicy: () => {
          throw new Error("should not run");
        },
        formatAction: (action) => JSON.stringify(action),
        formatError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    ).toBeUndefined();
  });

  it("keeps repo-tool confirmation summaries compact and deterministic", () => {
    expect(
      summarizeRepoToolAction({
        toolName: "comment_add",
        input: {
          thread_id: "global",
          file: "notes.md",
          start_line: 3,
          end_line: 4,
          comment: "hello",
        },
      }),
    ).toBe("thread_id=global | file=notes.md | start_line=3 | end_line=4 | comment_length=5");
    expect(
      summarizeRepoToolAction({
        toolName: "comment_wipe_all",
        input: {},
      }),
    ).toBe("scope=current_repo");
  });
});
