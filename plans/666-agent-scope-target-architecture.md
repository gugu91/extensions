# #666 — Agent scope target architecture

- Issue: #666
- Status: proposal / architecture only
- Last updated: 2026-04-30
- Implementation posture: no broad code changes until maintainer approval

## Executive summary

Pinet should treat **scope** as four related but separate axes, not one overloaded
field:

1. **Workspace/install scope** — external transport tenancy, currently Slack
   workspace/install/channel context.
2. **Instance scope** — the local Pinet broker/runtime instance that owns a DB,
   socket, adapters, maintenance loop, and worker mesh.
3. **Repo scope** — the code workspace a worker can safely act in, used for
   delegation and routing affinity, not for Slack tenant authorization.
4. **Agent role/capability scope** — what the connected agent is allowed and
   suited to do: broker vs worker, tools, tags, branch, and advertised skills.

The target model is: **transport scope gates who/where a message belongs;
instance scope gates which broker/runtime owns it; repo scope gates which workers
may receive implementation work; role/capability scope gates what the recipient
may do.**

Current `main` already has useful compatibility plumbing: first-class
`RuntimeScopeCarrier` metadata, agent capability tags, deterministic thread
ownership, durable Pinet mail/read, and Pinet-preferred Slack delivery. The next
architecture step is to make those seams authoritative in small slices instead
of reviving the older broad multi-workspace stack.

## Scope axes

### 1. Workspace/install scope

Definition: the external transport boundary for a message or surface.

For Slack today this is:

- `provider: "slack"`
- Slack `teamId` / workspace id when known
- optional install id when multi-install support exists
- channel/thread context as message-local routing context

Current compatibility behavior should remain:

- singleton installs use `source: "compatibility"` with
  `compatibilityKey: "default"`
- missing Slack `teamId` stays unknown; do not invent fake workspace ids
- scope metadata may travel on messages and agent metadata before enforcement is
  complete

Target behavior:

- every inbound transport message carries workspace/install scope
- every outbound transport send must either match the thread's recorded
  workspace/install scope or explicitly opt into a cross-scope/admin path
- workspace/install scope is the primary boundary for Slack user admission,
  Slack tool authorization, Home tabs, canvases, logs, and default channels

### 2. Instance scope

Definition: the local Pinet runtime/control-plane boundary.

An instance owns:

- broker DB and routing state
- broker socket / follower mesh
- adapter set such as Slack/iMessage/future transports
- maintenance/Ralph loop and control-plane status surfaces

Current compatibility behavior should remain:

- singleton runtime uses compatibility instance scope
- `runtimeMode: single | broker | follower | off` describes process role, not
  tenancy by itself

Target behavior:

- every broker/follower registration advertises instance scope
- followers only attach to one active instance unless an explicit multi-instance
  operator workflow is designed
- Pinet mail, thread ownership, and agent listings are instance-local by default
- cross-instance operator actions require explicit target selection and admin
  authorization

### 3. Repo scope

Definition: the local codebase/worktree boundary a worker can act in.

Repo scope is **not** a Slack tenant boundary. It is a work-routing and safety
boundary derived from runtime metadata such as repo name, repo root, branch, and
worktree.

Target behavior:

- brokers delegate implementation only to agents advertising the matching repo
  scope
- branch/worktree is a routing hint and review aid, not an authorization bypass
- repo-specific broadcasts must not use global `#all`; use repo-scoped channels
  or direct assignment
- agents in other repositories may receive high-level coordination only when the
  broker explicitly targets them for non-implementation context

### 4. Agent role/capability scope

Definition: the agent's advertised role and capabilities inside an instance and
repo.

Current examples:

- `role: broker | worker`
- `tools`, `tags`, `repo`, `repoRoot`, `branch`
- generated capability tags such as `role:worker`, `repo:extensions`,
  `tool:test`, `workspace:T...`, `instance:...`

Target behavior:

- `broker` is coordination/infrastructure only; it must not implement
- `worker` may implement only inside matching repo/worktree scope and normal
  guardrails
- tools/tags are routing selectors and policy inputs; they should be compact and
  discoverable through `pinet action=agents`
- role/capability scope should never grant transport access by itself; it only
  narrows what an already-admitted runtime participant may do

## Routing, ownership, and authorization

### Inbound Slack/Pinet routing

Current baseline to preserve:

1. Slack admission is default-deny unless configured otherwise.
2. Inbound Slack messages become broker/Pinet messages with source, channel,
   thread id, metadata, and scope where available.
3. Known thread ownership is authoritative. Existing owner or reconnected stable
   identity wins before broad routing.
4. Explicit in-thread control can stand down or retarget a thread.
5. New work can route by channel assignment, direct mention, or broker decision.
6. Durable unread pointers and mail classes (`steering`, `fwup`, maintenance)
   keep prompt noise compact.

Target additions:

- store thread scope as first-class thread metadata, not only per-message
  metadata
- route only to agents in the same instance scope by default
- for Slack-origin work, prefer agents whose advertised workspace/install scope
  matches the thread scope
- for implementation work, additionally require matching repo scope
- if no same-scope owner exists, leave the item unrouted or broker-owned rather
  than cross-routing silently

### Outbound delivery

Current baseline to preserve:

