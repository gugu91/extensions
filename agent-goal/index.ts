import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalContinuation, GoalEvaluator, GoalStorage } from "./domain.js";
import { PiGoalEvaluator } from "./pi-evaluator.js";
import { formatGoalProgress, type GoalProgressMessage } from "./progress.js";
import { GoalRuntime } from "./runtime.js";
import { SqliteGoalStorage } from "./sqlite-storage.js";

export type {
  AgentGoal,
  GoalContinuation,
  GoalContinuationResult,
  GoalEvaluation,
  GoalEvaluator,
  GoalProgress,
  GoalStatus,
  GoalStorage,
} from "./domain.js";
export { MemoryGoalStorage } from "./memory-storage.js";
export { parseGoalEvaluation, PiGoalEvaluator } from "./pi-evaluator.js";
export { formatGoalProgress, type GoalProgressMessage } from "./progress.js";
export { GoalRuntime } from "./runtime.js";
export { SqliteGoalStorage } from "./sqlite-storage.js";

export interface AgentGoalExtensionOptions {
  storage?: GoalStorage;
  evaluator?: GoalEvaluator;
  continuation?: GoalContinuation;
  databasePath?: string;
}

interface CompatibleContext extends ExtensionContext {
  sessionManager: ExtensionContext["sessionManager"] & { getSessionId(): string };
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}

interface CompatibleAPI extends ExtensionAPI {
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { deliverAs?: "followUp"; triggerTurn?: boolean },
  ): void;
}

interface AgentEndEvent {
  messages: GoalProgressMessage[];
}

const STATUS_KEY = "agent-goal";

export function registerAgentGoal(pi: ExtensionAPI, options: AgentGoalExtensionOptions = {}): void {
  const api = pi as CompatibleAPI;
  let activeContext: CompatibleContext | undefined;
  let latestProgress = "";
  let evaluationTimer: ReturnType<typeof setTimeout> | undefined;
  const storage =
    options.storage ??
    new SqliteGoalStorage(
      options.databasePath ??
        process.env.PI_AGENT_GOAL_DB ??
        join(homedir(), ".pi", "agent", "agent-goals.sqlite"),
    );
  const evaluator = options.evaluator ?? new PiGoalEvaluator(() => activeContext);
  const continuation: GoalContinuation =
    options.continuation ??
    ({
      async continue(goal, reason) {
        api.sendMessage(
          {
            customType: "agent-goal.continuation",
            content: [
              "Continue working autonomously toward the active goal below.",
              "Preserve its full scope, inspect the current repository/session state, and validate the result before claiming completion.",
              `Goal: ${goal.objective}`,
              `Evaluator guidance: ${reason}`,
            ].join("\n\n"),
            display: true,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return "started";
      },
    } satisfies GoalContinuation);
  const runtime = new GoalRuntime(storage, evaluator, continuation);

  const refreshStatus = async (ctx: CompatibleContext): Promise<void> => {
    const goal = await runtime.get(ctx.sessionManager.getSessionId());
    ctx.ui.setStatus(STATUS_KEY, goal ? `goal: ${goal.status}` : undefined);
  };

  pi.on("session_start", async (_event, rawCtx) => {
    const ctx = rawCtx as CompatibleContext;
    activeContext = ctx;
    latestProgress = "";
    await refreshStatus(ctx);
    const goal = await runtime.get(ctx.sessionManager.getSessionId());
    if (goal?.status === "active") {
      await runtime.start(goal.scopeId, "Resume the persisted active goal from current state.");
    }
  });

  pi.on("agent_end", (rawEvent, rawCtx) => {
    const event = rawEvent as AgentEndEvent;
    const ctx = rawCtx as CompatibleContext;
    activeContext = ctx;
    latestProgress = formatGoalProgress(event.messages);
    if (evaluationTimer) clearTimeout(evaluationTimer);
    evaluationTimer = setTimeout(() => {
      evaluationTimer = undefined;
      if (activeContext !== ctx || !ctx.isIdle() || ctx.hasPendingMessages()) return;
      runtime
        .settle(ctx.sessionManager.getSessionId(), { latestOutput: latestProgress })
        .then(() => refreshStatus(ctx))
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[agent-goal] evaluation failed: ${message}`);
          if (ctx.hasUI) ctx.ui.notify(`Goal evaluation failed: ${message}`, "error");
        });
    }, 0);
  });

  pi.on("session_shutdown", () => {
    if (evaluationTimer) clearTimeout(evaluationTimer);
    evaluationTimer = undefined;
    activeContext = undefined;
    if (!options.storage) storage.close();
  });

  pi.registerCommand("goal", {
    description: "Create, inspect, pause, resume, complete, or clear this session's goal",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as CompatibleContext;
      activeContext = ctx;
      const scopeId = ctx.sessionManager.getSessionId();
      const input = args.trim();

      try {
        if (!input) {
          const goal = await runtime.get(scopeId);
          api.sendMessage(
            {
              customType: "agent-goal.status",
              content: goal
                ? `Goal (${goal.status}, v${goal.version}): ${goal.objective}${goal.blockedReason ? `\nBlocked: ${goal.blockedReason}` : ""}`
                : "This session has no goal.",
              display: true,
            },
            { triggerTurn: false },
          );
          return;
        }

        switch (input.toLowerCase()) {
          case "pause":
            await runtime.setStatus(scopeId, "paused");
            break;
          case "resume":
            await runtime.setStatus(scopeId, "active");
            await runtime.start(scopeId, "Resume the goal from current state.");
            break;
          case "complete":
            await runtime.setStatus(scopeId, "complete");
            break;
          case "clear":
            if (!(await runtime.clear(scopeId))) throw new Error("This session has no goal");
            break;
          default:
            await runtime.create(scopeId, input);
            await runtime.start(scopeId);
            break;
        }
        await refreshStatus(ctx);
        if (ctx.hasUI) ctx.ui.notify(`Goal command applied: ${input}`, "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(`[agent-goal] ${message}`);
      }
    },
  });
}

export default function agentGoal(pi: ExtensionAPI): void {
  registerAgentGoal(pi);
}
