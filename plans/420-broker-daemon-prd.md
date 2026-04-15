# PRD: daemonized Pinet control plane / broker

- Issue: #420
- Status: draft PRD
- Authors: Quantum Ebony Rhino
- Last updated: 2026-04-14

## Problem statement

Today the Pinet broker lives inside the `slack-bridge` pi extension process. That makes the broker easy to ship, but it ties infrastructure ownership to an operator-facing session lifecycle.

That coupling shows up in a few ways:

- broker uptime depends on a pi session staying alive
- Slack connectivity, routing, maintenance, and durability ownership are mixed with interactive session concerns
- restart behavior is harder to reason about because broker infrastructure and operator UX restart together
- observability is local to the session instead of belonging to a durable control-plane process
- the long-term Pinet model already wants the opposite: workers do tasks, broker runs infrastructure

We need a daemonized control plane that can own broker infrastructure as a long-lived local service while still using pi for reasoning and task orchestration.

## Goals

1. Run the Pinet broker as a durable local control-plane process with a lifecycle independent from operator sessions.
2. Preserve the current single-broker control-plane model and existing routing semantics.
3. Keep workers and follower clients connecting over a narrow local interface rather than embedding broker state themselves.
4. Support clean startup, restart, and recovery semantics for Slack connectivity, broker DB state, and worker routing.
5. Make the architecture observable and operable as infrastructure, not as an incidental extension side effect.
6. Explicitly decide whether the daemon should host pi through the **Pi SDK** or control a separate pi process over **RPC**.

## Non-goals

- implementing the daemon in this issue
- redesigning Slack UX, Home tabs, or control-plane canvas content
- changing routing policy, worker assignment strategy, or Ralph-loop product behavior
- redesigning broker DB schema beyond what migration to a daemon strictly requires
- introducing multi-machine federation
- replacing the current worker/follower socket protocol in the first migration slice

## Current state

Current architecture in `slack-bridge`:

- `slack-bridge/index.ts` still owns top-level runtime orchestration
- broker infrastructure is already being teased apart into seams like:
  - `broker-runtime.ts`
  - `follower-runtime.ts`
  - `single-player-runtime.ts`
  - `pinet-home-tabs.ts`
  - `pinet-agent-status.ts`
  - `pinet-skin.ts`
  - `pinet-maintenance-delivery.ts`
  - `pinet-remote-control-acks.ts`
- the broker still starts inside the extension and owns:
  - Slack adapter lifecycle
  - broker DB ownership
  - local worker/follower socket ownership
  - maintenance / Ralph loop execution
  - activity log and control-plane surfaces

This is a good refactor baseline, but it is still an in-session broker rather than a true daemonized control plane.

## Operator model and lifecycle expectations

### Operator model

The operator should think of the broker as a local service, not as a particular pi chat session.

Expected operator workflow:

- broker daemon is installed once per machine/workspace profile
- daemon starts automatically on login, boot, or explicit `pinet daemon start`
- operators inspect or control it via commands like:
  - `pinet daemon status`
  - `pinet daemon logs`
  - `pinet daemon restart`
  - `pinet daemon stop`
- pi sessions can come and go without taking the broker down
- workers connect to the daemon as clients of the control plane

### Lifecycle expectations

The daemon should:

- own the broker socket and broker DB for the machine/profile
- hold the Slack app/bot connectivity for broker-managed Slack ingress
- survive operator TUI closure and reopen
- recover on process restart without losing durable routing state
- fail loudly and observably when Slack auth, DB migration, or socket ownership fails
- prevent split-brain by ensuring only one active local broker daemon owns the control-plane lease

### Failure/restart expectations

On restart the daemon should:

- reacquire or validate exclusive broker ownership
- reopen the broker DB and recover durable inbox/backlog state
- restore Slack adapters and re-establish broker presence
- resume maintenance / Ralph loop timers
- allow workers/followers to reconnect without ambiguous control-plane ownership

## Process topology and ownership boundaries

## Recommended target topology

```text
+------------------------------+
| Operator surfaces            |
| - pi TUI sessions            |
| - CLI status/restart cmds    |
| - future dashboards          |
+--------------+---------------+
               |
               | local RPC / control API
               v
+------------------------------+
| Pinet daemon (single owner)  |
| - broker DB ownership        |
| - Slack adapter ownership    |
| - router / Ralph loop        |
| - activity + health signals  |
| - embedded pi broker session |
+--------------+---------------+
               |
               | existing/future local protocols
               v
+------------------------------+
| workers / followers          |
| - connect via daemon-owned   |
|   broker interfaces          |
+------------------------------+
```

