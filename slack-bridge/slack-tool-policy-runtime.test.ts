import { describe, expect, it, vi } from "vitest";
import {
  createSlackToolPolicyRuntime,
  type SlackToolPolicyRuntimeDeps,
} from "./slack-tool-policy-runtime.js";

function createDeps(overrides: Partial<SlackToolPolicyRuntimeDeps> = {}) {
  const deliverFollowUpMessage = vi.fn(() => true);
  const requireToolPolicy = vi.fn();

  const deps: SlackToolPolicyRuntimeDeps = {
    getBrokerRole: () => null,
    getGuardrails: () => ({}),
    requireToolPolicy,
    formatAction: (action) => `<${action}>`,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    deliverFollowUpMessage,
    ...overrides,
  };

  return {
    deps,
    deliverFollowUpMessage,
    requireToolPolicy,
  };
}

describe("createSlackToolPolicyRuntime", () => {
  it("tracks a delivered Slack follow-up turn across input and turn lifecycle", async () => {
    const { deps, deliverFollowUpMessage, requireToolPolicy } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
    });
    const runtime = createSlackToolPolicyRuntime(deps);

    expect(
      runtime.deliverTrackedSlackFollowUpMessage({
        prompt: "guarded slack prompt",
        messages: [{ threadTs: "100.1" }],
      }),
    ).toBe(true);
    expect(deliverFollowUpMessage).toHaveBeenCalledWith("guarded slack prompt");

    await runtime.onInput({ source: "extension", text: "guarded slack prompt" });
    await runtime.onTurnStart();

    await expect(
      runtime.onToolCall({
        toolName: "read",
        input: { path: "plans/440.md" },
      }),
    ).resolves.toBeUndefined();
    expect(requireToolPolicy).toHaveBeenCalledWith(
      "read",
      "100.1",
      "path=plans/440.md | offset= | limit=",
    );

    await runtime.onTurnEnd();
    await expect(
      runtime.onToolCall({
        toolName: "read",
        input: { path: "plans/440.md" },
      }),
    ).resolves.toBeUndefined();
    expect(requireToolPolicy).toHaveBeenCalledTimes(1);
  });

  it("ignores non-extension input and rolls back undelivered turns", async () => {
    const { deps, requireToolPolicy } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
      deliverFollowUpMessage: vi.fn(() => false),
    });
    const runtime = createSlackToolPolicyRuntime(deps);

    expect(
      runtime.deliverTrackedSlackFollowUpMessage({
        prompt: "guarded slack prompt",
        messages: [{ threadTs: "100.1" }],
      }),
    ).toBe(false);

    await runtime.onInput({ source: "user", text: "guarded slack prompt" });
    await runtime.onInput({ source: "extension", text: "guarded slack prompt" });
    await runtime.onTurnStart();

    await expect(
      runtime.onToolCall({
        toolName: "read",
        input: { path: "plans/440.md" },
      }),
    ).resolves.toBeUndefined();
    expect(requireToolPolicy).not.toHaveBeenCalled();
  });

  it("blocks guarded core tools for batched multi-thread Slack turns without a confirmation thread", async () => {
    const { deps, requireToolPolicy } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
    });
    const runtime = createSlackToolPolicyRuntime(deps);

    runtime.deliverTrackedSlackFollowUpMessage({
      prompt: "batched prompt",
      messages: [{ threadTs: "100.1" }, { threadTs: "200.2" }, { threadTs: "100.1" }],
    });
    await runtime.onInput({ source: "extension", text: "batched prompt" });
    await runtime.onTurnStart();

    await expect(
      runtime.onToolCall({
        toolName: "read",
        input: { path: "plans/440.md" },
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        'Tool "read" requires Slack confirmation for action <path=plans/440.md | offset= | limit=>, but this Slack-triggered turn currently batches 2 threads. Process one Slack thread at a time before using that tool.',
    });
    expect(requireToolPolicy).not.toHaveBeenCalled();
  });

  it("clears the active Slack tool-policy turn on agent_end", async () => {
    const { deps, requireToolPolicy } = createDeps({
      getGuardrails: () => ({ requireConfirmation: ["read"] }),
    });
    const runtime = createSlackToolPolicyRuntime(deps);

    runtime.deliverTrackedSlackFollowUpMessage({
      prompt: "guarded slack prompt",
      messages: [{ threadTs: "100.1" }],
    });
    await runtime.onInput({ source: "extension", text: "guarded slack prompt" });
    await runtime.onTurnStart();
    await runtime.onAgentEnd();

    await expect(
      runtime.onToolCall({
        toolName: "read",
        input: { path: "plans/440.md" },
      }),
    ).resolves.toBeUndefined();
    expect(requireToolPolicy).not.toHaveBeenCalled();
  });

  it("hard-blocks forbidden broker tools before Slack-origin policy checks", async () => {
    const { deps, requireToolPolicy } = createDeps({
      getBrokerRole: () => "broker",
      getGuardrails: () => ({ requireConfirmation: ["edit"] }),
    });
    const runtime = createSlackToolPolicyRuntime(deps);

    await expect(
      runtime.onToolCall({
        toolName: "edit",
        input: { path: "slack-bridge/index.ts", edits: [] },
      }),
    ).resolves.toEqual({
      block: true,
      reason:
        'Tool "edit" is forbidden for the broker role. The broker coordinates — it does not code. Use pinet_message to delegate to a connected worker instead.',
    });
    expect(requireToolPolicy).not.toHaveBeenCalled();
  });
});
