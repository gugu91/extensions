import { describe, expect, it } from "vitest";
import { createRalphLoopState, hydrateRalphLoopReportedGhosts } from "./ralph-loop.js";
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