- Slack replies prefer Pinet `message.send` / `sendBrokerMessage` when healthy
- `sendBrokerMessage` claims/checks thread ownership and then calls the
  registered adapter
- Slack adapter delivery ultimately calls Slack `chat.postMessage`
- direct Slack fallback is only for unavailable/unhealthy Pinet delivery
- healthy ownership conflicts fail closed and must not be bypassed by direct
  Slack fallback

Target additions:

- outbound sends must include or resolve the target thread scope
- adapter sends must reject scope mismatches unless the caller is in an explicit
  admin/cross-scope path
- successful broker sends should record the scope used for the send alongside the
  outbound message/thread record

### Authorization

Authorization should be layered:

1. **Transport admission** — Slack user/workspace/install/channel admission.
2. **Instance admission** — follower/worker membership in this broker instance.
3. **Thread ownership** — which agent may answer or mutate a thread.
4. **Action policy** — which tools/actions are allowed for this Slack/Pinet
   context.
5. **Role guardrails** — broker cannot implement; workers cannot administer
   control-plane state unless explicitly allowed.

No single layer should compensate for another. For example, a worker matching
`repo:extensions` still cannot answer a Slack thread from a different workspace,
and a Slack-admitted user still cannot force a broker to run implementation tools
when broker role guardrails forbid them.

## Backlog recommendations

### Supersede / keep closed as historical

- **#546 / PR #565** — keep closed. It landed the compatibility carrier base.
  This proposal is the current target architecture that supersedes the older
  issue text.
- **PRs #567, #568, #570** — keep closed/stale. Do not resurrect the old broad
  stack; cherry-pick only still-relevant ideas into fresh narrow PRs.
- **#571, #573, #584 / PR #591** — keep closed. Repo-scoped delegation policy is
  now part of the target repo-scope axis.
- **#636 / PR #638, #645 / PR #647, #658 / PR #661** — treat as merged baseline
  for thread affinity, ownership persistence, and Pinet-preferred delivery.
- **#651** — keep closed. Overlapped Slack surface work is superseded by #658,
  #656/#657, #660/#662, and the dispatcher/quiet-output direction.

### Restack / update before implementation

- **#547** — keep open but restack as the first enforcement lane after this
  architecture is accepted. Scope: scope-aware admission/action checks for Slack
  ingress, broker routing, `pinet action=send`, and outbound delivery.
- **#548** — keep open but sequence after #547. Scope: privileged
  broker/operator/admin actions with explicit workspace/instance targets.
- **#549** — keep open but narrow to configuration/topology for multiple Slack
  installs. It should define explicit install ids and config shape before any
  runtime fan-out.
- **#550** — keep open but sequence after #549. It should orchestrate multiple
  install surfaces only after topology/config is accepted.
- **#594** — remains the messaging-sync umbrella. Cross-link #666 as the scope
  model used by durable Pinet mail/read; do not overload #594 with scope policy.
- **#615** — phase-2 dispatcher work has largely landed via #646. Close or
  update this issue so remaining Pinet-surface work is not confused with scope
  architecture.

### Leave closed per maintainer decisions

- **#559** — leave closed unless the threat model changes to multi-host broker
  exposure.
- **#561** — leave closed as local-power documentation/hardening context, not a
  scope-model blocker.

## Smallest implementation follow-ups after agreement

1. **Thread scope persistence**
   - Add a narrow DB/schema slice to persist `RuntimeScopeCarrier` on broker
     thread records or a thread-metadata companion.
   - Populate it from Slack inbound context and Pinet-created thread context.
   - Preserve compatibility default behavior for existing rows.

2. **Scope matching helpers**
   - Add pure helpers for `sameWorkspaceScope`, `sameInstanceScope`, and
     `isUnknownCompatibilityScope` with tests.
   - Keep unknown compatibility scopes permissive only for existing singleton
     behavior; do not treat unknown as matching explicit foreign scopes.

3. **Scope-aware outbound send check**
   - Extend `sendBrokerMessage` / Slack Pinet delivery to resolve the thread
     scope and reject mismatched caller/adapter scope unless an explicit admin
     path is present.
   - Preserve current fail-closed ownership behavior.

4. **Scope-aware agent routing filter**
   - Before ranking candidates, filter by instance scope; for Slack-origin
     messages, prefer/require workspace scope match once thread scope is known.
   - For implementation tasks, require repo match in broker delegation guidance
     and deterministic routing helpers.

5. **Scoped authorization config sketch**
   - Extend current global Slack `allowedUsers`/`allowAllWorkspaceUsers` with an
     additive, backward-compatible scoped shape.
   - Keep singleton configs working through the compatibility scope.

6. **Admin/operator target selectors**
   - For Home tabs, canvases, log channels, `/pinet-*`, and dispatcher admin
     actions, require explicit workspace/instance target once more than one is
     configured.

## Open decisions for maintainers

1. Should Slack channel id be part of workspace/install scope, or stay strictly
   message-local context under a workspace/install?
2. Do we want repo scope to include full `repoRoot` paths in broker-visible
   structured details, or keep visible output to repo/branch and reserve paths
   for local-only diagnostics?
3. What is the first explicit multi-install identifier: configured alias,
   Slack enterprise/team id, app install id, or a generated install key?
4. Should cross-repo coordination ever be automated, or should it remain
   explicit broker-only delegation?
