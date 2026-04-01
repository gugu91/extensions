# architecture-rfc

Status: Draft
Date: 2026-04-01
Related issues: #35, #36, #38, #64, #68, #71, #72

## Summary

This RFC proposes a unified **broker-centered control plane** for the extensions repo.

Near term, the control plane remains the existing broker as a **pi extension**. It is not yet a standalone daemon. The broker grows into the single durable coordination layer for:

- agent lifecycle and routing,
- Slack ingress/egress,
- cross-agent messaging,
- PiComms protocol access,
- and orchestration across workers.

The core recommendation is:

1. **Unify PiComms and Broker at the control-plane boundary.**
   - They should share one protocol surface and one architectural model.
   - They should remain separate domain modules.
   - They do **not** need to collapse into one physical DB in the near term.

2. **Extend the current broker socket into the authoritative durable protocol.**
   - Comments, routing, lifecycle, and coordination should converge behind one broker-owned API.
   - A second session-local Neovim socket may survive only for editor-context injection.

3. **Make `message.send` the primitive.**
   - Slack, Neovim, and agent-to-agent communication become adapters over one canonical message flow.

4. **Define workspace identity and protocol authz early.**
   - Workspace identity is a prerequisite before Phase 3.
   - Capability/authz is a prerequisite within Phase 2.

