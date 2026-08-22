import { describe, expect, it } from "vitest";
import { parseGoalEvaluation } from "./pi-evaluator.js";

describe("parseGoalEvaluation", () => {
  it.each([
    ["CONTINUE: tests remain", { outcome: "continue", reason: "tests remain" }],
    [
      "COMPLETE: tests and review passed",
      { outcome: "complete", reason: "tests and review passed" },
    ],
    [
      "BLOCKED: maintainer approval required",
      { outcome: "blocked", reason: "maintainer approval required" },
    ],
  ] as const)("parses %s", (response, expected) => {
    expect(parseGoalEvaluation(response)).toEqual(expected);
  });

  it("rejects malformed evaluator output", () => {
    expect(() => parseGoalEvaluation("probably done")).toThrow("invalid response");
    expect(() => parseGoalEvaluation("COMPLETE:")).toThrow("invalid response");
  });
});
