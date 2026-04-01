# architecture-rfc

Status: Draft
Date: 2026-04-01
Related issues: #35, #36, #38, #64, #68, #71, #72

## Summary

This RFC proposes a single local **gateway daemon** as the control plane for the extensions repo.

The gateway would own:

- the authoritative Unix socket API,
- the authoritative SQLite store,
- agent registration and routing,
- Slack connectivity and delivery,
- PiComms comment persistence and notifications.

The core recommendation is:

1. **Unify PiComms and Broker at the service boundary**.
   - They should share one logical store and one protocol.
   - They should remain separate domain modules inside that store.
   - They should not remain two independently-owned SQLite systems.

2. **Use one authoritative cross-process server**.
   - Durable coordination, comments, routing, and agent lifecycle should go through one gateway socket.
   - If a second socket survives, it should be a thin session-local editor bridge only, not a second source of truth.

3. **Make `send_message` / `message.send` the primitive**.
   - Slack, Neovim, and agent-to-agent messaging become adapters around one canonical message flow.

4. **Move from PID cleanup to stable identities + leased instances + heartbeats**.
   - This is the key fix for ghost agents (#72).

5. **Treat the broker as deterministic infrastructure, not as an LLM worker**.
   - The router should be testable, promptless, and separate from worker agents.

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
- two routing models,
- two socket protocols,
- two ownership models,
- and two different answers to lifecycle and reconnect behavior.

That is manageable for point features, but it is the wrong foundation for multi-agent coordination, delegation, and daemonization.

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

This is a good start for routing, but it is still separate from PiComms and still ties ownership to transient agent rows.

### Current architectural friction

| Concern         | PiComms                         | Broker                                | Problem                       |
| --------------- | ------------------------------- | ------------------------------------- | ----------------------------- |
| Store ownership | `nvim-bridge` process           | broker process                        | split brain                   |
| DB path         | repo-local `.pi/picomms.db`     | global `~/.pi/pinet-broker.db`        | no unified abstraction        |
| Socket API      | newline JSON, custom RPC + push | JSON-RPC                              | duplicated transport concepts |
| Thread identity | `global` / `ctx:*`              | Slack `thread_ts` / `a2a:*`           | overloaded IDs                |
| Lifecycle       | none beyond process lifetime    | register/unregister + PID cleanup     | no lease/resume model         |
| Delivery        | direct socket broadcast         | inbox queue                           | incompatible event model      |
| Slack send path | not involved                    | partly direct, partly broker-mediated | inconsistent ownership        |

## Goals

- Create one coherent local architecture for comments, message routing, and agent coordination.
- Fix ghost agents and stale thread ownership (#72).
- Support daemonization cleanly (#38).
- Keep Slack, Neovim, and agent-to-agent flows on the same foundation.
- Preserve existing tool surfaces while simplifying the internals.
- Keep routing deterministic and testable.

## Non-goals

- This RFC does not implement the gateway.
- This RFC does not redesign the Slack or Neovim UX.
- This RFC does not define issues/PRs as first-class PiComms entities yet.
- This RFC does not require a public generic `send_message` tool immediately; it defines the internal primitive first.

## Proposal

## 1. Unify PiComms and Broker behind one gateway

Introduce a persistent local **gateway daemon** that becomes the only authoritative owner of:

- agent registry,
- thread/conversation routing,
- message delivery queues,
- PiComms comment storage,
- Slack adapter state,
- cross-process subscriptions/notifications.

### Decision

**PiComms and Broker should share one logical store and one control-plane service.**

They should **not** collapse into one giant undifferentiated table or one monolithic module.
Instead, they should become separate bounded contexts behind one gateway:

- **Agent Registry**
- **Routing + Conversation Service**
- **Message Service**
- **Comment Service (PiComms)**
- **Delivery / Subscription Service**

### Why

This gives us:

- one writer for SQLite,
- one place to enforce lifecycle rules,
- one place to map external threads to internal conversations,
- one place to broadcast updates to Slack/Neovim/agents,
- and one foundation for delegation and tooling.

### Recommended storage shape

The recommended end state is a single gateway-owned SQLite database, for example:

- `~/.pi/gateway.db`

with workspace scoping inside the schema rather than separate DB ownership per extension.

Conceptually:

- `workspaces`
- `agent_identities`
- `agent_instances`
- `conversations`
- `messages`
- `comments`
- `delivery_queue`
- `subscriptions`
- `leases` or lease fields on `agent_instances`

### Important nuance

This RFC recommends a **shared store**, not a total semantic merge.

PiComms comments are still different from Slack chat messages:

- they are code-anchored,
- they are intentionally durable,
- they are often repo-scoped,
- and they drive editor UX.

So the right abstraction is:

- **shared physical store / shared control plane**
- **separate logical services and projections**

### Rejected alternative

**Keep PiComms DB and Broker DB separate forever, with sync glue between them.**

Rejected because it preserves the hardest problems:

- no transactional consistency between routing and comments,
- no single lifecycle owner,
- duplicate thread identity rules,
- more migration code than architecture.

## 2. Replace “thread IDs everywhere” with internal conversations

The current code overloads `thread_id` to mean several different things:

- Slack `thread_ts`
- PiComms `global`
- PiComms context threads like `ctx:file:start-end`
- synthetic agent threads like `a2a:sender:target`

That is useful at the edges, but it is the wrong core abstraction.

### Decision

Introduce an internal **conversation** model:

- `conversation_id`: stable internal primary key
- `workspace_id`: nullable for global conversations
- `kind`: `slack | comment | a2a | system | mixed`
- `external_ref`: optional adapter-specific key such as Slack `thread_ts`
- `conversation_key`: optional stable human/computed key such as `global` or `ctx:src/foo.ts:10-20`
- `owner_identity_id`: nullable logical owner
- `created_at`, `updated_at`

Adapters may still expose familiar IDs externally, but the gateway should stop using them as the primary identity.

### Why

This avoids hard-coding transport details into the domain model.

Examples:

- a Slack reply belongs to a conversation with a Slack adapter ref
- a PiComms code thread belongs to a conversation with a workspace key
- an agent-to-agent direct message belongs to a conversation with participants, not a transient `a2a:<instance>:<instance>` ID

## 3. One authoritative socket server

### Decision

Use **one authoritative gateway server** for durable cross-process behavior.

That server should own:

- comments,
- routing,
- agent coordination,
- lifecycle,
- subscriptions,
- delivery queues.

### Protocol

Use one versioned JSON-RPC-style protocol with support for notifications.

Example method families:

- `agent.register`
- `agent.heartbeat`
- `agent.unregister`
- `agent.resume`
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
- `gateway.status`

Notifications on the same socket can cover:

- `message.delivered`
- `comment.added`
- `conversation.updated`
- `agent.expired`

### One server or two?

The recommendation is:

- **one authoritative long-lived server** for all durable coordination
- **optionally one thin session-local bridge** for editor-context injection only

That means:

- comments, routing, and agent coordination go through the gateway
- a second socket is acceptable only if it is ephemeral and stateless
- a second socket must not own durable state or define competing lifecycle rules

### Why this split is acceptable

`nvim-bridge` currently mixes two concerns:

1. editor context injection for the current pi session
2. durable PiComms state

Those concerns do not need the same lifetime.

A session-local editor bridge can remain local if needed.
But durable PiComms comments should move behind the gateway.

## 4. `send_message` becomes the primitive

### Decision

Define one canonical internal send primitive, conceptually:

- `message.send(...)`

Public tools may remain adapter-specific for now:

- `slack_send`
- `comment_add`
- `pinet_message`

But internally they should all call the same application service.

### Canonical message envelope

At the domain layer, a message should look more like this:

- `conversation_id`
- `workspace_id` (optional)
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
  - current tools remain thin wrappers over gateway RPC

### Practical effect

This removes duplicated logic such as:

- direct Slack API sends from one code path,
- broker-mediated sends from another,
- separate comment writes outside broker visibility.

## 5. Agent lifecycle: identities, instances, leases

This is the most important operational change in the RFC.

### Current weakness

Broker currently relies on a mix of:

- agent rows keyed by transient IDs,
- socket close events,
- `touchAgent()` on inbox poll,
- PID cleanup on startup.

That is not enough for reconnect, daemonization, or ghost-agent prevention.

### Decision

Split agent lifecycle into three distinct concepts:

#### Agent identity

A stable logical identity.
Examples:

- “Hyper Owl in this workspace”
- a named worker agent
- a dedicated reviewer worker

This survives reconnects.

#### Agent instance

A live process/session bound to one socket connection.
This is what heartbeats.
This is what dies.

#### Lease

A time-bounded claim that proves an instance is alive.
When the lease expires, the instance is considered gone even if cleanup hooks never fired.

### Recommended fields

For agent instances:

- `instance_id`
- `identity_id`
- `connected_at`
- `last_heartbeat_at`
- `lease_expires_at`
- `status`: `idle | working | draining | disconnected`
- `metadata`: cwd, branch, host, pid, capabilities
- `resume_token` or equivalent resumable credential

### Registration flow

1. Worker connects to gateway.
2. Worker calls `agent.register` with identity hint + metadata.
3. Gateway returns:
   - `identity_id`
   - `instance_id`
   - lease TTL
   - resume token
4. Worker sends `agent.heartbeat` periodically.
5. Worker sends `agent.unregister` on graceful shutdown.
6. If the worker reconnects, it calls `agent.resume` using resume token and regains its logical identity when valid.

### Ownership rules

Conversation ownership should move from:

- `owner_agent = transient row id`

into:

- `owner_identity_id = stable logical owner`
- optionally `active_instance_id = current holder`

This matters because a reconnecting worker should be able to resume ownership without the thread looking abandoned.

### Ghost-agent fix (#72)

The gateway should run a periodic reaper that:

- expires instances whose leases are stale,
- marks them disconnected,
- leaves ownership resumable for a short grace window,
- then releases conversations if the identity does not resume.

That gives us three desirable behaviors:

1. **brief disconnects do not steal the thread**
2. **dead workers do not stay registered forever**
3. **new workers can reclaim work after grace expires**

### PID handling

PIDs remain useful as metadata and as a local best-effort hint.
They should no longer be the primary lifecycle mechanism.

## 6. Daemonization

### Decision

The persistent gateway process should own the SQLite database and all durable routing state.

### Responsibilities of the daemon

- run the authoritative socket server
- own the SQLite connection(s)
- run schema migrations
- maintain leases and cleanup
- maintain Slack adapter connection(s)
- enqueue and deliver messages
- broadcast comment/conversation updates

### Responsibilities of worker agents

- register with the gateway
- claim work
- perform reasoning and tool use
- send replies back through the gateway
- heartbeat while alive

### Why this boundary is right

The gateway is infrastructure.
Workers are computation.
Those concerns should not live in the same process lifetime.

This also cleans up today’s split behavior in `slack-bridge/index.ts`, where broker mode and follower mode take different paths and Slack sending is not fully centralized.

### Single-writer rule

Once daemonization lands, no extension should write the unified DB directly except the gateway.

Extensions should become clients.
That is the main architectural simplification.

## 7. Broker as dedicated agent

### Decision

The broker should be a **deterministic routing/control-plane component**, not a normal LLM worker.

### What this means

The router decides based on policy such as:

- existing conversation ownership
- channel assignment
- direct mention
- delegation target
- fallback queue / default worker

It should not do task reasoning.
It should not respond to product questions.
It should not own business logic prompts.

### Why

Routing needs to be:

- deterministic,
- testable,
- low-latency,
- and safe to run continuously.

An LLM-powered broker would make routing:

- non-deterministic,
- harder to debug,
- and harder to recover after reconnects.

### If a “broker agent” must exist

If product/UI reasons require a visible broker identity, it should be a **synthetic system identity** for observability only.

It may expose status and routing decisions.
It should not be the worker that solves user tasks.

## Proposed target architecture

```text
                Slack Socket Mode / Web API
                           │
                           ▼
                    Slack Adapter
                           │
                           │
Neovim UI ───────┐         │         ┌────── Agent workers
Pi tools  ───────┼────► Gateway Daemon ◄────┼────── reviewer / coder / broker-followers
Other clients ───┘         │         └────── future workers
                           │
                           ├── Agent Registry + Leases
                           ├── Conversation + Routing Service
                           ├── Message Service + Delivery Queue
                           ├── Comment Service (PiComms)
                           └── Subscription / Notification Service
                           │
                           ▼
                     SQLite (gateway-owned)
```

## Cross-process flows

### Slack inbound

```text
Slack event
  -> Slack adapter
  -> gateway normalizes inbound message
  -> router resolves owner / target worker
  -> delivery queue
  -> worker receives message
  -> worker replies via message.send
  -> Slack adapter delivers outbound reply
  -> gateway updates conversation state
```

### PiComms comment add

```text
comment_add tool or Neovim composer
  -> gateway comment.add / message.send(kind=comment)
  -> comment store writes durable record
  -> conversation updated
  -> subscribers notified
  -> Neovim panels refresh
```

### Agent-to-agent delegation

```text
worker decides to delegate
  -> gateway conversation.delegate or message.send(target=identity)
  -> target worker receives delegated context
  -> ownership may transfer explicitly
  -> replies still flow through same conversation model
```

## Migration plan

The migration should be incremental. The high-priority bug fix (#72) should not wait for the entire rewrite.

### Phase 0 — Freeze target model

- Approve this RFC.
- Agree on gateway ownership boundaries.
- Agree on conversation vs thread terminology.
- Agree that the router is deterministic infrastructure, not an LLM worker.

### Phase 1 — Fix lifecycle first (#72)

Add lifecycle primitives to the current broker stack before PiComms fully moves over:

- stable `identity_id`
- `instance_id`
- lease / heartbeat fields
- periodic stale-instance reaper
- resumable identity on reconnect
- ownership by logical identity instead of transient agent row alone

This gives immediate value even before comment unification.

### Phase 2 — Introduce unified gateway protocol

- extend the broker socket API into a gateway API
- add notifications/subscriptions
- keep compatibility shims for current follower clients
- define `message.send` and `comment.*` methods

### Phase 3 — Move PiComms behind the gateway (#36)

- move comment persistence ownership to the gateway
- make `nvim-bridge` a thin client for durable PiComms operations
- preserve existing `comment_add` / `comment_list` tools
- preserve current context-thread behavior as an external compatibility layer

### Phase 4 — Centralize Slack delivery (#38, #64)

- move outbound Slack delivery fully behind gateway ownership
- remove direct-vs-broker duality in `slack-bridge/index.ts`
- keep `slack_send` as a tool shim over gateway RPC

### Phase 5 — Delegation and worker model (#71)

- add explicit delegation / transfer semantics
- support worker handoff without losing conversation ownership
- expose richer agent and conversation inspection for tooling (#68)

### Phase 6 — Retire direct DB ownership in extensions

- remove direct writes to comment DB from `nvim-bridge`
- remove direct broker DB writes from non-gateway code paths
- keep migration/import code for legacy JSON and old DBs

## Compatibility promises

During migration, we should keep the existing tool surface stable where possible:

- `comment_add`
- `comment_list`
- `comment_wipe_all`
- `slack_send`
- `slack_read`
- `pinet_message`
- `pinet_agents`

Those tools should gradually become thin gateway clients instead of direct infrastructure owners.

## Tradeoffs and rejected alternatives

### Alternative A — keep two DBs, add sync

Rejected.
This makes all correctness problems harder:

- ownership
- migration
- notifications
- crash recovery
- routing + comment consistency

### Alternative B — one DB, but still two authoritative servers

Rejected.
One DB with two servers still leaves:

- competing lifecycle logic
- duplicate protocols
- race conditions around subscriptions and ownership

### Alternative C — make the broker an LLM agent

Rejected as the default architecture.
Routing should be policy code, not prompt engineering.

### Alternative D — solve ghost agents with better PID cleanup only

Rejected.
PID checks are local hints, not a robust lifecycle protocol.
They do not solve reconnect/resume semantics.

### Alternative E — collapse comments and chat into one UX immediately

Rejected.
The storage and transport can unify before the UX does.
PiComms should keep its own editor-focused behavior.

## Risks

- The gateway becomes critical infrastructure; restart behavior must be solid.
- Migration will temporarily require compatibility shims.
- A unified protocol needs capability boundaries so a UI client does not gain worker-only powers.
- Workspace scoping must be explicit so multi-repo usage stays understandable.
- There is some risk of over-generalizing too early; phases should stay disciplined.

## Open questions

1. **Physical DB layout**
   - Preferred answer in this RFC: one gateway-owned DB.
   - If repo portability becomes a hard requirement later, add export/import or attached workspace DBs.

2. **Editor context transport**
   - This RFC allows a thin session-local bridge to survive.
   - We can later decide whether editor context also moves fully into the gateway.

3. **Public generic tool**
   - Internal `message.send` is required.
   - A public generic `send_message` tool is optional and can come later.

4. **Conversation ownership grace window**
   - Needs a concrete default TTL.
   - It should be long enough for reconnect, short enough to clear dead workers quickly.

## Acceptance criteria for the architecture

We should consider the architecture successful when all of the following are true:

1. A Slack thread remains owned by the same logical worker across a short reconnect.
2. A dead worker stops appearing as active without requiring process-start cleanup.
3. PiComms comments and broker-visible conversation state can be queried from one control plane.
4. Neovim receives live comment updates without owning the durable store.
5. `slack_send`, `comment_add`, and `pinet_message` all route through one canonical message path.
6. The router can run continuously without being an LLM worker.

## Recommendation

Adopt the gateway architecture.

In short:

- **shared store:** yes
- **shared abstraction:** yes
- **one authoritative server:** yes
- **`send_message` primitive:** yes
- **heartbeats + leases + identity resumption:** yes
- **daemon owns SQLite:** yes
- **broker as normal worker agent:** no

That gives the repo one coherent multi-agent foundation instead of two adjacent systems that keep rediscovering the same problems from different directions.
