import { describe, expect, it } from "vitest";
import {
  applyTrackedAssignmentIdleReplyStalls,
  buildTrackedAssignmentReplyNudgeMessage,
  createRalphLoopState,
  hydrateRalphLoopReportedGhosts,
} from "./ralph-loop.js";
import { rewriteRalphLoopGhostAnomalies } from "./helpers.js";

function buildEvaluation(ghostAgentIds: string[]) {
  return {
    ghostAgentIds,
    nudgeAgentIds: [],
    idleDrainAgentIds: [],
    stuckAgentIds: [],
    anomalies:
      ghostAgentIds.length > 0 ? [`ghost agents detected: ${ghostAgentIds.join(", ")}`] : [],
  };
}

describe("hydrateRalphLoopReportedGhosts", () => {
  it("hydrates the latest persisted ghost ids into a fresh state", () => {
    const state = createRalphLoopState();

    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["ghost-1", "ghost-2"] }]);

    expect([...state.reportedGhosts]).toEqual(["ghost-1", "ghost-2"]);
    expect(state.ghostBaselineHydrated).toBe(true);
  });

  it("does not overwrite active in-memory ghost state", () => {
    const state = createRalphLoopState();
    state.reportedGhosts.add("live-ghost");

    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["persisted-ghost"] }]);

    expect([...state.reportedGhosts]).toEqual(["live-ghost"]);
    expect(state.ghostBaselineHydrated).toBe(true);
  });

  it("suppresses re-announcing the same persisted ghost ids as NEW after a state reset", () => {
    const state = createRalphLoopState();
    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: ["ghost-1"] }]);

    const rewritten = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"]),
      state.reportedGhosts,
    );

    expect(rewritten.evaluation.ghostAgentIds).toEqual(["ghost-1"]);
    expect(rewritten.evaluation.anomalies).toEqual([]);
    expect(rewritten.newGhostIds).toEqual([]);
    expect(rewritten.nextReportedGhostIds).toEqual(["ghost-1"]);
  });

  it("still announces truly new ghost ids when the latest persisted cycle was healthy", () => {
    const state = createRalphLoopState();
    hydrateRalphLoopReportedGhosts(state, [{ ghostAgentIds: [] }]);

    const rewritten = rewriteRalphLoopGhostAnomalies(
      buildEvaluation(["ghost-1"]),
      state.reportedGhosts,
    );

    expect(rewritten.evaluation.anomalies).toEqual(["NEW ghost agents detected: ghost-1"]);
    expect(rewritten.newGhostIds).toEqual(["ghost-1"]);
    expect(rewritten.nextReportedGhostIds).toEqual(["ghost-1"]);
  });
});

describe("applyTrackedAssignmentIdleReplyStalls", () => {
  it("flags and nudges idle assignees that never replied after a tracked assignment", () => {
    const evaluation = {
      ghostAgentIds: [],
      nudgeAgentIds: [],
      idleDrainAgentIds: [],
      stuckAgentIds: [],
      anomalies: [],
    };

    const pending = applyTrackedAssignmentIdleReplyStalls(
      evaluation,
      [
        { id: "worker-1", name: "Quiet Otter", status: "idle" },
        { id: "worker-2", name: "Busy Crane", status: "working" },
      ],
      [
        {
          id: 1,
          agentId: "worker-1",
          issueNumber: 114,
          status: "assigned",
          sourceMessageId: 10,
          originalSenderAgentId: "broker",
        },
        {
          id: 2,
          agentId: "worker-1",
          issueNumber: 463,
          status: "assigned",
          sourceMessageId: 11,
          originalSenderAgentId: "broker",
        },
        {
          id: 3,
          agentId: "worker-2",
          issueNumber: 999,
          status: "assigned",
          sourceMessageId: 12,
          originalSenderAgentId: "broker",
        },
      ],
    );

    expect(pending).toEqual(new Map([["worker-1", [114, 463]]]));
    expect(evaluation.nudgeAgentIds).toEqual(["worker-1"]);
    expect(evaluation.anomalies).toEqual([
      "Quiet Otter idle after tracked assignments #114, #463 without any agent reply to the original sender",
    ]);
  });
});

describe("buildTrackedAssignmentReplyNudgeMessage", () => {
  it("asks the assignee to report outcome or blocker for the tracked issues", () => {
    expect(buildTrackedAssignmentReplyNudgeMessage([114, 463], "2026-04-20T10:00:00.000Z")).toBe(
      "RALPH LOOP nudge (2026-04-20T10:00:00.000Z): you are idle after tracked assignments #114, #463 and still have not sent any agent reply to the original sender. Please report outcome or blocker now.",
    );
  });
});
