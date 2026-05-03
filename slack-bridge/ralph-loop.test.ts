import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  applyTrackedAssignmentIdleReplyStalls,
  buildTrackedAssignmentReplyNudgeMessage,
  createRalphLoopState,
  hydrateRalphLoopReportedGhosts,
  startRalphLoop,
  stopRalphLoop,
  type RalphLoopDeps,
} from "./ralph-loop.js";
import { DEFAULT_RALPH_LOOP_INTERVAL_MS, rewriteRalphLoopGhostAnomalies } from "./helpers.js";

function createLoopDeps(overrides: Partial<RalphLoopDeps> = {}): RalphLoopDeps {
  return {
    getBrokerDb: () => null,
    getBrokerAgentId: () => null,
    heartbeatTimerActive: () => true,
    maintenanceTimerActive: () => true,
    runMaintenance: vi.fn(),
    sendMaintenanceMessage: vi.fn(),
    trySendFollowUp: vi.fn(),
    logActivity: vi.fn(),
    formatTrackedAgent: vi.fn((agentId: string) => agentId),
    summarizeTrackedAssignmentStatus: vi.fn(() => ({ summary: "assigned", tone: "info" })),
    refreshHomeTabs: vi.fn(async () => undefined),
    getLastMaintenance: vi.fn(() => null),
    buildControlPlaneDashboardSnapshot: vi.fn((input) => input as never),
    setLastHomeTabSnapshot: vi.fn(),
    getLastHomeTabError: vi.fn(() => null),
    setLastHomeTabError: vi.fn(),
    ...overrides,
  };
}

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

describe("startRalphLoop", () => {
  it("uses the configured RALPH loop interval for the broker timer", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, {
        ...createLoopDeps(),
        getSettings: () => ({ ralphLoopIntervalMs: 123_000 }),
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 123_000);
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });

  it("uses the five-minute default when no interval is configured", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, createLoopDeps());

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_RALPH_LOOP_INTERVAL_MS,
      );
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });

  it("falls back before scheduling oversized intervals that Node would overflow", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const state = createRalphLoopState();

    try {
      startRalphLoop({} as ExtensionContext, state, {
        ...createLoopDeps(),
        getSettings: () => ({ ralphLoopIntervalMs: 3_000_000_000 }),
      });

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        DEFAULT_RALPH_LOOP_INTERVAL_MS,
      );
    } finally {
      stopRalphLoop(state);
      setIntervalSpy.mockRestore();
    }
  });
});

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
  it("flags and nudges healthy idle assignees that never replied after a tracked assignment", () => {
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
        {
          id: "worker-1",
          name: "Quiet Otter",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:15.000Z",
        },
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
      { now: Date.parse("2026-04-20T10:00:20.000Z") },
    );

    expect(pending).toEqual(new Map([["worker-1", [114, 463]]]));
    expect(evaluation.nudgeAgentIds).toEqual(["worker-1"]);
    expect(evaluation.anomalies).toEqual([
      "Quiet Otter idle after tracked assignments #114, #463 without any agent reply to the original sender",
    ]);
  });

  it("ignores idle tracked assignees that are disconnected, resumable, or stale", () => {
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
        {
          id: "healthy-worker",
          name: "Careful Moth",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:15.000Z",
        },
        {
          id: "ghost-worker",
          name: "Ghost Goose",
          status: "idle",
          disconnectedAt: "2026-04-20T10:00:19.000Z",
        },
        {
          id: "resumable-worker",
          name: "Resumable Raven",
          status: "idle",
          disconnectedAt: "2026-04-20T10:00:19.000Z",
          resumableUntil: "2026-04-20T10:01:00.000Z",
        },
        {
          id: "stale-worker",
          name: "Stale Stoat",
          status: "idle",
          lastHeartbeat: "2026-04-20T10:00:09.000Z",
        },
      ],
      [
        {
          id: 1,
          agentId: "healthy-worker",
          issueNumber: 463,
          status: "assigned",
          sourceMessageId: 10,
          originalSenderAgentId: "broker",
        },
        {
          id: 2,
          agentId: "ghost-worker",
          issueNumber: 464,
          status: "assigned",
          sourceMessageId: 11,
          originalSenderAgentId: "broker",
        },
        {
          id: 3,
          agentId: "resumable-worker",
          issueNumber: 465,
          status: "assigned",
          sourceMessageId: 12,
          originalSenderAgentId: "broker",
        },
        {
          id: 4,
          agentId: "stale-worker",
          issueNumber: 466,
          status: "assigned",
          sourceMessageId: 13,
          originalSenderAgentId: "broker",
        },
      ],
      { now: Date.parse("2026-04-20T10:00:20.000Z") },
    );

    expect(pending).toEqual(new Map([["healthy-worker", [463]]]));
    expect(evaluation.nudgeAgentIds).toEqual(["healthy-worker"]);
    expect(evaluation.anomalies).toEqual([
      "Careful Moth idle after tracked assignment #463 without any agent reply to the original sender",
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
