# @pinet/agent-goal

A standalone Pi extension that keeps one agent session working toward one durable, bounded goal. It does not require Pinet, the Pinet broker, RALPH, or Slack.

The extension independently evaluates each settled agent run. An unmet goal atomically requests another turn in the same session. Completed, blocked, budget-limited, paused, and cleared goals do not continue.

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
/goal              Inspect this session's goal
/goal pause        Pause automatic evaluation and continuation
/goal resume       Resume and immediately continue
/goal complete     Mark complete manually
/goal clear        Delete the goal
/goal hide         Hide the persistent goal dashboard
/goal show         Show the persistent goal dashboard
```

Pi's footer shows the status and budget usage. A compact widget below the editor shows the objective, turns, tokens, last evaluator decision, continuation state, and available commands. `/goal` remains a textual fallback in headless sessions.

Only one goal may exist per Pi session. Clear the existing goal before creating another.

## Budgets

Goals default to 25 settled iterations. Optional token and runtime limits are supported:

```text
PI_AGENT_GOAL_MAX_ITERATIONS=25
PI_AGENT_GOAL_MAX_TOKENS=200000
PI_AGENT_GOAL_MAX_RUNTIME_MS=14400000
```

Iteration and runtime limits are always reliable. Token accounting uses usage reported by Pi providers. The evaluator still reviews the final allowed turn so a completed goal is not incorrectly classified as budget-limited; only another continuation is prevented.

## Persistence and recovery

The default adapter stores goals and continuation claims in SQLite at:

```text
~/.pi/agent/agent-goals.sqlite
```

Set `PI_AGENT_GOAL_DB` to use another path. The stable Pi session ID is the storage scope, so resuming a session restores its goal. Optimistic goal versions reject stale mutations.

Every continuation first acquires a durable, idempotent per-session claim. Busy sessions persist a deferred claim, started claims remain until the next agent run begins, and expired claims are recovered safely on session resume. Evaluator and continuation failures use bounded exponential retries; exhausted retries block the goal with a diagnostic reason.

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
```

`GoalStorage` includes optimistic goal mutation plus durable continuation-claim operations. The package exports `GoalRuntime`, `MemoryGoalStorage`, `SqliteGoalStorage`, `PiGoalEvaluator`, dashboard formatters, lifecycle event types, and `registerAgentGoal`.

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

## Evaluation behavior

After `agent_settled`, the evaluator returns one of:

- `continue` with the next required work
- `complete` with completion evidence
- `blocked` with a specific unavailable external dependency

The evaluator receives bounded recent assistant and tool evidence. Its output is strictly parsed. Newer settled progress supersedes an older in-flight result. Invalid output and provider failures are retried within policy, then recorded as a blocked goal rather than allowing an unverified continuation.

Continuation prompts explicitly treat the objective as user-provided task data, never as higher-priority instructions.