### Ownership boundaries

**Daemon owns:**

- broker DB and schema migrations
- broker lease / singleton process ownership
- Slack ingress / adapter lifecycle
- router, maintenance, wakeups, health checks, and recovery
- broker reasoning session lifecycle
- activity, logs, and health endpoints/events

**Worker/follower clients own:**

- task execution in their own pi session/process
- reconnecting to the daemon after local or daemon restart
- local inbox drain and per-session UI state

**Operator surfaces own:**

- human control and inspection only
- no direct mutation of broker durability outside daemon APIs

## Pi SDK vs RPC comparison

We have two primary ways to daemonize the broker brain.

### Option A — Pi SDK inside the daemon

The daemon is a Node process that embeds pi programmatically via the SDK (`createAgentSession`, `createAgentSessionRuntime`, extension binding, event subscriptions).

### Option B — external pi process over RPC

The daemon is a supervisor/control-plane process that starts and talks to a separate pi process using pi's RPC mode.

## Comparison table

| Dimension | Pi SDK in daemon | External pi over RPC |
|---|---|---|
| Process model | Single long-lived daemon process hosts broker infra and pi session together | Two long-lived processes: daemon + pi child/service |
| Lifecycle control | Strong — one owner controls session creation, replacement, shutdown, subscriptions | Indirect — daemon must coordinate with external pi lifecycle and reconnect semantics |
| Extension reuse | Strong — broker can bind the same extensions/resources directly in-process | Medium — reuse depends on what RPC exposes and how extension-side events map across the boundary |
| Startup complexity | Lower for first implementation | Higher — requires bootstrapping and supervising a second process |
| Failure isolation | Lower — broker infra and broker reasoning can crash together | Higher — daemon and pi process can fail independently |
| Observability | Easier unified logs/events in one process | Better hard isolation, but split logs/metrics and cross-process correlation |
| Backpressure / event streaming | Direct function and event calls | Must be modeled over transport; more framing work |
| Resource usage | Lower process overhead | Higher process overhead |
| Upgrade / version skew | Simpler — single dependency graph | Harder — daemon and pi RPC contract can drift |
| Broker connectivity ownership | Clear — daemon owns Slack + broker session | Risk of ambiguous ownership if daemon and pi child split responsibilities poorly |
| Fit for long-lived control plane | Strong | Acceptable, but only if strict ownership and supervision are designed up front |
| Time-to-first-usable daemon | Faster | Slower |

## Explicit tradeoffs

### Pi SDK strengths

- keeps broker infra and broker reasoning under one lifecycle controller
- easiest way to reuse current extension and tool model
- simplest path to bind current broker-facing extensions/resources in a daemon context
- easiest to make the daemon the single owner of Slack, DB, routing, and the broker agent session
- reduces protocol surface for the first cut

### Pi SDK weaknesses

- reasoning faults and daemon faults share a process boundary
- a memory leak or crash in the broker session can affect control-plane infra directly
- less isolation for experiments in prompting/model behavior

### RPC strengths

- better process isolation between infra and reasoning engine
- could support language/runtime separation later
- clearer future path if the broker brain needs to be restarted independently from transport infra

### RPC weaknesses

- introduces a second lifecycle and a second supervision problem immediately
- requires a more explicit RPC contract for streaming, tool execution, queued prompts, session replacement, and extension/resource loading
- makes long-lived event correlation, observability, and recovery harder in the first implementation
- risks recreating the current coupling problem at a more complicated boundary if ownership is not extremely strict

## Recommended direction

**Recommendation: use the Pi SDK inside the daemon for the first daemonized control-plane implementation.**

More specifically:

1. Build a single **Pinet daemon** that owns broker infrastructure.
2. Host the broker reasoning session **in-process via the Pi SDK**.
3. Expose a **narrow local RPC/control API outward from the daemon** for operator commands and future clients.
4. Do **not** make the first daemon depend on a separate long-lived pi RPC child process.

This is an **SDK-first, daemon-owned architecture** — not a pure RPC broker brain.

### Why this direction wins now

- it preserves single ownership of the control plane
- it minimizes moving parts during the first daemon cut
- it reuses current extension and resource loading directly
- it gives us the fastest path from refactored in-extension broker seams to a true daemon
- it still leaves room to add an outward RPC surface later without re-embedding the broker again

### Long-term note

If we later need stronger fault isolation, we can split the broker brain behind an internal boundary. But that should be a second-step optimization after daemon ownership and lifecycle are already correct.

