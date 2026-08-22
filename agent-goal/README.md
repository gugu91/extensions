# @pinet/agent-goal

A standalone Pi extension that keeps one agent session working toward one durable, bounded goal. It does not require Pinet, the Pinet broker, RALPH, or Slack.

The worker runs normally and stops when its current pass is finished. Ordinary settled runs continue automatically without spending a second model call. Independent evaluation runs only when the worker requests `complete` or `blocked`, at an optional periodic checkpoint, or on the final budget turn. Completed, blocked, budget-limited, paused, and cleared goals do not continue.

## Install

```bash
pi install npm:@pinet/agent-goal
```

For local development:

```bash
pi -e ./agent-goal/index.ts
```

## Commands and UI

```text
/goal <objective>  Create and immediately start a goal
/goal              Open the minimal goal window (text in headless modes)
/goal pause        Pause automatic evaluation and continuation
/goal resume       Resume and immediately continue
/goal complete     Mark complete manually
/goal clear        Delete the goal
/goal hide         Hide the persistent goal dashboard
/goal show         Show the persistent goal dashboard
```

Pi's footer shows the status and budget usage. A compact widget below the editor shows passive progress. In interactive mode, `/goal` opens a centered, keyboard-dismissable window with the objective, lifecycle state, budget bars, latest evaluator guidance, and continuation state. Press Escape, Enter, `q`, or Ctrl+C to close it. `/goal` remains a textual fallback in headless sessions.

Only one goal may exist per Pi session. Clear the existing goal before creating another.

The agent also receives three model-visible tools:

- `create_goal` — create its own bounded, user-aligned durable goal
- `get_goal` — inspect the current objective, status, and budget
- `update_goal` — submit `complete` or `blocked` as a candidate for independent verification

An agent-created goal cannot replace an existing goal. Its first automatic continuation starts after the creating run settles, so work performed before goal creation is not incorrectly charged to the goal budget.

## Budgets

Goals default to 25 settled iterations. Optional token and runtime limits are supported:

```text
PI_AGENT_GOAL_MAX_ITERATIONS=25
PI_AGENT_GOAL_MAX_TOKENS=200000
PI_AGENT_GOAL_MAX_RUNTIME_MS=14400000
PI_AGENT_GOAL_EVALUATION_INTERVAL=0
```

Iteration and runtime limits are always reliable. Token accounting uses usage reported by Pi providers. `PI_AGENT_GOAL_EVALUATION_INTERVAL` defaults to `0`, which disables periodic checkpoints; set it to a positive number to evaluate every N settled runs. The evaluator always reviews the final allowed turn so a completed goal is not incorrectly classified as budget-limited; only another continuation is prevented.

## Persistence and recovery

The default adapter stores goals and continuation claims in SQLite at:

```text
~/.pi/agent/agent-goals.sqlite
```

Set `PI_AGENT_GOAL_DB` to use another path. The stable Pi session ID is the storage scope, so resuming a session restores its goal. Optimistic goal versions reject stale mutations.

Every continuation first acquires a durable, idempotent per-session claim. Busy sessions persist a deferred claim and schedule an in-process wake for their retry time. Started claims schedule an expiry wake, remain until the next agent run begins, and recover safely after interruption or session resume. Evaluator and continuation failures use bounded exponential retries; exhausted retries block the goal with a diagnostic reason.

Settlements that arrive during an in-flight evaluation are atomically aggregated in storage. Every settled iteration and token delta is charged, while the evaluator receives the newest bounded progress and any preserved terminal candidate.

## Architecture

The domain and runtime depend on ports rather than Pi, Pinet, or SQLite:

```ts
interface GoalEvaluator {
  evaluate(goal: AgentGoal, progress: GoalProgress): Promise<GoalEvaluation>;
}

interface GoalContinuation {
  continueIfIdle(
    goal: AgentGoal,
    request: GoalContinuationRequest,
  ): Promise<GoalContinuationResult>;
}

interface GoalEventSink {
  record(event: GoalEvent): Promise<void> | void;
}

interface GoalWakeScheduler {
  schedule(scopeId: string, wakeAt: string, wake: () => void): void;
  cancel(scopeId: string): void;
  close(): void;
}
```

`GoalStorage` includes optimistic goal mutation, atomic pending-settlement aggregation, and durable continuation-claim operations. `TimerGoalWakeScheduler` is the default process-local wake adapter and can be replaced through `GoalRuntimeOptions`. The package exports `GoalRuntime`, both storage adapters, the wake adapter, `PiGoalEvaluator`, dashboard formatters, lifecycle event types, and `registerAgentGoal`.

```ts
import { registerAgentGoal } from "@pinet/agent-goal";

registerAgentGoal(pi, {
  storage: myStorage,
  evaluator: myEvaluator,
  continuation: myAtomicContinuationAdapter,
  eventSink: myEventSink,
  defaultBudget: { maxIterations: 20, maxTokens: 150_000 },
});
```

The continuation adapter owns the final idle check and idempotent enqueue. Pi's current API does not expose Codex's exact `start_turn_if_idle` primitive, so the default adapter performs the closest safe operation: it rechecks session identity, idle state, and pending messages immediately before submitting a follow-up. A future Pi or Pinet adapter can provide a truly atomic implementation without changing `GoalRuntime`.

A future Pinet integration can use broker storage and evaluation plus RALPH recovery through these ports, without introducing multi-agent decomposition.

## Worker-directed evaluation

The extension registers model-visible `create_goal`, `get_goal`, and `update_goal` tools. The worker can establish its own user-aligned goal, inspect it, and call `update_goal` with `complete` only after verifying the full objective or with `blocked` for a genuine external impasse. `update_goal` records a terminal candidate rather than mutating goal state directly. When the run reaches `agent_settled`, the independent evaluator verifies that candidate. If the worker stops without calling `update_goal`, the runtime accounts the run and continues the same session without an evaluator call.

Evaluation is also forced at configured periodic checkpoints and on the final budget turn. The evaluator returns one of:

- `continue` with the next required work
- `complete` with completion evidence
- `blocked` with a specific unavailable external dependency

The standalone in-process evaluator receives bounded recent assistant and tool evidence plus any terminal candidate. Its output is strictly parsed. Newer settled progress supersedes an older in-flight result. Invalid output and provider failures are retried within policy, then recorded as a blocked goal rather than allowing an unverified terminal decision.

The standalone evaluator intentionally remains a zero-process, zero-runtime-dependency baseline. A future Pinet broker adapter can replace storage, evaluation, continuation, and events to add authoritative evidence inspection, atomic wake scheduling, and watchdog recovery. Subagent evaluators remain optional adapters; tmux and spawned Pi processes are not required.

Continuation prompts explicitly treat the objective as user-provided task data, never as higher-priority instructions.
