import { describe, expect, it } from "vitest";
import {
  buildPendingSlackToolPolicyTurn,
  consumePendingSlackToolPolicyTurn,
  deliverTrackedSlackFollowUpMessage,
} from "./slack-turn-guardrails.js";

describe("Slack turn guardrail delivery ordering", () => {
  it("arms the pending Slack turn before delivery so synchronous input handlers can consume it", () => {
    const queue: ReturnType<typeof buildPendingSlackToolPolicyTurn>[] = [];
    let consumed: ReturnType<typeof buildPendingSlackToolPolicyTurn> | null = null;

    const delivered = deliverTrackedSlackFollowUpMessage({
      queue,
      prompt: "guarded slack prompt",
      messages: [{ threadTs: "100.1" }],
      deliver: (prompt) => {
        consumed = consumePendingSlackToolPolicyTurn(queue, prompt);
        return true;
      },
    });

    expect(delivered).toBe(true);
    expect(consumed).toEqual({
      prompt: "guarded slack prompt",
      threadTs: "100.1",
      threadCount: 1,
    });
    expect(queue).toEqual([]);
  });

  it("rolls back the pending Slack turn if follow-up delivery fails", () => {
    const queue: ReturnType<typeof buildPendingSlackToolPolicyTurn>[] = [];

    const delivered = deliverTrackedSlackFollowUpMessage({
      queue,
      prompt: "guarded slack prompt",
      messages: [{ threadTs: "100.1" }],
      deliver: () => false,
    });

    expect(delivered).toBe(false);
    expect(queue).toEqual([]);
  });

  it("tracks batched multi-thread Slack turns without inventing a confirmation thread", () => {
    const entry = buildPendingSlackToolPolicyTurn("batched", [
      { threadTs: "100.1" },
      { threadTs: "200.2" },
      { threadTs: "100.1" },
    ]);

    expect(entry).toEqual({
      prompt: "batched",
      threadTs: undefined,
      threadCount: 2,
    });
  });
});