## Implications

### Broker connectivity

With a daemonized broker:

- Slack broker connectivity moves out of operator pi sessions and into the daemon
- Slack app/bot token validation and reconnect logic become daemon responsibilities
- Home tab, control-plane canvas, and broker-origin Slack surfaces should be published by the daemon-owned broker runtime
- worker sessions no longer need to be potential broker hosts

### Worker routing

- workers should always route through the daemon-owned broker
- routing decisions remain deterministic broker policy code
- daemon restart must preserve enough durable state that workers can reconnect and continue without thread ownership ambiguity
- local worker clients should not infer broker truth from session-local caches when the daemon is authoritative

### Startup / restart

- operator `pi` startup should not implicitly become broker startup
- the daemon should own automatic recovery and singleton enforcement
- worker startup can remain opportunistic, but broker startup should be explicit and durable
- restart semantics should separate:
  - daemon restart
  - broker reasoning session restart inside daemon
  - worker reconnect/reclaim behavior

### Durability

- broker DB becomes unambiguously daemon-owned
- message backlog, wakeups, assignments, and agent registrations survive operator session churn
- DB migration strategy must tolerate daemon version upgrades cleanly
- daemon startup should perform recovery before declaring itself healthy

### Observability

Daemon mode should add first-class observability:

- structured daemon logs
- health/status endpoint or CLI status command
- last successful Slack connect time
- active broker lease / PID metadata
- DB health and backlog counts
- worker connection counts
- maintenance loop status and last error
- broker reasoning session status separate from transport status

## Rollout and migration approach

### Phase 0 — PRD and seam validation

- finish the current refactor program that isolates broker-adjacent stateful seams
- validate that remaining `slack-bridge/index.ts` responsibilities map cleanly to daemon-owned modules

### Phase 1 — daemon scaffold

- add a standalone Pinet daemon entrypoint/package
- define process singleton/lease ownership
- load broker settings and DB without starting a pi TUI session
- stand up health/logging primitives

### Phase 2 — SDK-hosted broker session

- create a daemon-owned broker `AgentSessionRuntime` via Pi SDK
- bind the needed extensions/resources in-process
- move current broker startup path behind daemon ownership

### Phase 3 — attach current broker infra seams

- migrate broker runtime, maintenance, wakeups, Home tab publishing, activity logging, and routing ownership into daemon-owned modules
- keep worker/follower local protocols as compatible as possible initially

### Phase 4 — client cutover

- make `slack-bridge` broker mode a client of the daemon instead of a broker host
- keep single-player mode separate
- keep follower/worker reconnect semantics stable across the cutover

### Phase 5 — hardening

- improve observability
- add restart tooling
- add daemon status/restart UX
- evaluate whether any internal boundary needs stronger isolation later

## Risks

1. **Hidden extension/session assumptions**
   - current broker behavior may still assume a human-operated pi session context in subtle ways.

2. **Slack ownership migration risk**
   - moving Slack broker ownership to a daemon can expose edge cases in reconnect, token refresh, and Home tab publishing.

3. **DB migration / lease bugs**
   - singleton enforcement and recovery bugs could create split-brain or false-offline states.

4. **Observability gap during transition**
   - if logs and health signals are not added early, daemon failures may be harder to diagnose than current session-scoped failures.

5. **SDK embedding surprises**
   - long-lived embedded session behavior may expose assumptions that were previously masked by short-lived interactive sessions.

## Open questions

1. Should the first daemon be per-machine, per-workspace, or support both modes?
2. What is the exact daemon control surface: CLI only first, or CLI plus Unix-socket control API immediately?
3. Should Slack broker ingress move fully in phase 1, or after the daemon is proven with DB/router ownership first?
4. How should operator authentication/secrets be provisioned for a background daemon process?
5. What is the health contract for “daemon is healthy” vs “broker reasoning session is healthy”?
6. Should the daemon host one broker session only, or allow session replacement/restart without transport downtime?
7. Which parts of current `slack-bridge` settings should migrate into daemon config vs remain session-local?

## Decision

**Build a daemonized Pinet control plane as a dedicated local service that embeds the broker via the Pi SDK.**

Use a narrow daemon-owned outward RPC/control surface for operator commands and future clients, but do **not** make an external pi RPC process the first implementation architecture.

That gives us the clearest ownership model, the fastest migration path from the current refactored seams, and the strongest fit with Pinet's long-term principle that the broker is infrastructure while workers are computation.