5. **Move from PID cleanup to stable identities + leased instances + heartbeats.**
   - This is the key fix for ghost agents (#72).

6. **Keep the broker as a hybrid system: deterministic router + LLM broker agent + Ralph loop.**
   - The core `MessageRouter` stays deterministic.
   - The broker agent keeps its LLM for smart routing, self-healing, and orchestration.

7. **Defer daemonization.**
   - A future daemon may still make sense.
   - It is not a near-term prerequisite for phases 1-5.

## Why this RFC now

The repo already has two real systems growing toward the same problem space:

- **PiComms** in `nvim-bridge/comments-sqlite.ts` and `nvim-bridge/index.ts`
- **Broker/Pinet** in `slack-bridge/broker/schema.ts` and `slack-bridge/broker/socket-server.ts`

Both already use SQLite.
Both already expose socket protocols.
Both already manage thread-like state.
Both already want live updates across processes.

If they continue evolving independently, the repo will accumulate:

- two stores,
- two protocol surfaces,
- two ownership models,
- and two different answers to lifecycle and reconnect behavior.

That is manageable for point features, but it is the wrong foundation for multi-agent coordination, delegation, smart routing, and future daemonization.

## Current state

### PiComms today

PiComms currently:

- stores comments in repo-local SQLite at `.pi/picomms.db` via `nvim-bridge/comments-sqlite.ts`,
- falls back to legacy JSON files under `.pi/a2a/comments` via `nvim-bridge/comments.ts`,
- exposes comment RPCs from `nvim-bridge/index.ts` over a repo+branch-scoped Unix socket,
- broadcasts push updates directly to connected Neovim clients.

This is a good local comments system, but it is not yet a general coordination layer.

### Broker today

Broker currently:

- stores agents, threads, messages, and inbox state in `~/.pi/pinet-broker.db` via `slack-bridge/broker/schema.ts`,
- exposes JSON-RPC over `~/.pi/pinet.sock` via `slack-bridge/broker/socket-server.ts`,
- routes inbound Slack messages through `slack-bridge/broker/router.ts`,
- supports follower agents via polling with `inbox.poll` and `inbox.ack`.

This is a good start for routing, but it is still separate from PiComms and still ties too much behavior to current process ownership.

### Current architectural friction

| Concern         | PiComms                         | Broker                                | Problem                       |
| --------------- | ------------------------------- | ------------------------------------- | ----------------------------- |
| Store ownership | `nvim-bridge` process           | broker process                        | split brain                   |
| DB path         | repo-local `.pi/picomms.db`     | global `~/.pi/pinet-broker.db`        | no shared model               |
| Socket API      | newline JSON, custom RPC + push | JSON-RPC                              | duplicated transport concepts |
| Thread identity | `global` / `ctx:*`              | Slack `thread_ts` / `a2a:*`           | overloaded IDs                |
| Lifecycle       | none beyond process lifetime    | register/unregister + PID cleanup     | no robust lease/resume model  |
| Delivery        | direct socket broadcast         | inbox queue                           | incompatible event model      |
| Slack send path | not involved                    | partly direct, partly broker-mediated | inconsistent ownership        |

## Goals

- Create one coherent architecture for comments, message routing, and agent coordination.
- Fix ghost agents and stale thread ownership (#72).
- Keep Slack, Neovim, and agent-to-agent flows on the same foundation.
- Preserve existing tool surfaces while simplifying the internals.
- Keep the hot path deterministic and testable.
- Add LLM-driven orchestration without making core routing non-deterministic.
- Support future daemonization cleanly without making it a near-term requirement.

## Non-goals

- This RFC does not implement the broker evolution.
- This RFC does not require an immediate standalone daemon.
- This RFC does not require an immediate cutover to one gateway-owned DB.
- This RFC does not redesign the Slack or Neovim UX.
- This RFC does not define issues/PRs as first-class PiComms entities yet.
- This RFC does not require a public generic `send_message` tool immediately; it defines the internal primitive first.

## Proposal

## 1. Unify PiComms and Broker behind one broker-owned control plane

Near term, the existing broker extension becomes the single durable coordination layer.

### Decision

**PiComms and Broker should share one logical control plane and one protocol surface, while keeping separate physical stores in the near term.**

That means:

- the broker becomes the durable coordination API,
- PiComms moves behind broker-visible abstractions,
- lifecycle/routing and comments follow one architectural model,
- but the current physical stores can remain distinct until later migration work is justified.

### Near-term source of truth

Until the future daemon phase:

- **Comments:** workspace-local `.pi/picomms.db`
- **Runtime coordination:** global `~/.pi/pinet-broker.db`

The broker protocol is the unifying layer above those stores.

### Why this is the right abstraction

This gives us the benefits we need now:

- one coordination model,
- one lifecycle model,
- one message model,
- one place to enforce authz/capabilities,
- and one place to compose deterministic routing with LLM orchestration.

It also avoids forcing the riskiest migration too early:

- PiComms has repo-local portability semantics,
- broker runtime state is global and session-oriented,
- and a full physical-store cutover is easier to do later than to undo early.

### Longer-term note

A future daemon phase may still converge the physical stores or attach them under one runtime owner. That is explicitly deferred until after lifecycle, Ralph loop, protocol unification, PiComms migration, and delegation are proven.

### Rejected alternative

**Keep PiComms and Broker as completely separate systems and glue them together ad hoc.**

Rejected because it preserves the hardest problems:

- duplicated ownership rules,
- duplicated protocol semantics,
- no shared lifecycle model,
- and fragile cross-process coordination.

## 2. Workspace identity

Workspace identity is no longer an open question. It is a prerequisite before Phase 3.

### Decision

Define two identifiers:

- **`workspace_id`** — stable identity for one working copy / worktree
- **`repo_lineage_id`** — stable lineage identity for related clones / worktrees of the same repo

### Definition

#### `workspace_id`

`workspace_id` is a stable UUID stored in the workspace at:

- `.pi/workspace-id`

Rules:

- created on first broker/PiComms registration if missing
- survives repo moves because it lives with the workspace
- survives branch switching because it is workspace-scoped, not branch-scoped
- clones get a **new** `workspace_id` by default
- separate worktrees get **distinct** `workspace_id`s by default

This keeps today’s local PiComms semantics intuitive: one checkout/worktree is one workspace.

#### `repo_lineage_id`

`repo_lineage_id` is a non-primary lineage key used for discovery, import/export, and optional future cross-worktree tooling.

Recommended derivation:

- normalized primary remote URL when available
- otherwise a stable local fallback fingerprint recorded when the workspace is first registered

Rules:

- clones of the same remote usually share `repo_lineage_id`
- sibling worktrees usually share `repo_lineage_id`
- repo moves do not change `repo_lineage_id`

### Operational rules

- **Repo move:** same `workspace_id`, same `repo_lineage_id`
- **Clone:** new `workspace_id`, usually same `repo_lineage_id`
- **Worktree:** new `workspace_id`, same `repo_lineage_id`
- **Branch switch:** same `workspace_id`, same `repo_lineage_id`

### Protocol requirement

Starting in Phase 3, every broker client registration must include:

- `workspace_id`
- `repo_lineage_id`
- current `cwd`
- branch metadata

This is what lets lifecycle, comments, and routing agree on tenancy before PiComms migrates behind the broker.

## 3. One authoritative durable socket server

### Decision

Use the **current broker socket** as the authoritative durable coordination API in phases 2-5.

That means:

- comments,
- routing,
- agent coordination,
- lifecycle,
- subscriptions,
- and delivery queues

should converge behind the broker-owned socket surface.

### Protocol

Extend the current JSON-RPC broker protocol with namespaced method families such as:

- `agent.register`
- `agent.resume`
- `agent.heartbeat`
- `agent.unregister`
- `agent.list`
- `conversation.claim`
- `conversation.release`
- `conversation.list`
- `message.send`
- `message.poll`
- `message.ack`
- `comment.add`
- `comment.list`
- `comment.list_all`
- `subscribe.open`
- `subscribe.close`
- `broker.status`
- `maintenance.run`

Notifications can cover:

- `message.delivered`
- `comment.added`
- `conversation.updated`
- `agent.expired`
- `maintenance.ralph_tick`

### One server or two?

The recommendation is:

- **one authoritative durable server** for coordination and stateful RPC
- **optionally one thin session-local Neovim bridge** for editor-context injection only

That means a second socket is acceptable only if it is:

- ephemeral,
- session-scoped,
- and not a second source of truth.

## Capability / authz model

Capability/authz is a required part of Phase 2. It is not deferred hardening.

### Client classes

| Client class    | Examples                      | Allowed RPC families                                                                            | Not allowed                                       |
| --------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `broker-core`   | leader broker extension       | all broker/admin/maintenance/adapter methods                                                    | n/a                                               |
| `worker-agent`  | follower pi session           | `agent.*`, `message.poll`, `message.ack`, `message.send`, `conversation.claim`, delegation APIs | admin, migration, unrestricted adapter ingress    |
| `nvim-ui`       | `nvim-bridge` durable client  | `comment.*`, `subscribe.*`, read-only conversation views scoped to its workspace                | worker lifecycle, maintenance, Slack proxy, admin |
| `slack-adapter` | Slack ingress/egress layer    | inbound ingest, outbound delivery, thread claim helpers                                         | generic worker/admin methods                      |
| `tool-shim`     | current tools via extension   | only the narrow broker RPCs required by each tool                                               | arbitrary protocol access                         |
| `admin-local`   | future CLI / recovery tooling | `broker.status`, migration/admin/maintenance operations                                         | worker task APIs unless explicitly granted        |

### Auth mechanism

Near term, auth is local-first:

1. **Unix socket ownership** limits access to the local OS user
2. **role declaration** happens at registration/open time
3. **server-side capability map** binds allowed RPC families to that connection
4. **workspace scoping** is enforced server-side using `workspace_id`
5. **leader-only methods** are reserved for the broker leader

The key rule is simple: no client gets authority just because it can open the socket.

## 4. `message.send` becomes the primitive

### Decision

Define one canonical internal send primitive:

- `message.send(...)`

Public tools may remain adapter-specific for now:

- `slack_send`
- `comment_add`
- `pinet_message`

But internally they should route through the same application service model.

### Canonical message envelope

At the domain layer, a message should look more like this:

- `conversation_id`
- `workspace_id` (optional when global)
- `kind`: `user_message | agent_message | comment | control`
- `source_adapter`: `slack | nvim | agent | system`
- `sender`
- `target`
- `body`
- `context` (optional file/range, repo, metadata)
- `created_at`
- `metadata`

### Ports and adapters

Core services should not know Slack or Neovim-specific types.

Suggested ports:

- `InboundPort.receiveMessage`
- `OutboundPort.deliverMessage`
- `CommentPort.addComment`
- `AgentRegistryPort.register/heartbeat/unregister`
- `ConversationPort.claim/release/delegate`

Suggested adapters:

- **Slack adapter**
  - maps Socket Mode events to canonical inbound messages
  - maps outbound messages to Slack Web API calls
- **Neovim adapter**
  - maps PiComms panel actions to comment/message calls
  - subscribes to comment updates
- **Agent client adapter**
  - maps worker agents to register/poll/ack/send flows
- **Tool shims**
  - current tools remain thin wrappers over broker RPC

### Practical effect

This removes duplicated logic such as:

- direct Slack API sends from one code path,
- broker-mediated sends from another,
- and comment writes that happen outside the control plane.

## 5. Agent lifecycle: identities, instances, leases

This is the most important operational change in the RFC.

### Current weakness

Broker currently relies on a mix of:

- agent rows keyed by transient IDs,
- socket close events,
- `touchAgent()` on inbox poll,
- and PID cleanup.

That is not enough for reconnect, orchestration, or ghost-agent prevention.

### Decision

Split agent lifecycle into three concepts:

#### Agent identity

A stable logical identity.
Examples:

- one named worker in one workspace
- one broker identity
- one reviewer worker

This survives reconnects.

#### Agent instance

A live process/session bound to one socket connection.
This is what heartbeats.
This is what dies.

#### Lease

A time-bounded liveness claim.
When the lease expires, the instance is considered gone even if cleanup hooks never fired.

### Recommended fields

For agent instances:

- `instance_id`
- `identity_id`
- `workspace_id`
- `connected_at`
- `last_heartbeat_at`
- `lease_expires_at`
- `status`: `idle | working | draining | disconnected`
- `metadata`: cwd, branch, host, pid, capabilities
- `resume_token` or equivalent resumable credential

### Registration flow

1. Worker connects to broker.
2. Worker calls `agent.register` with identity hint + metadata + workspace identity.
3. Broker returns:
   - `identity_id`
   - `instance_id`
   - lease TTL
   - resume token
4. Worker sends `agent.heartbeat` periodically.
5. Worker sends `agent.unregister` on graceful shutdown.
6. If the worker reconnects unexpectedly, it calls `agent.resume` and regains its logical identity when valid.

### Ownership rules

Conversation ownership should move from transient instance attachment toward logical identity ownership:

- `owner_identity_id` — stable logical owner
- `active_instance_id` — current live holder when relevant

This is what prevents reconnects from losing a thread unnecessarily.

### Ghost-agent fix (#72)

The broker should run a periodic reaper that:

- expires instances whose leases are stale,
- marks them disconnected,
- leaves ownership resumable only for a bounded window when appropriate,
- and then releases claims when resumption has clearly failed.

This gives us the intended behavior:

1. brief disconnects do not steal a thread
2. dead workers do not stay active forever
3. graceful unregister does not black-hole replies
4. new workers can safely take over after expiry or reassignment

### PID handling

PIDs remain useful as metadata and as a local best-effort hint.
They should not be the primary lifecycle mechanism.

## 6. Daemonization (future work)

### Decision

Daemonization is explicitly **deferred**.

For phases 1-5, the control plane remains the broker as a pi extension.
A standalone daemon is future work after the protocol, lifecycle, PiComms integration, and delegation model are proven.

### Why defer it

This keeps near-term work focused on the real blockers first:

- lifecycle correctness,
- orchestration,
- protocol unification,
- PiComms integration,
- delegation.

It also avoids coupling the highest-risk migration to the earliest phases.

### Future constraints

If/when a daemon is introduced later, it should:

- preserve the broker protocol shape as much as possible,
- preserve workspace identity semantics,
- preserve the capability/authz model,
- and use an explicit cutover/rollback plan instead of redefining the architecture from scratch.

## 7. Broker as dedicated agent

### Decision

The broker should be a **hybrid control-plane actor**:

- a deterministic **`MessageRouter`** for hot-path policy decisions
- an **LLM broker agent** for smart routing and orchestration
- a periodic **Ralph loop** for maintenance and self-healing

### Deterministic core responsibilities

The core `MessageRouter` remains code, not prompt:

- existing conversation ownership
- channel assignment
- explicit mention routing
- basic rejection/authz decisions
- claim/release invariants

This keeps the hot path fast, testable, and predictable.

### LLM broker responsibilities

The broker agent keeps its LLM for higher-order behavior such as:

- smart default routing when no one owns a conversation
- deciding which worker is best for new work
- self-healing after worker death or lease expiry
- deciding whether to reassign, spin up, or answer directly
- natural-language orchestration commands such as “spin up 3 workers”
- graceful degradation when all workers are dead or unavailable

### Ralph loop

The Ralph loop is a periodic maintenance wake-up where the broker agent reviews state such as:

- stale or disconnected workers
- orphaned conversations
- queue backlog
- idle capacity
- failed deliveries
- opportunities to reassign or clean up

The LLM decides what should happen next, but all actions still go through typed tools / deterministic APIs.

### Guardrails

The broker agent is **not** allowed to become the source of truth for:

- capability/authz enforcement
- lease correctness
- storage invariants
- migration state
- protocol validity

Those remain deterministic responsibilities.

### Why this split is right

This gives us both properties we need:

- deterministic hot-path correctness
- flexible orchestration and recovery behavior

The system should not choose between code-only routing and LLM-only orchestration. It should compose them.

## Day-2 operations

This section captures the operational model needed once the broker becomes the durable control plane.

### Singleton / leadership

- The current broker leader remains a singleton.
- Exactly one leader owns the durable socket and Slack connection.
- Leader election / lock behavior must remain explicit and inspectable.

### Startup order

1. leader broker starts
2. schema checks/migrations run
3. durable socket opens
4. Slack adapter connects
5. followers and Neovim durable clients connect

If startup fails midway, the broker should fail closed rather than accept partial ownership.

### Socket discovery

- Durable broker socket: `~/.pi/pinet.sock`
- Optional session-local editor-context socket stays separate if needed
- Clients should not guess authority from incidental sockets; only the broker socket is authoritative for durable coordination

### DB migration failure handling

If a schema migration fails:

- the broker should refuse leadership
- the old stores remain untouched
- followers stay disconnected or degraded
- the operator gets a clear status/error signal

### Queue replay on restart

- inbox/message rows must remain durable
- ack must be idempotent
- restart may redeliver only unacked work
- comment notifications should be replay-safe or reconstructible from current state

### Minimum admin / status tooling

At minimum, day-2 ops need:

- broker status / leader status
- connected agents and leases
- thread/conversation ownership listing
- queue backlog visibility
- Ralph loop activity visibility
- migration/cutover mode visibility

### Backup / export discipline

Before any source-of-truth cutover:

- snapshot `.pi/picomms.db`
- snapshot `~/.pi/pinet-broker.db`
- record counts/checksums/invariants

This becomes mandatory in the future daemon phase.

## Proposed target architecture

```text
                Slack Socket Mode / Web API
                           │
                           ▼
                    Slack Adapter
                           │
                           ▼
                  Broker Extension (leader)
                           │
       ┌───────────────────┼────────────────────┐
       │                   │                    │
       ▼                   ▼                    ▼
 MessageRouter       Broker Agent (LLM)     Ralph Loop
(deterministic)      smart routing +        maintenance /
                     orchestration           self-healing
       │                   │                    │
       └───────────────┬───┴────────────────────┘
                       │
                       ▼
        Agent Registry + Leases + Conversation Service
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
   ~/.pi/pinet-broker.db   <workspace>/.pi/picomms.db
   runtime state           comments / PiComms state
                       ▲
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   Agent workers    Neovim UI      Pi tools
                     (durable
                     comment client)
```

## Cross-process flows

### Slack inbound

```text
Slack event
  -> Slack adapter
  -> MessageRouter tries deterministic hot-path routing first
  -> if owned/obvious: deliver immediately
  -> if ambiguous/orphaned: broker agent may choose target or respond
  -> worker receives message
  -> worker replies via message.send
  -> Slack adapter delivers outbound reply
  -> broker updates conversation state
```

### PiComms comment add

```text
comment_add tool or Neovim composer
  -> broker comment.add / message.send(kind=comment)
  -> broker writes workspace .pi/picomms.db
  -> subscribers notified
  -> Neovim panels refresh
```

### Agent-to-agent delegation

```text
worker decides to delegate
  -> broker conversation.delegate or message.send(target=identity)
  -> target worker receives delegated context
  -> ownership may transfer explicitly
  -> broker agent may arbitrate if no target is available
```

## Migration plan

The migration is intentionally ordered to defer daemonization.

### Phase execution rules

No phase should start unless all of the following are true:

- a named DRI exists in the tracking issue / implementation PR
- the phase has a feature flag or explicit on/off rollout lever
- observability needed for the phase exists first
- rollback steps are documented before merge
- the previous phase’s exit gate has been met

## Phase 1 — lifecycle fix (#72)

**Scope**

- stable identities
- heartbeats / leases
- graceful unregister semantics
- resumable reconnect
- stale-instance pruning

**Authoritative state**

- runtime: `~/.pi/pinet-broker.db`
- comments: unchanged

**Verification gate**

- crash / reconnect tests
- graceful unregister regression test
- lease-expiry tests
- duplicate-connection tests

**Rollback**

- revert broker/client lifecycle code
- additive schema fields remain unused if rolled back

## Phase 2 — Ralph loop + smart routing (#64)

**Scope**

- broker agent LLM orchestration
- Ralph loop maintenance wake-up
- capability/authz enforcement
- smart default routing and recovery behavior

**Authoritative state**

- unchanged physical stores
- broker remains runtime control plane

**Verification gate**

- deterministic router still handles hot path
- authz matrix enforced for every client class
- Ralph loop starts in shadow / canary mode first
- broker can answer or reassign when workers are missing

**Rollback**

- disable Ralph loop / LLM orchestration via feature flag
- fall back to deterministic router + current worker behavior

## Phase 3 — unified protocol

**Prerequisite**

- workspace identity is implemented and stable
- Phase 2 capability/authz model is live

**Scope**

- extend the broker socket API into the shared durable protocol
- add `message.*`, `comment.*`, `subscribe.*` families
- start converging clients on one broker-visible surface

**Authoritative state**

- comments still stored in `.pi/picomms.db`
- runtime still stored in `~/.pi/pinet-broker.db`
- protocol unifies before physical-store cutover

**Verification gate**

- contract tests for new RPC families
- workspace scoping proven across move/clone/worktree/branch cases
- capability matrix tested end-to-end
- legacy clients can still function during canary

**Rollback**

- disable new RPC families / protocol version
- revert clients to legacy APIs
- leave underlying stores unchanged

## Phase 4 — PiComms behind broker (#36)

**Scope**

- broker becomes the durable API for PiComms operations
- `nvim-bridge` becomes a thin client for durable comment behavior
- Neovim live updates come through broker-visible subscriptions or broker-mediated sync

**Authoritative state**

- comments still authoritative in workspace `.pi/picomms.db`
- broker runtime still authoritative in `~/.pi/pinet-broker.db`

**Read path**

- broker `comment.*` becomes primary
- legacy direct comment reads may remain as temporary verification shadow reads

**Write path**

- broker-mediated writes become primary
- direct writes are retired only after verification gate passes

**Verification gate**

- count/checksum parity between broker-visible reads and direct comment-store reads
- Neovim live-update soak
- reconnect / resubscribe drills
- comment add/list/wipe regressions pass in tools and Neovim

**Rollback**

- flip Neovim/tool clients back to direct PiComms ownership
- keep broker comment APIs read-only or disabled until fixed
- no physical DB migration needs to be undone yet

## Phase 5 — delegation + worker model (#71)

**Scope**

- explicit delegation / transfer semantics
- worker handoff without losing ownership history
- richer agent and conversation inspection for tooling (#68)

**Authoritative state**

- unchanged physical stores
- delegation metadata lives in broker runtime state

**Verification gate**

- handoff tests
- orphan recovery tests
- broker self-healing scenarios
- mixed broker-answer vs worker-answer behavior stays sane

**Rollback**

- disable delegation path
- fall back to single-owner per conversation behavior

## Phase 6+ — daemon / full gateway (future)

**Scope**

- optional standalone daemon
- possible unified physical store
- retirement of direct DB ownership in extension code

**Verification gate**

- only starts after phases 1-5 are stable
- requires explicit cutover/rollback drill in staging/canary mode first

**Rollback**

- revert reads/writes to legacy broker + workspace-local stores
- keep daemon in shadow or disabled mode

## Future cutover model for a single physical store

The first time the architecture proposes replacing `.pi/picomms.db` + `~/.pi/pinet-broker.db` with one gateway-owned DB, it must use an explicit cutover pattern.

Recommended pattern:

1. **Snapshot** both legacy stores
2. **Import** into the new store
3. **Verify** row counts, checksums, and invariants
4. **Shadow-read** from the new store while legacy reads remain authoritative
5. **Optional dual-write window** with an append-only audit log
6. **Flip reads** for a canary set of workspaces
7. **Flip writes** only after read parity is stable
8. **Retire old writes** after soak and replay validation

**Rollback lever**

If the new store misbehaves:

- disable new reads/writes by feature flag
- restore legacy reads immediately
- restore legacy writes immediately
- replay any canary-period audit log if reconciliation is needed
- keep the imported store for debugging, but not as source of truth

That makes the eventual physical-store migration reversible instead of aspirational.

## Compatibility promises

During migration, we should keep the existing tool surface stable where possible:

- `comment_add`
- `comment_list`
- `comment_wipe_all`
- `slack_send`
- `slack_read`
- `pinet_message`
- `pinet_agents`

Those tools should gradually become thin broker clients instead of direct infrastructure owners.

## Tradeoffs and rejected alternatives

### Alternative A — keep two DBs and two control planes forever

Rejected.
This keeps correctness problems alive indefinitely:

- duplicated ownership rules
- duplicated protocol semantics
- brittle notifications
- fragile migration paths

### Alternative B — one DB, but still two authoritative servers

Rejected.
One DB with two durable authorities still leaves:

- competing lifecycle logic
- duplicate protocol rules
- race conditions around subscriptions and ownership

### Alternative C — LLM-only broker with no deterministic routing core

Rejected.
The broker agent should keep its LLM, but not as the only routing mechanism.

What we want is:

- deterministic `MessageRouter` for the hot path
- LLM broker behavior for orchestration, recovery, and ambiguous cases

A pure LLM broker would make ownership, authz, and recovery too opaque.

### Alternative D — solve ghost agents with better PID cleanup only

Rejected.
PID checks are local hints, not a lifecycle protocol.
They do not solve reconnect/resume semantics.

### Alternative E — collapse comments and chat into one UX immediately

Rejected.
The transport and control plane can unify before the UX does.
PiComms should keep its editor-focused behavior.

## Risks

- The hybrid broker can become too magical if the LLM is allowed to bypass deterministic guardrails.
- Capability drift can turn one local socket into accidental overreach.
- Workspace identity mistakes could fragment or merge data incorrectly across worktrees/clones.
- Phase 4 PiComms migration can still regress editor behavior if shadow verification is weak.
- Future daemonization will still be a real migration and must not be treated as a refactor-only step.

## Open questions

1. **Future physical store shape**
   - one DB
   - attached DBs
   - or long-term split stores behind one control plane

2. **Broker autonomy envelope**
   - how much worker spawning/reassignment authority should the broker LLM get by default?

3. **Future daemon trigger**
   - what operational signal justifies promoting the broker extension into a standalone daemon?

## Acceptance criteria for the architecture

We should consider the architecture successful when all of the following are true:

1. A Slack thread remains owned by the same logical worker across a short reconnect.
2. A dead worker stops appearing as active without requiring process-start cleanup.
3. PiComms comments and broker-visible conversation state can be queried through one control-plane protocol.
4. Neovim receives live comment updates without owning a second durable control plane.
5. `slack_send`, `comment_add`, and `pinet_message` all route through one canonical message model.
6. The deterministic `MessageRouter` handles hot-path ownership rules while the broker LLM can orchestrate recovery and ambiguous routing without violating authz/lifecycle invariants.

## Recommendation

Adopt the broker-centered architecture.

In short:

- **shared control plane:** yes
- **shared protocol:** yes
- **separate physical stores in the near term:** yes
- **`message.send` primitive:** yes
- **workspace identity before protocol unification:** yes
- **capability/authz before broad broker ownership:** yes
- **heartbeats + leases + identity resumption:** yes
- **LLM broker on top of deterministic router:** yes
- **daemon now:** no
- **daemon later:** maybe, with explicit cutover/rollback

That gives the repo one realistic multi-agent foundation now, without forcing the riskiest migration before the protocol and lifecycle story are ready.
