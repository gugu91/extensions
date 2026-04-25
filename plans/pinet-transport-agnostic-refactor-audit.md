# Pinet transport-agnostic refactor audit

- Status: read-only architecture audit / planning artifact
- Date: 2026-04-25
- Branch: `docs/pinet-refactor-audit`
- Repo state audited: `ef4bfa2` (`main` at audit start)
- Follow-up to: `plans/slack-split-proposal.md`, `plans/pinet-vision.md`, `plans/420-broker-daemon-prd.md`
- Related issues: #264, #322, #324, #325, #373, #403, #420, #464, #472, #480, #481, #482, #547, #548, #549, #550, #551, #552, #553, #554, #556, #575, #582, #588, #594, #596

## Executive summary

Pinet is architecturally ready for a substantial modular refactor, but the refactor should be contract-first rather than file-move-first.

The repo already contains the beginning of the intended layering:

```text
transport-core  -> current transport-neutral message and scope contracts
broker-core     -> current deterministic broker DB/router/message primitives
pinet-core      -> reserved scaffold only; no runtime implementation yet
slack-bridge    -> current real Pinet runtime, Slack adapter, Slack tools, and composition root
imessage-bridge -> thin macOS/iMessage send-first adapter scaffold
```

The largest problem is not that there is no seam. The problem is that the seam is currently too shallow and still Slack-shaped in the places that matter most.

The earlier `plans/slack-split-proposal.md` got the lower-layer direction right, but this audit supersedes its compatibility-first assumption that Slack remains the durable extension entrypoint. The updated target is:

```text
pi session / future daemon
  └─ adapter package(s)
       ├─ @gugu910/pi-pinet-core      runtime orchestration library
       ├─ @gugu910/pi-broker-core     deterministic broker kernel + local RPC
       └─ @gugu910/pi-transport-core  canonical transport/content/scope contracts
```

Do **not** split this into two peer Pi extensions where `slack-bridge` and `pinet-core` both own runtime state. With the pre-release clean-slate constraint, the cleaner target is a first-class Pinet composition package/extension that owns runtime state, with Slack and iMessage as adapters. `slack-bridge` should no longer be treated as the durable Pinet entrypoint; it should become the Slack transport/UX package.

The cleanest path to “Pinet outside Slack” is:

1. deepen `transport-core` around provider/install/conversation/message/actor/content/capability concepts;
2. move transport-neutral broker socket/client/bootstrap ownership into `broker-core`;
3. make `broker-runtime.ts` port-driven so it receives adapters and publishers instead of constructing Slack directly;
4. extract Pinet runtime modules into `pinet-core` behind explicit adapter, policy, UI, and persistence ports;
5. keep Slack-specific UX/API/tools inside `slack-bridge`;
6. wire iMessage and future cloud transports as ordinary adapters with truthful capabilities.

