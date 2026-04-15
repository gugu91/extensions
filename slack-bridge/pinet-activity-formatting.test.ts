import { describe, expect, it } from "vitest";
import {
  createPinetActivityFormatting,
  type PinetActivityFormattingAgentRecord,
  type PinetActivityFormattingBrokerDbPort,
  type PinetActivityFormattingDeps,
} from "./pinet-activity-formatting.js";

function createDeps(overrides: Partial<PinetActivityFormattingDeps> = {}) {
  const agents = new Map<string, PinetActivityFormattingAgentRecord>([
    ["worker-1", { emoji: "🦩", name: "Cobalt Olive Crane" }],
    ["worker-2", { emoji: "", name: "Quiet Otter" }],
  ]);

  const db: PinetActivityFormattingBrokerDbPort = {
    getAgentById: (agentId) => agents.get(agentId) ?? null,
  };

  const deps: PinetActivityFormattingDeps = {
    getActiveBrokerDb: () => db,
    ...overrides,
  };

  return { deps };
}

describe("createPinetActivityFormatting", () => {
  it("formats tracked agents from the active broker db and falls back to the id", () => {
    const { deps } = createDeps();
    const pinetActivityFormatting = createPinetActivityFormatting(deps);

    expect(pinetActivityFormatting.formatTrackedAgent("worker-1")).toBe("🦩 Cobalt Olive Crane");
    expect(pinetActivityFormatting.formatTrackedAgent("worker-2")).toBe("Quiet Otter");
    expect(pinetActivityFormatting.formatTrackedAgent("missing-worker")).toBe("missing-worker");
  });

  it("falls back to the id when no broker db is active", () => {
    const { deps } = createDeps({
      getActiveBrokerDb: () => null,
    });
    const pinetActivityFormatting = createPinetActivityFormatting(deps);

    expect(pinetActivityFormatting.formatTrackedAgent("worker-1")).toBe("worker-1");
  });

  it("summarizes PR lifecycle statuses", () => {
    const { deps } = createDeps();
    const pinetActivityFormatting = createPinetActivityFormatting(deps);

    expect(pinetActivityFormatting.summarizeTrackedAssignmentStatus("pr_open", 423, null)).toEqual({
      summary: "PR #423 opened for review",
      tone: "success",
    });
    expect(
      pinetActivityFormatting.summarizeTrackedAssignmentStatus("pr_merged", 423, null),
    ).toEqual({
      summary: "PR #423 merged",
      tone: "success",
    });
    expect(
      pinetActivityFormatting.summarizeTrackedAssignmentStatus("pr_closed", 423, null),
    ).toEqual({
      summary: "PR #423 closed without merge",
      tone: "warning",
    });
  });

  it("summarizes branch pushes with a branch or fallback label", () => {
    const { deps } = createDeps();
    const pinetActivityFormatting = createPinetActivityFormatting(deps);

    expect(
      pinetActivityFormatting.summarizeTrackedAssignmentStatus(
        "branch_pushed",
        null,
        "feat/narrow-seam",
      ),
    ).toEqual({
      summary: "commits pushed on feat/narrow-seam",
      tone: "info",
    });
    expect(
      pinetActivityFormatting.summarizeTrackedAssignmentStatus("branch_pushed", null, null),
    ).toEqual({
      summary: "commits pushed on tracked branch",
      tone: "info",
    });
  });

  it("defaults assigned activity to an info summary", () => {
    const { deps } = createDeps();
    const pinetActivityFormatting = createPinetActivityFormatting(deps);

    expect(
      pinetActivityFormatting.summarizeTrackedAssignmentStatus("assigned", 123, "branch"),
    ).toEqual({
      summary: "assigned",
      tone: "info",
    });
  });
});
