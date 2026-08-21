import { describe, expect, it } from "vitest";
import { formatGoalProgress, type GoalProgressMessage } from "./progress.js";

describe("formatGoalProgress", () => {
  it("includes conversational and tool evidence", () => {
    expect(
      formatGoalProgress([
        { role: "assistant", content: [{ type: "text", text: "Running tests." }] },
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "13 tests passed" }],
        },
        { role: "assistant", content: [{ type: "text", text: "The goal is complete." }] },
      ]),
    ).toBe(
      "[assistant]\nRunning tests.\n\n[toolResult:bash]\n13 tests passed\n\n[assistant]\nThe goal is complete.",
    );
  });

  it("bounds evaluator context to recent messages and characters", () => {
    const messages: GoalProgressMessage[] = Array.from({ length: 45 }, (_, index) => ({
      role: "toolResult",
      content: `message-${index}-${"x".repeat(2_000)}`,
    }));

    const progress = formatGoalProgress(messages);

    expect(progress.length).toBe(40_000);
    expect(progress).not.toContain("message-0-");
    expect(progress).toContain("message-44-");
  });
});