The security backlog (#322, #324, #325) is a hard precondition before multi-host/cloud mesh support. Raw TCP plus optional shared secret and client-supplied stable IDs should not become the foundation for remote/cloud Pinet.


## Clean-slate update: pre-release, no backward-compatibility constraint

After this audit was drafted, Thomas clarified that the repo should treat Pinet as **pre-release** and should be willing to make very substantial breaking changes. That changes the recommendation from “minimize user-facing churn while extracting internals” to “use the split to create the clean product boundary now.”

The stronger recommendation is therefore:

1. make **Pinet** the first-class runtime/composition package, not a runtime hidden inside `slack-bridge`;
2. demote Slack to a transport/UX adapter package;
3. remove legacy settings, compatibility shims, Slack defaults, and ambiguous aliases during the refactor rather than carrying them forward;
4. prefer a clean DB/schema/API shape over compatibility columns where migration cost is low;
5. rename tools/settings/packages if the new names make the future system clearer;
6. do not preserve `slack.proxy`, `autoConnect`, `autoFollow`, Slack-default thread sources, or Slack-owned iMessage tooling unless a specific transition PR needs them temporarily.

A cleaner pre-release target package layout is:

```text
transport-core        # provider/install/conversation/message/content/capability contracts
broker-core           # deterministic broker kernel, DB, local RPC, routing
pinet-core            # runtime orchestration library
pinet-extension       # Pi extension/composition root for Pinet runtime + adapter registry
slack-bridge          # Slack transport + Slack-specific UX/actions, not Pinet owner
imessage-bridge       # iMessage transport adapter
pinet-cli             # later: daemon/control CLI
pinet-daemon          # later: durable local control-plane process
```

If package count should stay smaller initially, `pinet-extension` can be folded into `pinet-core` as a `./extension` export, but the conceptual split should remain: **Pinet owns runtime; Slack plugs into it.**

This also changes the settings recommendation:

```jsonc
{
  "pinet": {
    "runtimeMode": "broker",
    "instance": { "id": "local-dev", "name": "Local Dev" },
    "mesh": { "auth": { "secretPath": "..." } },
    "transports": {
      "slack": {
        "installs": [{ "id": "default", "botToken": "xoxb-...", "appToken": "xapp-..." }]
      },
      "imessage": { "enabled": true }
    },
    "security": { "readOnly": false, "blockedTools": [], "requireConfirmation": [] }
  }
}
```

The current `slack-bridge.*` namespace should not be protected as a long-term compatibility boundary. It can be replaced outright in the substantial refactor.
Pinet should own the top-level settings namespace and runtime composition, but adapter packages should own provider-specific config schemas and validation. In practice: `pinet.transports.slack` stores Slack install config, while `slack-bridge` exports the Slack adapter factory and validates Slack-specific token/manifest fields. That prevents Pinet core from learning Slack API details while still giving operators one coherent config surface.

Recommended settings schema shape:

```ts
interface PinetSettings {
  runtimeMode: "off" | "broker" | "worker";
  instance: PinetInstanceSettings;
  mesh: PinetMeshSettings;
  broker: PinetBrokerSettings;
  transports: Record<TransportProviderId, unknown>;
  tools: PinetToolSettings;
  security: PinetSecuritySettings;
  observability: PinetObservabilitySettings;
}

interface PinetInstanceSettings {
  id: string;
  name: string;
  profile?: string;
  dataDir?: string;
}

interface PinetMeshSettings {
  auth:
    | { mode: "off" }
    | { mode: "shared-secret"; secret?: string; secretPath?: string }
    | { mode: "credential"; credentialPath: string };
  listen?: { kind: "unix"; path?: string } | { kind: "tcp-loopback"; port: number };
}

interface PinetBrokerSettings {
  databasePath?: string;
  ralph?: { enabled: boolean; intervalMs?: number };
  maintenance?: { enabled: boolean; intervalMs?: number };
  controlPlane?: { home?: boolean; canvas?: boolean; log?: boolean };
}

interface PinetToolSettings {
  hotTools?: Array<"pinet_agents" | "pinet_message" | "pinet_free" | "pinet_schedule" | "pinet_read">;
  dispatcher?: { enabled: boolean };
}

interface PinetSecuritySettings {
  readOnly?: boolean;
  blockedTools?: string[];
  requireConfirmation?: string[];
  origins?: Record<string, OriginPolicySettings>;
}

interface PinetObservabilitySettings {
  logLevel?: "errors" | "actions" | "verbose";
  auditNativeActions?: boolean;
}
```

Adapter config lives under `transports` and is validated by the adapter package, for example:

```ts
interface SlackTransportSettings {
  installs: Array<{
    id: string;
    workspaceId?: string;
    botToken: string;
    appToken: string;
    defaultChannel?: string;
    logChannel?: string;
    allowedUsers?: string[];
    allowAllWorkspaceUsers?: boolean;
    suggestedPrompts?: { title: string; message: string }[];
    manifest?: { appId?: string; appConfigToken?: string };
  }>;
}

interface IMessageTransportSettings {
  enabled: boolean;
  accountId?: string;
  osascriptPath?: string;
}
```

Schema ownership rule: Pinet owns the envelope (`runtimeMode`, `instance`, `mesh`, `broker`, `security`, `observability`, and the `transports` map); each adapter owns the value schema under its provider key. Unknown provider keys should fail closed unless a plugin manifest/factory is explicitly configured.


## Scope and method

This audit inspected:

- package metadata and workspace topology;
- existing planning docs;
- current Pinet, broker, Slack, and iMessage source files;
- open issue/PR backlog via GitHub CLI;
- tool registration surface;
- package sizes/import hot spots;
- current test distribution.

No runtime implementation changes were made in this audit. This file is intentionally a planning artifact.

## Current package topology

Current workspace packages relevant to Pinet and adjacent extension boundaries:

| Package | Current role | Current state |
| --- | --- | --- |
| `transport-core` | Message/scope contracts | Real but shallow; 2 files, 1 test, ~189 LOC |
| `broker-core` | DB/router/message-send/maintenance/auth primitives | Real; 12 files, 1 test, ~3.7k LOC |
| `pinet-core` | Intended Pinet runtime package | Scaffold only; `index.ts` is effectively empty |
| `slack-bridge` | Slack adapter + current full Pinet runtime | Real composition root; 148 TS files, 70 tests, ~52k LOC |
| `imessage-bridge` | macOS/iMessage send-first adapter | Real scaffold/adapter; 6 files, 2 tests, ~514 LOC |
| `slack-api` | Separate Slack Web API client/CLI package | Adjacent; currently distinct from `slack-bridge/slack-api.ts`, which creates naming/ownership confusion to resolve later |
| `browser-playwright` | Browser automation extension | Orthogonal, but useful precedent for truthful capability reporting (#557) |
| `nvim-bridge` | Neovim/PiComms extension | Orthogonal to transport split |
| `neon-psql` | Neon Postgres extension | Orthogonal, except for general security-boundary lessons (#560) |
| `openai-execution-shaping` | Model/execution-shaping extension | Orthogonal |

Current package dependency direction is mostly good:

```text
transport-core
  ↑
broker-core
  ↑
pinet-core   (currently no runtime)

slack-bridge -> broker-core, transport-core, imessage-bridge
imessage-bridge -> transport-core
```

The bad coupling is not primarily package dependency direction. It is semantic coupling: Slack is still the runtime default, config namespace, identity source, UX surface, and some broker RPC vocabulary.

## Current runtime topology

Today, `slack-bridge/index.ts` is the composition root. It wires:

- settings/env loading;
- Slack request runtime;
- single-player Slack mode;
- broker runtime;
- follower runtime;
- persisted runtime state;
- session UI runtime;
- agent event/prompt runtime;
- Pinet skin/status/maintenance/remote-control/mesh ops;
- Slack Home tabs and control-plane canvas;
- tool registration for Slack, Pinet, and iMessage;
- command registration for `/pinet-*`.

`slack-bridge/broker-runtime.ts` starts the broker and constructs the Slack adapter:

```ts
const broker = await startBroker(...)
const adapter = new SlackAdapter(...)
broker.addAdapter(adapter)
await adapter.connect()
```

This is the central violation of the desired architecture. A file named “broker runtime” is still adapter-aware and Slack-specific.

## Size and risk inventory

Highest-risk files by size and coupling:

| File | Approx LOC | Why it matters |
| --- | ---: | --- |
| `slack-bridge/helpers.ts` | 3377 | Mixed Slack config, Pinet identity, mesh auth, prompt text, runtime helpers, formatting, Ralph helpers |
| `slack-bridge/slack-tools.ts` | 2888 | Slack tool/action surface, policy, dispatcher/hot tools; high token-footprint impact |
| `broker-core/schema.ts` | 2137 | Broker DB + Pinet-specific tables; contains Slack-default compatibility residue |
| `slack-bridge/index.ts` | 1369 | Composition root; 35 local imports |
| `slack-bridge/broker/socket-server.ts` | 1000 | Broker RPC server; still has `slack.proxy` RPC path |
| `slack-bridge/broker-runtime.ts` | 843 | Runtime orchestration; constructs `SlackAdapter`; owns Slack control-plane publishing callbacks |
| `slack-bridge/ralph-loop.ts` | 627 | Mostly core maintenance logic but imports Slack activity/control-plane types |

The split should start by shrinking and splitting these high-risk files, not by mechanically moving them into another package.

## Existing good seams

### `transport-core` already defines the adapter shape

Current contract:

```ts
interface MessageAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (msg: InboundMessage) => void): void;
  send(msg: OutboundMessage): Promise<void>;
}
```

This is enough for the current Slack + send-first iMessage MVP. It is not enough for future Slack/iMessage/cloud parity.

### `broker-core/message-send.ts` already sends through adapters

`sendBrokerMessage(...)` accepts `MessageAdapter[]`, picks the adapter by `source`, writes the outbound broker message, and returns structured message/thread/adapter info. This is the most valuable existing adapter seam.

### `transport-core` already has scope carriers

The `RuntimeScopeCarrier` and compatibility scope helpers are the right direction for #480/#481/#482/#547/#549/#550. They need to evolve from metadata carriers into address/policy primitives.

### `imessage-bridge` is thin and correctly local

`imessage-bridge` owns AppleScript send/readiness logic and implements `MessageAdapter` with `name = "imessage"`. It truthfully ignores inbound because it is send-first today. That is the right adapter posture.

## Current coupling inventory

### 1. Runtime orchestration constructs Slack

`slack-bridge/broker-runtime.ts` imports and uses:

- `SlackBridgeSettings` from `helpers.ts`;
- `SlackAdapter` from `broker/adapters/slack.ts`;
- `SlackActivityLogger` from `activity-log.ts`;
- Slack Home tab/control-plane canvas publisher types;
- Slack-specific `source: "slack"` when remembering known threads.

This blocks direct movement into `pinet-core`.

Recommended fix: make broker runtime receive a list/registry of transport adapter factories and origin-specific publishers.

### 2. `broker-core` still has Slack defaults

Examples:

- `MessageRouter.claimThread(..., source = "slack")`;
- `BrokerDB.updateThread(...)` creates unknown threads with `updates.source ?? "slack"`;
- comments mention stale historical Slack owner hints.

This should be removed rather than preserved. A transport-agnostic core should require an explicit source/address for new threads. There should be no implicit Slack fallback in broker-core.

### 3. Broker socket RPC exposes `slack.proxy`

`slack-bridge/broker/socket-server.ts` includes:

```text
message.send     generic enough
slack.proxy      adapter-specific RPC method
```

Because the repo is pre-release, `slack.proxy` should be removed rather than carried as a legacy compatibility path. If broker-core needs adapter API calls at all, expose a provider-neutral shape:

```text
transport.call
adapter.call
transport.capabilities
```

Even then, adapter proxying should be policy-gated because it can bypass higher-level tool semantics.

### 4. Settings are named after Slack even when they configure Pinet

`SlackBridgeSettings` includes both Slack settings and Pinet settings:

- `botToken`, `appToken`, `defaultChannel`, `logChannel`;
- `runtimeMode`, `meshSecret`, `meshSecretPath`, `controlPlaneCanvasEnabled`;
- `agentName`, `agentEmoji`, `imessage.enabled`;
- `security.*`.

Rename settings during the refactor. Use a `pinet` top-level namespace and typed config views:

```text
SlackAdapterSettings       sourced from slack-bridge.*
PinetRuntimeSettings       sourced from slack-bridge.* initially, pinet.* later
MeshAuthSettings           sourced from `pinet.mesh.auth.*`
OriginPolicySettings       sourced by adapter/policy layer
```

### 5. `helpers.ts` mixes too many domains

`helpers.ts` currently exports values used across Slack adapter, runtime, prompts, identity, Ralph, formatting, mesh auth, and settings. This makes package extraction dangerous.

Split before moving. Suggested domains:

```text
slack-bridge/slack-settings.ts
slack-bridge/slack-compatibility-scope.ts
slack-bridge/slack-http.ts
slack-bridge/slack-access-policy.ts
slack-bridge/slack-prompt-source.ts

pinet-core/identity.ts
pinet-core/mesh-auth.ts
pinet-core/inbox-formatting.ts
pinet-core/runtime-diagnostics.ts
pinet-core/remote-control-protocol.ts
pinet-core/ralph-evaluation.ts
pinet-core/agent-display.ts
pinet-core/prompt-guidance.ts
pinet-core/thread-ownership.ts
pinet-core/runtime-settings.ts
```


Assign the high-traffic imports from `broker-runtime.ts` explicitly during this split:

- `SlackBridgeSettings` -> `PinetRuntimeSettings` plus `SlackAdapterSettings`;
- `resolvePinetMeshAuth` -> `pinet-core/mesh-auth.ts`;
- `buildPinetOwnerToken`, skin helpers, and `DEFAULT_PINET_SKIN_THEME` -> `pinet-core/identity.ts` / `pinet-core/skin.ts`;
- `syncBrokerInboxEntries` -> `pinet-core/inbox-sync.ts`.

### 6. Pinet tools are core-ish but policy and Pi SDK are adapter-owned

`slack-bridge/pinet-tools.ts` currently registers four hot Pinet tools:

- `pinet_message`
- `pinet_free`
- `pinet_schedule`
- `pinet_agents`

The four-tool surface is reasonable and already aligned with #554. However, registration imports Pi SDK types and calls `deps.requireToolPolicy(...)`, which is currently Slack-origin policy. To move this to `pinet-core`, expose registration as Pi-adapter integration plus policy ports:

```ts
interface PinetToolPolicyPort {
  authorize(action: PinetToolAction, context: ToolExecutionContext): void | Promise<void>;
}
```

### 7. Ralph is core logic with Slack publishers

`slack-bridge/ralph-loop.ts` contains useful pure logic and tests, but its dependencies include:

- Slack activity log types;
- broker control-plane dashboard snapshot;
- canvas/Home tab refresh callbacks;
- `ExtensionContext` UI callbacks.

Recommended split:

```text
pinet-core/ralph/evaluate.ts        pure maintenance/anomaly/nudge logic
pinet-core/ralph/runtime.ts         timer + broker DB + delivery callbacks
slack-bridge/ralph-publishers.ts    Slack Home/canvas/activity publisher adapter
```

### 8. iMessage is wired through Slack bridge tools

`slack-bridge/imessage-tools.ts` registers `imessage_send` and calls generic `sendBrokerMessage(...)` with `source: "imessage"`. The send path is good; the package location is wrong for the long term.

Preferred future:

- `imessage-bridge` owns adapter and optional transport-specific tool if needed;
- `pinet-core` owns generic `pinet_send` / `pinet_read` style primitives;
- Slack bridge should not be the owner of iMessage tool registration.

## Target architecture

### Package responsibilities

#### `transport-core`

Owns canonical contracts only:

- provider IDs and install/workspace identity;
- runtime/instance scope;
- actor/principal references;
- conversation/thread/message references;
- normalized message envelope;
- normalized content model and fallback projections;
- attachment/artifact references;
- delivery receipts and error contracts;
- transport capabilities;
- adapter interface v2.

Must not import Pi, Slack implementation, broker DB, or policy runtime.

#### `broker-core`

Owns deterministic broker infrastructure:

- DB schema/migrations for agents, conversations/threads, messages, inbox, backlog, wakeups where transport-neutral;
- router and routing decisions;
- message send/receive persistence;
- broker socket server/client and JSON-RPC protocol;
- local leadership/lock/auth primitives;
- agent registration/liveness/status;
- transport adapter registry plumbing without adapter implementation.

Must not own Slack UX, Pi UI, Home tabs, canvases, or prompt guidance.

#### `pinet-core`

Owns Pinet runtime orchestration:

- broker/follower lifecycle;
- inbox drain/cursors;
- session UI state ports;
- remote-control protocol;
- mesh ops;
- Pinet tools/commands registration helpers;
- Ralph/scheduler/maintenance orchestration;
- agent identity/personality/skin assignment if it is transport-neutral;
- agent prompt guidance, with origin-specific snippets injected through ports;
- runtime diagnostics and status snapshots.

Must not construct Slack clients or call Slack APIs.

#### `pinet-extension` or `pinet-core/extension`

Owns the Pi-facing runtime composition root:

- loads Pinet runtime settings;
- creates the broker/follower runtime;
- registers transport adapters;
- registers Pinet tools and commands;
- exposes runtime status/diagnostics;
- remains transport-neutral except for adapter registration glue.

This package/export should become the thing users enable when they want Pinet. Slack should plug into it rather than owning it.
This audit chooses the simplest first implementation mechanism: the first-class Pinet composition package depends on first-party adapter packages and instantiates configured adapters from `pinet.transports.*` settings. Adapter packages should export adapter factories plus config schemas/loaders; Pinet owns runtime composition, while adapters own provider-specific validation and API behavior. Avoid a shared global extension registry in the first cut because load order, duplicate runtime ownership, and failure modes would recreate split-brain risk. A later plugin manifest can generalize beyond first-party adapters once the core boundary is proven.


#### `slack-bridge`

Owns Slack adapter and Slack UX:

- Slack Socket Mode;
- Slack Web API calls;
- Slack event parsing;
- Slack `mrkdwn`/Block Kit/modal/canvas rendering;
- Slack Home tabs;
- Slack dispatcher and hot Slack tools;
- Slack-origin confirmation/policy behavior;
- Slack manifest deployment;
- single-player Slack mode;
- Slack adapter/UX package that is composed by the first-class Pinet runtime entrypoint.

#### `imessage-bridge`

Owns iMessage/Messages-specific adapter behavior:

- AppleScript send path;
- local macOS readiness checks;
- future Messages DB ingestion if approved;
- iMessage-specific render constraints.

Must not own Pinet routing or Slack config.

#### Future cloud/remote adapter

Should be just another transport adapter/client. It should not require changing broker/Pinet runtime concepts beyond implementing the same contracts and security model.

## Deep interface proposal

The current `InboundMessage`/`OutboundMessage` can be treated as short-lived v1 scaffolding. Introduce v2 types and migrate broker/runtime paths aggressively; keep v1 only where it simplifies a small intermediate PR.

### Transport identity

```ts
type TransportProviderId = "slack" | "imessage" | "cloud" | string;

interface TransportInstallRef {
  provider: TransportProviderId;
  workspaceId?: string;
  installId?: string;
  accountId?: string;
  compatibilityKey?: string;
}

interface PinetInstanceRef {
  instanceId: string;
  instanceName?: string;
}
```

### Conversation and message addresses

```ts
interface ConversationRef {
  provider: TransportProviderId;
  install?: TransportInstallRef;
  id: string;
  channelId?: string;
  threadId?: string;
  continuationOf?: MessageRef | ConversationRef;
}

interface MessageRef {
  provider: TransportProviderId;
  conversation: ConversationRef;
  id: string;
  timestamp?: string;
}
```

Add explicit dedupe/idempotency fields to the eventual envelope types, not just the references:

```ts
interface TransportMessageKeys {
  providerMessageId?: string;
  inboundDedupeKey?: string;
  outboundIdempotencyKey?: string;
  retryOf?: MessageRef;
}
```

These keys matter for #594's durable event log, Slack Socket Mode redelivery, future cloud webhooks, and any retrying outbound transport.


Use these in core logic instead of naked `threadId` + `channel`. Since the project is pre-release, prefer updating schema/runtime together over preserving ambiguous aliases.

### Actor and principal model

```ts
interface ActorRef {
  provider: TransportProviderId;
  install?: TransportInstallRef;
  id: string;
  displayName?: string;
  kind: "human" | "bot" | "agent" | "system";
}

interface PrincipalRef {
  kind: "transport-actor" | "pinet-agent" | "operator" | "system";
  id: string;
  actor?: ActorRef;
  install?: TransportInstallRef;
  instance?: PinetInstanceRef;
  scopes?: RuntimeScopeCarrier[]; // migration/projection helper, not the long-term auth primitive
}
```

Actors are message authors. Principals are authorization subjects. They should not be collapsed.

### Content model

For #403, add normalized content with text fallbacks:

```ts
interface MessageContent {
  kind: "plain" | "markdown" | "rich";
  text: string;              // safe fallback projection
  markdown?: string;         // canonical Markdown projection when available
  rich?: RichContentNode[];   // optional AST for links/code/lists/mentions
  transportNative?: Record<string, unknown>;
}
```

Then adapters implement render/parse:

```ts
interface TransportRenderer {
  render(content: MessageContent, target: ConversationRef): RenderedTransportMessage;
}

interface TransportParser {
  parse(native: unknown, fallbackText: string): MessageContent;
}
```

Avoid making Slack `mrkdwn` the canonical string.

### Capabilities

```ts
interface TransportCapabilities {
  inbound: boolean;
  outbound: boolean;
  historyRead: boolean;
  reactions: boolean;
  files: boolean;
  modals: boolean;
  scheduledSend: boolean;
  threadContinuations: boolean;
  deliveryReceipts: "none" | "attempted" | "confirmed";
}
```

iMessage MVP should advertise `outbound: true`, `inbound: false`, `historyRead: false` until those are real.

### Adapter v2

```ts
interface TransportAdapterV2 {
  provider: TransportProviderId;
  install: TransportInstallRef;
  capabilities: TransportCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInbound(handler: (message: TransportInboundEnvelope) => void): void;
  send(message: TransportOutboundEnvelope): Promise<TransportDeliveryReceipt>;
  read?(query: TransportReadQuery): Promise<TransportReadResult>;
  callNative?(request: TransportNativeCall): Promise<unknown>;
}
```

`callNative` should be optional, off by default, unavailable to remote/non-local clients unless explicitly authorized, and policy-gated per provider/action. Prefer a typed native-action registry with advertised capabilities over arbitrary method strings. Every native call should produce an audit entry. This replaces `slack.proxy`; do not keep Slack-named RPC in broker-core or recreate it as an unrestricted provider-neutral bypass.

### Native action registry

If an adapter needs provider-native operations that do not fit the normalized message/read/reaction/file surfaces, expose them through a typed native-action registry rather than a stringly `method` proxy.

```ts
type NativeActionName = `${TransportProviderId}.${string}`;

type NativeActionLocality = "local-only" | "daemon-local" | "remote-capable";

type NativeActionRisk = "read" | "write" | "admin" | "destructive";

interface NativeActionDescriptor<Input, Output> {
  name: NativeActionName;
  provider: TransportProviderId;
  capability: string;
  risk: NativeActionRisk;
  locality: NativeActionLocality;
  inputSchema: unknown;
  outputSchema: unknown;
  idempotency: "required" | "supported" | "not-supported";
  audit: "required";
  execute(input: Input, context: NativeActionContext): Promise<Output>;
}

interface NativeActionContext {
  principal: PrincipalRef;
  install: TransportInstallRef;
  instance: PinetInstanceRef;
  conversation?: ConversationRef;
  idempotencyKey?: string;
  reason?: string;
}

interface NativeActionRequest {
  action: NativeActionName;
  provider: TransportProviderId;
  install: TransportInstallRef;
  input: unknown;
  idempotencyKey?: string;
  reason?: string;
}

interface NativeActionReceipt {
  action: NativeActionName;
  provider: TransportProviderId;
  status: "succeeded" | "failed";
  auditId: string;
  retryable: boolean;
}
```

Rules:

1. no arbitrary provider method strings in broker-core;
2. every native action must be declared by the adapter with schemas, risk level, locality, and idempotency semantics;
3. write/admin/destructive actions require explicit policy authorization and audit logging;
4. `remote-capable` actions require the #324 credential model and the #325 remote transport security story;
5. action names are provider-qualified (`slack.canvas_update`, `slack.modal_open`) so guardrails can remain precise;
6. normalized Pinet operations should not be implemented as native actions just because it is faster.

This gives adapter packages room for real provider features without making the broker a generic privileged API tunnel.

## Broker DB and persistence audit

Current broker DB tables include:

- `agents`
- `threads`
- `messages`
- `inbox`
- `unrouted_backlog`
- `settings`
- `task_assignments`
- `scheduled_wakeups`

This is a good base for #594, but the schema is still thread/source/channel shaped:

```text
threads(thread_id, source, channel, owner_agent, owner_binding, ...)
messages(thread_id, source, direction, sender, body, metadata, ...)
```

Recommended migration path:

1. design the clean conversation/message schema around `ConversationRef` and `MessageRef`;
2. update broker runtime and tests to use structured addresses;
3. keep a temporary import/migration helper only if existing local dev DBs need a one-time conversion;
4. remove Slack-default columns/assumptions from new code.

A broad DB cleanup is acceptable because this is pre-release.

For #594, do not jump straight to semantic memory. First build a durable event/context log with unread cursors:

```text
transport_events       raw/normalized messages from Slack/Pinet/iMessage/cloud
conversation_cursors   per-agent/per-principal unread/read state
conversation_links     continuations and cross-transport references
context_summaries      optional later summarization artifacts
```

This gives agents compact pointers and explicit reads without stuffing every thread into every prompt. Do not start this schema ahead of the Phase 2 address contracts; otherwise #594 will entrench the old `threadId`/`channel` shape that the refactor is trying to retire.

This durable event log is also the right home for #538. Messages from unauthorized Slack users should be stored as contextual events with actor metadata, but they must not become executable commands unless an authorized principal re-engages and policy explicitly permits the action. That framing preserves team context without weakening the command boundary.

## Tool and agent-DX audit

### Pinet tools

The current four Pinet tools are a reasonable hot surface:

| Tool | Keep? | Notes |
| --- | --- | --- |
| `pinet_agents` | Keep hot | High-frequency routing/status lookup |
| `pinet_message` | Keep hot | Core delegation/A2A primitive; needs clearer split from admin/control payloads |
| `pinet_free` | Keep hot | Important lifecycle signal |
| `pinet_schedule` | Keep hot | Useful non-blocking wakeups |

Potential near-future addition from #594/#601:

- `pinet_read` or dispatcher-style `pinet` action for durable context reads.

If adding read, avoid growing the hot surface blindly. Preferred shape is either:

```text
pinet_read              if it becomes a truly hot per-turn primitive
```

or:

```text
pinet { action: "read" | "send" | "agents" | "schedule" | "help" }
```

The repo currently has a design decision in #554 to keep four explicit Pinet tools. If #601 lands, update #554’s wording because the surface becomes five tools.

### Slack tools

Slack has already moved toward progressive disclosure with `slack_send`, `slack_inbox`, and `slack` dispatcher. That is aligned with #588. Remaining risk is less about count and more about keeping examples/templates out of hot schemas and ensuring structured dispatcher responses remain consistent.

### iMessage tool

`imessage_send` under `slack-bridge` is a transitional smell. Prefer generic Pinet send/read surfaces plus transport-specific adapter capabilities. If a direct `imessage_send` tool remains, it should live in `imessage-bridge`, not Slack bridge.

## Security audit for future cloud/multi-host

The following are blockers before treating Pinet as cloud/multi-host-safe:

### #322 — core tool guardrails cannot remain prompt-only

Slack-triggered safety settings must be runtime-enforced for core tools and transport-originated turns. The README says runtime enforcement exists, but #322 remains open and should be verified before any remote/cloud expansion.

Requirement: origin-aware policy must wrap actual tool execution, not just prompt guidance.

### #324 — stable ID takeover

Authenticated mesh clients can currently present stable IDs. This makes stable ID both a resumable handle and an unauthenticated client input. In a shared-secret mesh, that effectively creates a superuser realm.

Requirement: resumable identity should be bound to broker-issued credentials, signed leases, or another verifiable proof. Do not let clients claim arbitrary stable IDs.

### #325 — raw TCP is not remote-safe

Current TCP support is raw `net` sockets plus optional shared secret. This is fine for local/test paths but not for multi-host/cloud mesh.

Requirement: remote transport needs mTLS, SSH/WireGuard/Tailscale boundary, or another mutually authenticated confidential channel with rotation/revocation semantics.

### Scoped auth before multi-workspace

For #480/#481/#547/#548/#549/#550, authorization must be scoped by:

- transport provider;
- workspace/install;
- Pinet instance;
- actor/principal;
- action kind;
- target conversation/resource.

Do not add multi-workspace orchestration without enforcement or it will be hard to reason about cross-workspace leaks.

## Open PR triage

Open PRs at audit time:

| PR | Title | Status | Recommendation |
| --- | --- | --- | --- |
| #601 | `feat(pinet): add durable inbox read tool` | mergeable | Aligns with #594; review carefully against #554/tool-surface decision |
| #600 | `fix(slack-bridge): warn on unverified pinet_free delivery claims` | mergeable | Safe reliability/UX lane; likely independent |
| #599 | `fix(transport): salvage outbound content rendering` | mergeable | Important for #403; likely should land before deeper content refactor if reviewed |
| #598 | `fix(slack-bridge): cap retryable stableId reconnect conflicts` | mergeable | Useful mitigation, but not a full #324 fix |
| #580 | `fix(slack-bridge): preserve continued Slack thread association` | conflicting | Important for #575; should be rebased/salvaged before major transport refactor |
| #570 | `feat: orchestrate scoped Slack broker installs` | changes requested/conflicting | Restack or close; do not preserve compatibility-shaped orchestration if Pinet becomes the composition owner |
| #568 | `feat: enforce scoped slack authorization boundaries` | changes requested/mergeable | Salvage the policy ideas, but adapt them to provider/install/instance principals rather than Slack-owned runtime shape |
| #567 | `feat: add slack install topology compatibility plumbing` | mergeable | Salvage useful scope-carrier pieces, but do not land long-lived compatibility plumbing that reinforces Slack as runtime owner |

Recommended order:

1. Land or explicitly close #599, #600, #598 if review confirms narrowness.
2. Rebase/salvage #580 because thread continuation affects durable conversation identity, but avoid landing it in a way that entrenches the old `threads.source`/`threads.channel` schema if Phase 2 address contracts are imminent.
3. Restack or close #567/#568/#570 around the clean-slate Pinet-owned topology; do not treat the existing Slack-owner stack as the foundation by default.
4. Treat #601 as a product/tool-surface decision: either bless `pinet_read` as hot or move toward a dispatcher/unified read action.

## Issue dependency map

### Foundation and cleanup

- #264 split `slack-bridge/index.ts` god file
- #472 dead/stale surface review
- #551 delete broker-core/transport-core compatibility shims
- #552 remove startup aliases `autoConnect`/`autoFollow`
- #553 clarify or implement dormant `pinet-core`
- #556 prompt overlay deduplication
- #588 tool-surface audit

### Transport/content/context

- #373 iMessage through shared messaging core
- #403 transport-aware rendering/parsing
- #464 WhatsApp/iMessage transport strategy
- #575 Slack max-thread continuation association
- #594 durable context sync and read/send tools

### Scope/multi-workspace/instance

- #480 multi-workspace Slack operation
- #481 authorization model
- #482 named Pinet instance identity
- #547 enforcement
- #548 operator/admin action scope
- #549 topology model and compatibility plumbing
- #550 multi-workspace runtime orchestration

### Broker/runtime reliability

- #406 broker-managed worker spawn
- #582 steering vs follow-up classification
- #596 reload/error visibility salvage
- #341 Ralph stuck alerts overfire
- #275 disconnected-agent purge grace

### Security blockers

- #322 core guardrail enforcement
- #324 stable ID takeover
- #325 remote TCP transport security


## Appendix: full open issue coverage

This audit enumerated all 47 open issues. The main body focuses on issues that directly affect the Pinet/Slack split, transport contracts, broker runtime, context sync, and security. The full issue coverage is below so later readers can see which issues are core to the refactor, which should be sequenced nearby, and which are mostly orthogonal.

| Issue | Relevance to this refactor | Recommendation |
| --- | --- | --- |
| #596 broker reload/error visibility | Runtime reliability | Fold narrowed reload/control reliability into Pinet-core remote-control work after ownership split. |
| #595 compaction budgets/summarization | Adjacent agent runtime context | Keep separate; durable read/context pointers from #594 should reduce prompt pressure but this is mostly Pi core behavior. |
| #594 durable context sync/read-send | Core | Treat as a major Pinet data-layer outcome after transport address/content contracts exist. |
| #588 tool footprint audit | Core DX | Use as guardrail for Pinet/Slack tool reshape; avoid bloating hot tool schemas. |
| #585 Turbo setup | Repo process | Orthogonal; still important before broad refactor validation because all phases rely on repo-level checks. |
| #582 steering vs follow-up classification | Core runtime | Add as Pinet-core delivery policy, not Slack-specific inbox behavior. |
| #578 slop PR audit | Repo process | Use when deciding whether to land/close existing PR stack before refactor. |
| #577 Thomas PR salvage | Repo process / source material | Relevant mainly for #599/#600/#598/#596 salvage; not a runtime architecture blocker. |
| #575 Slack max-thread association | Core conversation model | Important because continuation links should become first-class `ConversationRef` data. |
| #574 researcher skill override | Adjacent agent orchestration | Mostly outside transport split; could later inform worker capability metadata/routing. |
| #572 protect main | Repo governance | Orthogonal but useful before large breaking PRs start landing. |
| #560 neon-psql security boundary | Repo security | Orthogonal to Pinet transport, but consistent with the broader rule: separate read-only surfaces from credential-bearing write/exec surfaces. |
| #557 browser structured args/capabilities | Agent-DX precedent | Use as a pattern for truthful capabilities in transport adapters; otherwise orthogonal. |
| #556 prompt overlay dedupe | Core DX | Move durable Pinet role guidance into Pinet-core; keep Slack-origin snippets adapter-owned. |
| #555 prompt-guidelines digest | Adjacent DX | Should inform Pinet prompt-guidance extraction and prevent copying Slack prompt sprawl into core. |
| #554 Pinet tool role split | Core DX | Revisit once #601/tool-surface decision is made; pre-release allows bigger rename/reshape if warranted. |
| #553 dormant pinet-core docs | Core | Superseded by making Pinet core/composition real rather than marking scaffold as dormant. |
| #552 remove startup aliases | Core cleanup | Delete `autoConnect`/`autoFollow` during clean-slate settings move. |
| #551 delete compatibility shims | Core cleanup | Do early; no reason to preserve Slack-owned broker/transport shim paths pre-release. |
| #550 multi-workspace orchestration | Core/Slack adapter | Restack around Pinet-owned transport registry; avoid Slack-owned runtime orchestration. |
| #549 multi-workspace topology | Core contracts | Fold into provider/install/scope contracts in transport-core. |
| #548 operator/admin scopes | Core security/UX | Model as Pinet policy over provider/install/instance/action, with Slack UI as one origin. |
| #547 scoped authorization enforcement | Core security | Implement after scope model; should be provider-neutral with Slack-specific policy source. |
| #538 queued unauthorized thread context | Context/security | Reframe under durable context log: unauthorized messages can be stored as context but not commands, with explicit principal/action policy. |
| #482 named Pinet instance | Core identity | First-class in new `pinet.*` settings and runtime scope. |
| #481 authorization model | Core security | Required before multi-workspace/multi-instance expansion. |
| #480 multi-workspace Slack | Slack adapter + core scope | Support through transport registry and install refs rather than Slack-owned broker globals. |
| #474 prompt layering vs override | Adjacent runtime prompt architecture | Relevant when extracting prompt guidance; keep separate from transport contracts. |
| #472 dead/stale surface review | Cleanup | This audit identifies several stale surfaces; still useful as a broader repo cleanup lane. |
| #471 strict security review | Security | Should be run before cloud/multi-host; complementary to #322/#324/#325. |
| #470 broker prompt override sourcing | Prompt architecture | Relevant to Pinet prompt-guidance extraction; not a transport blocker. |
| #469 code-quality comparison | Repo quality | Orthogonal but useful as a review lens for the large refactor. |
| #464 WhatsApp/iMessage strategy | Transport roadmap | Keep as design follow-up after iMessage becomes a normal adapter. |
| #460 slack_upload scope bug | Slack adapter bug | Stays in Slack adapter; not core. |
| #406 broker-managed worker spawn | Pinet orchestration | Later Pinet-core/daemon concern once broker ownership is clean. |
| #403 transport-aware rendering/parsing | Core transport/content | Critical input to the new `MessageContent` model. |
| #386 canvas update intermittent failure | Slack UX bug | Stays in Slack adapter/control-plane publisher. |
| #373 iMessage shared core wiring | Transport adapter | Directly enabled by moving runtime ownership out of Slack. |
| #364 release cadence | Release process | Orthogonal while pre-release; revisit after package boundaries settle. |
| #341 Ralph stuck alerts | Runtime reliability | Move Ralph evaluation to Pinet-core and fix there. |
| #330 browser local-dev ergonomics | Browser package | Orthogonal. |
| #325 remote TCP unsafe | Security blocker | Hard blocker for cloud/multi-host Pinet. |
| #324 stableId takeover | Security blocker | Hard blocker for trustworthy mesh identity. |
| #322 guardrails advisory | Security blocker | Verify/enforce before remote/cloud transport expansion. |
| #293 Slack canvas read API validation | Slack UX/API | Slack adapter only; not part of Pinet core. |
| #275 disconnected-agent purge grace | Runtime reliability | Fold into Pinet-core liveness/reaping policy. |
| #264 split Slack bridge god file | Structural | Superseded by stronger clean-slate Pinet-owned package split, but still directionally aligned. |

## Cleanup discipline during the refactor

The clean-slate stance only works if the refactor actively removes old paths as it creates new ones. Each implementation slice should therefore include a cleanup checklist, not just new abstractions.

Required cleanup rules:

1. **No duplicate owner modules** — when a responsibility moves to `transport-core`, `broker-core`, `pinet-core`, or `pinet-extension`, delete or shrink the old Slack-owned implementation in the same PR unless a short-lived transition wrapper is explicitly documented.
2. **No permanent compatibility shims** — temporary wrappers must have a named deletion issue/phase and should be avoided entirely where the code is not published or user-facing.
3. **No dead settings** — remove `autoConnect`, `autoFollow`, Slack-default runtime settings, and unused `slack-bridge.*` Pinet settings as the new `pinet.*` config lands.
4. **No stale tests** — move tests with code, delete tests for removed behavior, and add regression tests for new ownership boundaries.
5. **No unused exports** — every package boundary change should include an import/export scan and removal of orphaned exports.
6. **No duplicated prompts/tool guidance** — keep durable Pinet role guidance in Pinet-owned prompt modules and adapter-specific guidance in adapter packages; do not copy the same instruction into tools, prompts, README, and helper strings.
7. **No split-brain runtime paths** — after Pinet owns runtime composition, Slack should not retain a second broker/follower startup path except single-player Slack mode if deliberately kept.
8. **Delete before daemonizing** — do not start daemon work while stale in-extension broker ownership paths still exist.

Suggested per-PR hygiene checks:

```bash
rg -g '!**/*.test.ts' "autoConnect|autoFollow|slack\.proxy|source = \"slack\"|source \?\? \"slack\""
rg -g '!**/*.test.ts' "from \"\.\/broker\/(agent-messaging|auth|leader|maintenance|message-send|paths|raw-tcp-loopback|router|types)"
rg -g '!**/*.test.ts' "TODO|compatibility|legacy|deprecated" <touched packages>
```

These checks should not be treated as a substitute for tests, but they make accidental compatibility residue visible during review.

## Recommended migration plan

### Phase 0 — settle runway and write contracts

Deliverables:

- this audit;
- explicit v2 transport interface sketch in `transport-core` docs or issue;
- clear decision on #601 tool surface;
- PR stack decision for #567/#568/#570;
- rebase/salvage #580 if valuable.

Do not move runtime files before the new contracts exist. Once they do, prefer decisive moves over prolonged compatibility scaffolding.

### Phase 1 — split `helpers.ts` and remove shims

Deliverables:

- split Slack config/http/policy helpers from Pinet identity/runtime helpers;
- rewrite imports away from pure `slack-bridge/broker/*` compatibility shims (#551);
- delete pure shims after imports point to `broker-core`/`transport-core`;
- avoid unrelated feature expansion, but remove legacy aliases/defaults deliberately when the new contract is covered by tests.

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

### Phase 2 — deepen `transport-core`

Deliverables:

- add provider/install/conversation/message/actor/content/capability types;
- replace v1 `InboundMessage`/`OutboundMessage` usage in core paths where practical;
- add render/parse interfaces but do not force every adapter to implement everything;
- test v2 address/content/capability helpers and any temporary v1 projection helpers.

Validation focus:

- transport-core tests;
- broker-core compile impact;
- Slack/iMessage adapters still compile.

### Phase 3 — move broker socket/client/bootstrap into `broker-core`

Deliverables:

- move `BrokerClient`, `BrokerSocketServer`, and `startBroker` to `broker-core`;
- delete `slack.proxy` from broker-core paths and replace it with a neutral optional adapter proxy only if needed;
- keep local Unix socket support, but without Slack-specific RPC naming;
- document raw TCP as local/test-only until #325 is solved.

Validation focus:

- broker socket/client tests;
- follower reconnect tests;
- message.send tests.

### Phase 4 — port-drive `broker-runtime.ts`

Before moving the file, refactor it in place so it depends on ports:

```ts
interface TransportRegistryPort { ... }
interface RuntimeSettingsPort { ... }
interface ActivityLogPort { ... }
interface ControlPlanePublisherPort { ... }
interface HomeSurfacePublisherPort { ... }
interface OriginPolicyPort { ... }
interface ThreadAssociationPort { ... }
interface RuntimeUiPort { ... }
```

Remove direct construction of `SlackAdapter` from broker runtime. `slack-bridge/index.ts` should create/configure Slack adapters and pass factories/instances in.

### Phase 5 — extract `pinet-core`

Move modules only after imports are clean:

- broker/follower runtime;
- broker/follower delivery;
- inbox drain;
- persisted runtime state;
- session UI runtime through UI port;
- Pinet tools/commands registration helpers;
- mesh ops;
- remote control;
- registration gate;
- Ralph loop;
- scheduled wakeups;
- task assignments;
- agent status/activity formatting;
- prompt/event runtime behind origin-specific policy/prompt ports.

`slack-bridge/index.ts` becomes a thin composer.

### Phase 6 — make iMessage a normal transport

Deliverables:

- register iMessage adapter through the same transport registry as Slack;
- remove Slack-owned `imessage_send` or move it into `imessage-bridge`;
- route outbound iMessage via generic Pinet send/message primitive;
- advertise capabilities truthfully.

Phase 6 should still ship iMessage as send-first. Reading from Messages history/SQLite is a separate later track with its own macOS permission and privacy design (#464).

### Phase 7 — durable read/context sync

Deliver #594 after the address/content model is ready:

- persisted event log;
- unread cursors;
- explicit `pinet_read` or discoverable read action;
- bounded summaries/pointers in prompts;
- no embeddings/semantic memory in first slice.

### Phase 8 — daemonization

Only after package boundaries are real:

- daemon owns DB/socket/transport adapters/Ralph/scheduler;
- Slack bridge becomes a Slack adapter/UX package, not infrastructure owner;
- worker/follower sessions connect to daemon-owned broker;
- observability and health contracts are first-class.

Re-read `plans/420-broker-daemon-prd.md` against this Pinet-owned topology before daemon implementation starts. That PRD currently assumes a migration path from the Slack-owned extension world; the process model remains useful, but the composition owner changes.

## File destination map

### Stay in `slack-bridge`

- Slack Socket Mode/API/access: `slack-access.ts`, `slack-api.ts`, `slack-request-runtime.ts`, `broker/adapters/slack.ts`
- Slack user experience: `slack-tools.ts`, `slack-modals.ts`, `slack-upload.ts`, `slack-export.ts`, `slack-presence.ts`, `slack-block-kit.ts`
- Slack surfaces: `home-tab.ts`, `pinet-home-tabs.ts`, `pinet-control-plane-canvas.ts`, `canvases.ts`
- Slack policy/prompt sources: `guardrails.ts`, `slack-tool-policy-runtime.ts`, `slack-turn-guardrails.ts`, `reaction-triggers.ts`, `thread-confirmations.ts`
- single-player mode: `single-player-runtime.ts`
- manifest/deployment: `manifest.yaml`, `deploy-manifest.ts`
- composition root: `index.ts` after slimming

### Move to `broker-core`

- `broker/client.ts`
- `broker/socket-server.ts`
- `broker/index.ts`
- remaining non-Slack broker protocol types if not already there

### Delete pure `slack-bridge/broker/*` shims

These are pure re-export shims and should disappear once imports are rewritten:

- `broker/agent-messaging.ts`
- `broker/auth.ts`
- `broker/leader.ts`
- `broker/maintenance.ts`
- `broker/message-send.ts`
- `broker/paths.ts`
- `broker/raw-tcp-loopback.ts`
- `broker/router.ts`
- `broker/types.ts`

Do **not** treat `broker/schema.ts` as part of that mechanical deletion set. It is not a pure shim today; it extends the core broker DB with Ralph-cycle behavior and needs a real destination decision, likely Pinet core.

### Move to `pinet-core` after ports are extracted

- `agent-completion-runtime.ts`
- `agent-event-runtime.ts`
- `agent-prompt-guidance.ts`
- `broker-delivery.ts`
- `broker-runtime-access.ts`
- `broker-runtime.ts`
- `command-registration-runtime.ts`
- `follower-delivery.ts`
- `follower-runtime.ts`
- `git-metadata.ts`
- `inbox-drain-runtime.ts`
- `persisted-runtime-state.ts`
- `pinet-activity-formatting.ts`
- `pinet-agent-status.ts`
- `pinet-commands.ts`
- `pinet-maintenance-delivery.ts`
- `pinet-mesh-ops.ts`
- `pinet-registration-gate.ts`
- `pinet-remote-control.ts`
- `pinet-remote-control-acks.ts`
- `pinet-skin.ts`
- `pinet-tools.ts`
- `ralph-loop.ts`
- `scheduled-wakeups.ts`
- `session-ui-runtime.ts`
- `task-assignments.ts`
- `ttl-cache.ts`

### Split before moving

- `helpers.ts`
- `runtime-agent-context.ts`
- `tool-registration-runtime.ts`
- `broker/control-plane-canvas.ts`
- parts of `broker-core/schema.ts` if Pinet-specific maintenance/task tables should separate from broker-neutral base

## Test strategy

### General rule

Move tests with source files. Add port-contract tests before moving large runtime modules.

### Minimum test additions before extraction

1. transport v1/v2 projection tests;
2. adapter capability tests for Slack and iMessage;
3. broker `message.send` with source/address metadata;
4. broker socket neutral adapter proxy tests, plus regression coverage proving Slack-named RPC is gone from broker-core;
5. broker runtime with fake transport registry, no Slack imports;
6. Ralph loop with fake publisher ports;
7. Pinet tool registration with fake policy port;
8. iMessage routing through generic send path;
9. scoped auth tests once #547 begins;
10. stable ID resumption/impersonation regression tests for #324.

### Validation commands

For broad/shared refactor PRs, use repo-level Turbo commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Use package filters only for inner-loop checks.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Big-bang file move causes unreviewable PR | High | High | Contract-first phases; split helpers first |
| Settings/package renames break existing local setups | Medium | Low pre-release | Rename now; document the new `pinet.*` shape and provide optional one-time notes, not long-term compatibility |
| `pinet-core` imports Pi SDK too deeply | Medium | Medium | Allow Pi SDK only at registration/UI adapter ports, not core algorithms |
| Transport v2 overdesign delays practical progress | Medium | Medium | Add v2 beside v1; migrate only where needed |
| Multi-workspace stack races runtime extraction | High | High | Decide #567/#568/#570 before extraction |
| Security assumptions leak into cloud | High | Critical | Block cloud/multi-host on #322/#324/#325 |
| Durable context log becomes semantic-memory project | Medium | Medium | Start with raw event log + cursors only |
| Tool-surface churn confuses agents | Medium | Medium | Keep four Pinet tools unless #601 is explicitly accepted |
| Doc-on-doc drift misleads implementers | High | Medium | Mark superseded plans explicitly and keep one current architecture truth |
| Ports become Slack-shaped god interfaces | Medium | High | Keep ports narrow and require non-Slack fake tests before Slack implementations land |

## Non-goals for the first refactor wave

- no daemon implementation yet;
- no remote/cloud mesh transport yet;
- no long-term compatibility layer for old `slack-bridge.*` settings;
- no preservation of Slack-owned Pinet package boundaries;
- no broad Slack UX redesign;
- no semantic memory/embedding pipeline;
- no WhatsApp implementation;
- no multi-host raw TCP enablement;
- no collapse of Slack and Pinet tools into one universal tool unless separately designed.

## Phase 0.5 clean-slate first PR blueprint

Given the pre-release/no-backward-compatibility stance, the first implementation PR should set the new house foundation explicitly rather than quietly preparing `slack-bridge` internals. This should be a structural seed, not a big-bang runtime migration: define enough transport/config contracts to make ownership clear, wire fake/test adapters first, and move behavior only where the new boundary has tests.

Recommended first PR scope:

1. create a first-class Pinet composition surface:
   - either `pinet-extension/`, or `pinet-core/extension.ts` exported as `@gugu910/pi-pinet-core/extension`;
   - register Pinet tools/commands from that surface, not from Slack-owned `tool-registration-runtime.ts`;
   - load `pinet.*` settings, not `slack-bridge.*` settings;
2. turn `slack-bridge/tool-registration-runtime.ts` into Slack-only registration or delete it during extraction;
3. move iMessage registration out of Slack-owned runtime entirely;
4. introduce `TransportRegistry` and register Slack/iMessage adapters through it;
5. add the `pinet.*` settings envelope and adapter config validation hook;
6. add the typed native-action registry contract with no runtime actions enabled by default;
7. add the `broker-runtime.ts` adapter-factory port and test it with non-Slack fakes, even if the implementation still lives in `slack-bridge` for one PR;
8. delete `autoConnect`/`autoFollow` and Slack-default source fallbacks in the same wave if tests are updated;
9. update README/plans so the public mental model is “install/enable Pinet, configure transports,” not “install Slack bridge and get Pinet as a side effect.”

This is a better first slice than a pure helper split because it makes the future ownership model visible immediately. The helper split can happen inside or directly after this PR.

## Recommended next implementation issues

If this audit is accepted, open or update focused issues for:

1. `transport-core`: replace shallow message contracts with address/content/capability contracts and temporary v1 projections only where useful.
2. `pinet-core` / `pinet-extension`: land the `pinet.*` settings schema envelope and adapter-owned transport config validation contract.
3. `transport-core` / `broker-core`: add the typed native-action registry contract, replacing arbitrary `slack.proxy`-style provider tunnels.
4. `slack-bridge` + `pinet-core`: split `helpers.ts` into Slack settings/http/policy and Pinet identity/runtime helpers.
5. `broker-core`: move broker client/server/bootstrap down and delete Slack-specific adapter proxy naming.
6. `pinet-core` / new `pinet-extension`: refactor `broker-runtime.ts` to receive a transport registry and publisher ports, then make Pinet the composition owner.
7. `pinet-core`: move Pinet runtime modules after port extraction.
8. `imessage-bridge`: wire as ordinary adapter through generic transport registry and retire Slack-owned iMessage tool registration.
9. `broker-core`/`pinet-core`: durable context event log + unread cursors for #594.
10. `security`: stable ID resumption credential model for #324.
11. `security`: remote transport threat model and implementation path for #325.
12. `policy`: scoped origin/action authorization model for #481/#547/#548.
13. `pinet-daemon`: update and later implement the daemon PRD against the Pinet-owned topology.

## Final recommendation

Proceed with a substantial breaking refactor. Because the repo is pre-release, optimize for the clean long-term architecture rather than minimizing migration churn.

The highest-leverage first coding slice is to create the first-class Pinet composition surface and make `broker-runtime.ts` stop knowing about Slack by introducing transport and publisher ports. Splitting `helpers.ts` remains necessary, but it should serve the bigger goal: Pinet owns runtime; Slack and iMessage plug in.

Once that is done, `pinet-core` and a first-class Pinet composition entrypoint can become real without leaving Slack as the hidden runtime owner. Pinet can then support Slack, iMessage, and future cloud transports through one broker/control-plane model.
