# @pinet/agent-goal

A standalone Pi extension that keeps one agent session working toward one durable goal. It does not require Pinet, the Pinet broker, RALPH, or Slack.

The extension evaluates the latest settled turn with the session's current model. An unmet goal starts another turn in the same session. Completed, blocked, paused, and cleared goals do not continue.

## Install

```bash
pi install npm:@pinet/agent-goal
```

For local development:

```bash
pi -e ./agent-goal/index.ts
```

## Commands

```text
/goal <objective>  Create and immediately start a goal
/goal              Inspect this session's goal
/goal pause        Pause automatic evaluation and continuation
/goal resume       Resume and immediately continue
/goal complete     Mark complete manually
/goal clear        Delete the goal
```

Only one goal may exist per Pi session. Clear the existing goal before creating another.

## Persistence

The default adapter stores goals in SQLite at:

```text
~/.pi/agent/agent-goals.sqlite
```

Set `PI_AGENT_GOAL_DB` to use another path. The stable Pi session ID is the storage scope, so resuming a session restores its goal. The database uses optimistic goal versions to reject stale evaluator updates.

## Architecture

The domain and runtime depend on ports rather than Pi, Pinet, or SQLite:

```ts
interface GoalStorage {
  get(scopeId: string): Promise<AgentGoal | undefined>;
  create(goal: AgentGoal): Promise<void>;
  replace(goal: AgentGoal, expectedVersion: number): Promise<boolean>;
  delete(scopeId: string, expectedVersion: number): Promise<boolean>;
  close(): void;
}

interface GoalEvaluator {
  evaluate(goal: AgentGoal, progress: GoalProgress): Promise<GoalEvaluation>;
}

interface GoalContinuation {
  continue(goal: AgentGoal, reason: string): Promise<"started" | "busy" | "unavailable">;
}
```

The package exports `GoalRuntime`, `MemoryGoalStorage`, `SqliteGoalStorage`, `PiGoalEvaluator`, and `registerAgentGoal`. Other installations can inject their own adapters:

```ts
import { registerAgentGoal } from "@pinet/agent-goal";

registerAgentGoal(pi, {
  storage: myStorage,
  evaluator: myEvaluator,
  continuation: myContinuation,
});
```

A future Pinet integration can therefore use the broker as evaluator and RALPH as the continuation/watchdog without changing the standalone runtime.

## Evaluation behavior

After `agent_settled`, the evaluator returns one of:

- `continue` with the next required work
- `complete` with completion evidence
- `blocked` with a specific unavailable external dependency

Evaluator failures leave the goal active and do not start an unverified continuation. Concurrent evaluations are deduplicated, and results are discarded if the goal changes while evaluation is running.
