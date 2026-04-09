import { describe, expect, it } from "vitest";
import {
  evaluateSlackOriginCoreToolPolicy,
  summarizeCoreToolAction,
} from "./core-tool-guardrails.js";

describe("core tool Slack guardrails", () => {
  it("blocks Slack-triggered core tools covered by readOnly or blockedTools", () => {
    const turn = { threadTs: "100.1", threadCount: 1 };

    const bashBlocked = evaluateSlackOriginCoreToolPolicy({
      turn,
      toolName: "bash",
      input: { command: "touch nope" },
      guardrails: { blockedTools: ["bash"] },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(bashBlocked).toEqual({
      block: true,
      reason: 'Tool "bash" is blocked by Slack security guardrails.',
    });

    const editBlocked = evaluateSlackOriginCoreToolPolicy({
      turn,
      toolName: "edit",
      input: { path: "README.md", edits: [{ oldText: "a", newText: "b" }] },
      guardrails: { readOnly: true },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(editBlocked).toEqual({
      block: true,
      reason: 'Tool "edit" is blocked by Slack security guardrails.',
    });

    const writeBlocked = evaluateSlackOriginCoreToolPolicy({
      turn,
      toolName: "write",
      input: { path: "README.md", content: "hi" },
      guardrails: { readOnly: true },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });
    expect(writeBlocked).toEqual({
      block: true,
      reason: 'Tool "write" is blocked by Slack security guardrails.',
    });
  });

  it("requires confirmation for Slack-triggered core tools with a real Slack thread", () => {
    const result = evaluateSlackOriginCoreToolPolicy({
      turn: { threadTs: "100.1", threadCount: 1 },
      toolName: "bash",
      input: { command: "echo hello" },
      guardrails: { requireConfirmation: ["bash"] },
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
        'Tool "bash" requires confirmation for action "command=echo hello". Call slack_confirm_action in thread 100.1 first.',
    });
  });

  it("refuses confirmation-required core tools when a Slack batch spans multiple threads", () => {
    const result = evaluateSlackOriginCoreToolPolicy({
      turn: { threadTs: undefined, threadCount: 2 },
      toolName: "bash",
      input: { command: "echo hello" },
      guardrails: { requireConfirmation: ["bash"] },
      requireToolPolicy: () => {
        throw new Error("should not reach confirmation layer");
      },
      formatAction: (action) => JSON.stringify(action),
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(result).toEqual({
      block: true,
      reason:
        'Tool "bash" requires Slack confirmation for action "command=echo hello", but this Slack-triggered turn currently batches 2 threads. Process one Slack thread at a time before using that tool.',
    });
  });

  it("does not interfere with non-Slack turns or non-core tools", () => {
    expect(
      evaluateSlackOriginCoreToolPolicy({
        turn: null,
        toolName: "bash",
        input: { command: "pwd" },
        guardrails: { readOnly: true },
        requireToolPolicy: () => {
          throw new Error("should not run");
        },
        formatAction: (action) => JSON.stringify(action),
        formatError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    ).toBeUndefined();

    expect(
      evaluateSlackOriginCoreToolPolicy({
        turn: { threadTs: "100.1", threadCount: 1 },
        toolName: "slack_send",
        input: { thread_ts: "100.1", text: "hi" },
        guardrails: { blockedTools: ["slack_send"] },
        requireToolPolicy: () => {
          throw new Error("should not run");
        },
        formatAction: (action) => JSON.stringify(action),
        formatError: (error) => (error instanceof Error ? error.message : String(error)),
      }),
    ).toBeUndefined();
  });

  it("keeps core confirmation summaries compact and deterministic", () => {
    expect(
      summarizeCoreToolAction({
        toolName: "write",
        input: { path: "README.md", content: "hello" },
      }),
    ).toBe("path=README.md | content_length=5");
    expect(
      summarizeCoreToolAction({ toolName: "edit", input: { path: "README.md", edits: [{}, {}] } }),
    ).toBe("path=README.md | edits=2");
  });
});
