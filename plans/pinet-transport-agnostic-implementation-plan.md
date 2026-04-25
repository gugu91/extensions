# Pinet transport-agnostic implementation plan

- Status: execution plan
- Source architecture: `plans/pinet-transport-agnostic-refactor-audit.md`
- Daemon source PRD: `plans/420-broker-daemon-prd.md`
- Compatibility stance: pre-release clean-slate; breaking changes are allowed and expected

## Execution contract

This plan is not a menu. Execute every phase and every required task in order unless a later PR updates this document with an explicit replacement plan.

Rules for every implementation PR:

1. **One owner per responsibility** — when ownership moves to `transport-core`, `broker-core`, `pinet-core`, `pinet-extension`, or an adapter package, delete or shrink the old path in the same PR.
2. **No permanent compatibility shims** — short-lived wrappers are allowed only when the PR names the deletion phase and includes tests proving both the new path and deletion target.
3. **No Slack-shaped core contracts** — core packages must not use Slack-specific names for sources, principals, conversations, proxy methods, settings, or default values.
4. **No untested boundary moves** — each package-boundary move must add or move tests with the code.
5. **No daemon work before ownership is clean** — daemon implementation starts only after Pinet owns runtime composition and broker-core owns local broker socket/client/bootstrap.
6. **No remote/cloud enablement before security gates** — remote-capable transports and native actions are blocked until stable identity, scoped auth, and remote transport security are implemented.
7. **Each PR ends with cleanup checks** — run the hygiene searches in the audit and remove dead settings, exports, tests, prompts, and wrappers.

Baseline validation for implementation PRs:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Use package-filtered commands for inner-loop work, but the merge gate is repo-level validation unless a PR documents a temporary infra blocker.

## Final target state

At the end of this plan:

- Pinet is a first-class runtime/composition package, not an accidental mode inside `slack-bridge`.
- Slack, iMessage, and future cloud providers are transport adapters registered with Pinet.
- `transport-core` owns provider/install/conversation/message/content/capability contracts and the typed native-action registry.
- `broker-core` owns broker-neutral routing, local socket/client/bootstrap, DB base schema, auth primitives, and message delivery primitives.
- `pinet-core` owns Pinet runtime logic: broker/follower runtime, Ralph, maintenance, wakeups, task assignment, remote control, prompt guidance, agent status, and tool/command registration helpers behind ports.
- `pinet-extension` owns Pi SDK registration, Pi UI/confirmation/persistence integration, settings ingestion, and adapter composition.
- `slack-bridge` owns Slack API/socket access, Slack UX surfaces, Slack policy sources, Slack tools, Slack adapter factory, and single-player Slack mode if deliberately retained.
- `imessage-bridge` owns iMessage adapter access and iMessage-specific validation/capabilities.
- The daemon hosts Pinet runtime and adapter registry through the SDK-first architecture described in `plans/420-broker-daemon-prd.md`.

## Phase 0 — runway, branch discipline, and PR stack reset

Goal: start from a stable, clean-slate base so the refactor does not inherit compatibility-first work that conflicts with the target topology.

Required tasks:

1. Confirm work happens in a non-`main` branch/worktree.
2. Install dependencies and establish current validation baseline.
3. Review open PRs against the clean-slate architecture:
   - land or close narrow independent fixes: #599, #600, #598;
   - rebase/salvage #580 only if it does not entrench old `threads.source` / `threads.channel` shape;
   - restack or close #567, #568, #570 around Pinet-owned transport registry and provider/install principals;
   - decide #601 tool surface before durable read/context implementation.
4. Create tracking issues or task list entries for each phase in this plan.
5. Mark `plans/slack-split-proposal.md` as historical/superseded for implementation sequencing, keeping useful file inventory only.

Definition of done:

- repo validates or blockers are documented;
- conflicting PR stack is resolved;
- implementation issues match the phases below;
- no implementation has started from a stale Slack-owned topology.

Validation:

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

## Phase 1 — settings envelope and adapter config contract

Goal: make the future runtime composition visible before moving runtime files.

Required tasks:

1. Add a Pinet-owned settings module, likely in `pinet-core` or `pinet-extension`, with the `pinet.*` envelope:
   - `runtimeMode`;
   - `instance`;
   - `mesh`;
   - `broker`;
   - `transports`;
   - `tools`;
   - `security`;
   - `observability`.
2. Add adapter config validation contract:
   - Pinet validates envelope and provider key presence;
   - adapter packages validate values under `transports.<provider>`;
   - unknown provider keys fail closed unless a factory/plugin is explicitly configured.
3. Add Slack transport settings validator in `slack-bridge`.
4. Add iMessage transport settings validator in `imessage-bridge`.
5. Delete or replace `autoConnect`, `autoFollow`, and Slack-owned Pinet runtime setting names where the new envelope covers them.
6. Add docs/examples showing `pinet.transports.slack` and `pinet.transports.imessage`.

Definition of done:

- no runtime-mode behavior depends on `slack-bridge.*` Pinet settings;
- config parsing tests cover valid settings, missing adapter config, unknown provider, and invalid Slack/iMessage config;
- old startup aliases are deleted, not preserved as long-lived compatibility paths.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-slack-bridge test
pnpm --filter @gugu910/pi-imessage-bridge test
pnpm lint
pnpm typecheck
pnpm test
```

Cleanup checks:

```bash
rg -g '!**/*.test.ts' 'autoConnect|autoFollow|slack-bridge\.|source = "slack"|source \?\? "slack"'
```

## Phase 2 — transport-core v2 contracts

Goal: replace the shallow transport abstraction with the provider-neutral contracts required for Slack, iMessage, and future cloud surfaces.

Required tasks:

1. Add transport identity types:
   - `TransportProviderId`;
   - `TransportInstallRef`;
   - `TransportScopeRef`;
   - `PinetInstanceRef`.
2. Add conversation/message address types:
   - `ConversationRef`;
   - `MessageRef`;
   - provider-specific opaque address data where needed.
3. Add actor/principal model:
   - `ActorRef`;
   - `PrincipalRef` with generic `transport-actor`, not `slack-user`.
4. Add content model:
   - text;
   - mrkdwn/Slack-rich text as adapter-owned representation;
   - attachments/files;
   - provider-native references;
   - parse/render interfaces.
5. Add capabilities model:
   - send;
   - read;
   - react;
   - upload;
   - modal/canvas/provider-native capabilities;
   - locality and security flags.
6. Add v1/v2 projection helpers only where needed for incremental migration.
7. Update Slack and iMessage adapters enough to advertise truthful capabilities.
8. Add tests for identity, address, content, capability, and projection helpers.

Definition of done:

- core contracts no longer require Slack-specific fields for ordinary message flow;
- transport adapters can identify provider/install/conversation/message/principal distinctly;
- tests prove v2 contracts work without Slack fixtures.

Validation:

```bash
pnpm --filter @gugu910/pi-transport-core test
pnpm --filter @gugu910/pi-broker-core typecheck
pnpm --filter @gugu910/pi-slack-bridge typecheck
pnpm --filter @gugu910/pi-imessage-bridge typecheck
pnpm test
```

## Phase 3 — typed native-action registry

Goal: replace arbitrary provider tunnels such as `slack.proxy` with a typed, auditable, policy-gated extension point.

Required tasks:

1. Add native action contracts to `transport-core` or `broker-core`:
   - `NativeActionName`;
   - `NativeActionDescriptor`;
   - `NativeActionContext`;
   - `NativeActionRequest`;
   - `NativeActionReceipt`;
   - risk, locality, idempotency, and audit metadata.
2. Add a registry that can discover adapter-declared native actions.
3. Add policy hook interfaces for checking action/provider/install/principal before execution.
4. Add audit event shape for native action attempts and results.
5. Add Slack native action descriptors for provider-specific features that cannot be normalized yet, but keep runtime execution disabled unless policy explicitly allows the action.
6. Delete `slack.proxy` naming from broker-facing contracts.
7. Add regression tests proving arbitrary method strings are rejected.

Definition of done:

- no broker-core API exposes `slack.proxy` or an equivalent untyped provider method tunnel;
- native actions require declared schemas, risk, locality, idempotency semantics, and audit;
- remote-capable native actions are blocked until the security phases land.

Validation:

```bash
pnpm --filter @gugu910/pi-transport-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm --filter @gugu910/pi-slack-bridge test
pnpm test
```

Cleanup checks:

```bash
rg -g '!**/*.test.ts' 'slack\.proxy|callNative\(|method: string|native.*method'
```

## Phase 4 — split helpers and delete pure broker shims

Goal: remove the biggest source of mixed ownership before moving runtime modules.

Required tasks:

1. Split `slack-bridge/helpers.ts` into narrow modules:
   - Slack HTTP/API helpers;
   - Slack settings helpers;
   - Slack policy/guardrail helpers;
   - Pinet identity/runtime helpers;
   - token/auth helpers;
   - formatting helpers.
2. Move Pinet identity/runtime helpers to `pinet-core` once they have no Slack dependencies.
3. Move or rewrite imports away from pure `slack-bridge/broker/*` shims.
4. Delete pure re-export shims:
   - `broker/agent-messaging.ts`;
   - `broker/auth.ts`;
   - `broker/leader.ts`;
   - `broker/maintenance.ts`;
   - `broker/message-send.ts`;
   - `broker/paths.ts`;
   - `broker/raw-tcp-loopback.ts`;
   - `broker/router.ts`;
   - `broker/types.ts`.
5. Decide destination for `slack-bridge/broker/schema.ts` separately; do not mechanically delete it because it currently extends core DB behavior.
6. Move tests with modules and delete tests for removed shims.

Definition of done:

- `helpers.ts` is gone or reduced to a tiny adapter-local barrel;
- pure broker shim files are deleted;
- import graph uses `broker-core`, `transport-core`, or `pinet-core` directly;
- no behavior changed except removal of stale aliases/shims.

Validation:

```bash
pnpm --filter @gugu910/pi-slack-bridge test
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm lint
pnpm typecheck
pnpm test
```

Cleanup checks:

```bash
rg -g '!**/*.test.ts' 'from "\.\/broker\/(agent-messaging|auth|leader|maintenance|message-send|paths|raw-tcp-loopback|router|types)'
rg -g '!**/*.test.ts' 'from "\.\/helpers"|from "\.\.\/helpers"'
```

## Phase 5 — broker-core downshift

Goal: make broker-core the broker-neutral owner of socket/client/bootstrap and remove Slack-specific broker RPC naming.

Required tasks:

1. Move `slack-bridge/broker/client.ts` to `broker-core`.
2. Move `slack-bridge/broker/socket-server.ts` to `broker-core`.
3. Move `slack-bridge/broker/index.ts` / bootstrap logic to `broker-core`.
4. Keep local Unix socket behavior.
5. Mark raw TCP as local/test-only until remote transport security is implemented.
6. Replace Slack-specific proxy routes with native-action registry dispatch or delete them if unused.
7. Ensure `broker-core/schema.ts` owns only broker-neutral tables.
8. Move Pinet-specific DB tables/columns toward `pinet-core` or a Pinet-owned schema module.
9. Add tests for neutral socket RPC, broker client reconnect, message delivery, and native-action rejection.

Definition of done:

- `broker-core` owns broker client/server/bootstrap;
- broker socket routes are provider-neutral;
- `slack-bridge` no longer owns local broker infrastructure;
- Slack adapter can still connect through public broker-core APIs.

Validation:

```bash
pnpm --filter @gugu910/pi-broker-core test
pnpm --filter @gugu910/pi-slack-bridge test
pnpm typecheck
pnpm test
```

## Phase 6 — broker runtime ports in place

Goal: refactor current `broker-runtime.ts` in place until it depends on provider-neutral ports rather than constructing Slack directly.

Required tasks:

1. Define narrow runtime ports:
   - `TransportRegistryPort`;
   - `RuntimeSettingsPort`;
   - `ActivityLogPort`;
   - `ControlPlanePublisherPort`;
   - `HomeSurfacePublisherPort`;
   - `OriginPolicyPort`;
   - `ThreadAssociationPort`;
   - `RuntimeUiPort`;
   - `NativeActionPolicyPort`.
2. Replace direct `new SlackAdapter(...)` construction with injected adapter factories/instances.
3. Add fake non-Slack adapter tests for broker runtime.
4. Move Slack publisher implementations behind Slack-owned publisher adapters.
5. Move Slack policy sources behind `OriginPolicyPort`.
6. Keep implementation in `slack-bridge` only temporarily if needed, but the file must compile without direct Slack adapter construction.

Definition of done:

- broker runtime can run in tests with a fake transport registry and no Slack imports;
- Slack-specific publishing/policy lives in adapter implementations;
- ports are narrow and do not become Slack-shaped god interfaces.

Validation:

```bash
pnpm --filter @gugu910/pi-slack-bridge test
pnpm --filter @gugu910/pi-pinet-core test
pnpm typecheck
pnpm test
```

## Phase 7 — create Pinet composition package/extension boundary

Goal: make Pinet the installable/runtime entrypoint and Slack a configured adapter.

Required tasks:

1. Add `pinet-extension` package or a clearly separated Pi adapter layer under `pinet-core/extension`.
2. Register Pinet tools/commands from the Pinet extension layer, not from Slack bridge.
3. Load `pinet.*` settings and instantiate adapter factories.
4. Register first-party adapter factories:
   - Slack from `slack-bridge`;
   - iMessage from `imessage-bridge`.
5. Update root `package.json` Pi extension list so Pinet can be enabled directly.
6. Ensure Slack bridge can be installed as an adapter dependency or separate UX extension without owning Pinet runtime.
7. Add README/docs for “install/enable Pinet, configure transports”.

Definition of done:

- there is a first-class Pinet extension/composer;
- Slack is not the only way to activate Pinet runtime;
- Pinet tools are available through Pinet-owned registration;
- Slack-specific tools remain in Slack bridge.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-slack-bridge test
pnpm typecheck
pnpm test
```

## Phase 8 — extract pinet-core runtime modules

Goal: move Pinet runtime logic out of Slack bridge after ports and composition are ready.

Required tasks:

Move these modules to `pinet-core` or split them as needed:

- `agent-completion-runtime.ts`;
- `agent-event-runtime.ts`;
- `agent-prompt-guidance.ts`;
- `broker-delivery.ts`;
- `broker-runtime-access.ts`;
- `broker-runtime.ts`;
- `command-registration-runtime.ts`;
- `follower-delivery.ts`;
- `follower-runtime.ts`;
- `git-metadata.ts`;
- `inbox-drain-runtime.ts`;
- `persisted-runtime-state.ts`;
- `pinet-activity-formatting.ts`;
- `pinet-agent-status.ts`;
- `pinet-commands.ts`;
- `pinet-maintenance-delivery.ts`;
- `pinet-mesh-ops.ts`;
- `pinet-registration-gate.ts`;
- `pinet-remote-control.ts`;
- `pinet-remote-control-acks.ts`;
- `pinet-skin.ts`;
- `pinet-tools.ts`;
- `ralph-loop.ts`;
- `scheduled-wakeups.ts`;
- `session-ui-runtime.ts`;
- `task-assignments.ts`;
- `ttl-cache.ts`.

Split before or during move:

- `runtime-agent-context.ts`;
- `tool-registration-runtime.ts`;
- `broker/control-plane-canvas.ts`;
- Pinet-specific parts of broker schema.

Definition of done:

- moved modules import no Slack implementation details;
- Slack bridge imports Pinet runtime APIs instead of owning them;
- tests move with modules and pass under `pinet-core`;
- prompt guidance is deduplicated: durable Pinet role guidance lives in Pinet, Slack-origin guidance lives in Slack.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-slack-bridge test
pnpm lint
pnpm typecheck
pnpm test
```

Cleanup checks:

```bash
rg -g '!**/*.test.ts' 'slack' pinet-core
rg -g '!**/*.test.ts' 'agent-prompt-guidance|pinet-tools|pinet-commands' slack-bridge
```

Review any matches manually; legitimate adapter names in test/fake setup should be isolated and documented.

## Phase 9 — slim Slack bridge to adapter/UX package

Goal: finish the ownership inversion: Slack bridge is an adapter and UX layer, not a runtime owner.

Required tasks:

1. Keep Slack Socket Mode/API/access in Slack bridge:
   - `slack-access.ts`;
   - `slack-api.ts`;
   - `slack-request-runtime.ts`;
   - `broker/adapters/slack.ts` or renamed adapter module.
2. Keep Slack UX tools/surfaces in Slack bridge:
   - `slack-tools.ts`;
   - `slack-modals.ts`;
   - `slack-upload.ts`;
   - `slack-export.ts`;
   - `slack-presence.ts`;
   - `slack-block-kit.ts`;
   - `home-tab.ts`;
   - `pinet-home-tabs.ts` only if it is Slack publisher implementation;
   - `pinet-control-plane-canvas.ts` only if it is Slack publisher implementation;
   - `canvases.ts`.
3. Keep Slack policy/prompt sources in Slack bridge:
   - `guardrails.ts`;
   - `slack-tool-policy-runtime.ts`;
   - `slack-turn-guardrails.ts`;
   - `reaction-triggers.ts`;
   - `thread-confirmations.ts`.
4. Keep manifest/deployment code in Slack bridge.
5. Delete Slack broker/follower startup paths except deliberately retained single-player Slack mode.
6. Rename modules where current names imply Slack owns Pinet runtime.
7. Update Slack README to say Slack is one Pinet transport/UX adapter.

Definition of done:

- `slack-bridge/index.ts` is a thin Slack adapter/UX composer;
- no Slack package file starts broker/follower runtime as owner except single-player mode;
- Slack adapter factory is consumed by Pinet composition.

Validation:

```bash
pnpm --filter @gugu910/pi-slack-bridge test
pnpm --filter @gugu910/pi-pinet-core test
pnpm typecheck
pnpm test
```

## Phase 10 — iMessage as a normal transport

Goal: remove Slack-owned iMessage control and route iMessage through the same Pinet send path as Slack.

Required tasks:

1. Register iMessage adapter through the transport registry.
2. Move or delete Slack-owned `imessage_send` tool registration.
3. Route outbound iMessage through generic Pinet send/message primitive.
4. Advertise iMessage capabilities truthfully as send-first.
5. Keep Messages history/SQLite read support out of this phase unless separately designed with macOS privacy permissions.
6. Add tests proving generic send can target Slack or iMessage by provider/install/conversation ref.

Definition of done:

- iMessage is not registered by Slack runtime;
- iMessage send works through generic transport path;
- iMessage adapter has explicit send-first capabilities.

Validation:

```bash
pnpm --filter @gugu910/pi-imessage-bridge test
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm test
```

## Phase 11 — durable read/context sync

Goal: implement durable context events and read/send tools after address/content contracts exist.

Required tasks:

1. Add persisted context/event log with provider/install/conversation/message/principal metadata.
2. Add idempotency/dedupe keys for ingested events and send receipts.
3. Add unread cursors per Pinet instance/principal/conversation.
4. Implement `pinet_read` or the decided discoverable read action from #601/#554.
5. Ensure unauthorized messages can be stored as context but not executed as commands (#538).
6. Add bounded summary/pointer prompt integration.
7. Avoid embeddings or semantic memory in this first durable-context slice.
8. Add migration tests for old broker DB data if any old schema is still present.

Definition of done:

- Pinet can persist, dedupe, and read durable conversation events across supported transports;
- command execution is separated from contextual visibility;
- prompt context uses bounded pointers/summaries, not unbounded transcript injection.

Validation:

```bash
pnpm --filter @gugu910/pi-broker-core test
pnpm --filter @gugu910/pi-pinet-core test
pnpm test
```

## Phase 12 — security hardening before remote/cloud

Goal: make local Pinet trustworthy before adding remote/cloud transports.

Required tasks:

1. Implement enforceable core tool guardrails (#322), not prompt-only guidance.
2. Implement stable ID resumption credentials and takeover prevention (#324).
3. Replace or lock down raw TCP; design remote-safe transport security before any non-local transport (#325).
4. Implement provider/install/instance/principal/action scoped auth (#481/#547/#548).
5. Add policy tests for:
   - unauthorized command rejection;
   - authorized context storage;
   - remote control approval;
   - native action risk enforcement;
   - cross-workspace/provider isolation.
6. Add audit logging for sensitive actions and denied actions.

Definition of done:

- remote-capable actions and transports have a real identity/auth/policy model;
- guardrails are enforced in code;
- no action can cross provider/install/instance boundaries without policy.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm --filter @gugu910/pi-transport-core test
pnpm test
```

Security cleanup checks:

```bash
rg -g '!**/*.test.ts' 'raw-tcp|0\.0\.0\.0|allowAll|bypass|unauthorized|guardrail'
```

## Phase 13 — multi-workspace and multi-instance orchestration

Goal: support multiple Slack workspaces and future providers through Pinet-owned topology, not Slack-owned runtime orchestration.

Required tasks:

1. Restack multi-workspace work around `TransportInstallRef` and `PinetInstanceRef`.
2. Support multiple configured installs under `pinet.transports.slack.installs`.
3. Ensure routing keys include provider/install/conversation/message where needed.
4. Ensure policy keys include provider/install/instance/principal/action.
5. Ensure control-plane surfaces can display and filter by provider/install/instance.
6. Add tests for two Slack installs and at least one non-Slack provider fake.

Definition of done:

- multi-workspace is a transport-registry capability;
- Slack no longer orchestrates global Pinet runtime state;
- tests prove two installs do not leak messages, actions, principals, or settings.

Validation:

```bash
pnpm --filter @gugu910/pi-slack-bridge test
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm test
```

## Phase 14 — daemon scaffold

Goal: create the daemon process without moving runtime ownership prematurely.

Prerequisite gate:

- Phases 1–13 are complete;
- Pinet owns runtime composition;
- broker-core owns socket/client/bootstrap;
- security phase blocks are complete for any remote/non-local exposure.

Required tasks:

1. Add `pinet-daemon` package named `@gugu910/pi-pinet-daemon`, plus any CLI entrypoint needed for `pinet daemon ...` commands.
2. Add `pinet-daemon` to `pnpm-workspace.yaml`, Turbo tasks, and package build/typecheck/test wiring.
3. Add daemon config loading from the `pinet.*` envelope.
4. Add singleton lease/lock for local broker ownership.
5. Add daemon status/log/restart/stop commands.
6. Add health endpoint or local control API.
7. Add tests for lease ownership, startup failure, config validation, and status output.

Definition of done:

- daemon can start, acquire lease, load config, expose status, and stop cleanly;
- daemon does not yet need to host the full broker brain in production mode.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-daemon test
pnpm typecheck
pnpm test
```

## Phase 15 — SDK-hosted daemon runtime

Goal: host Pinet runtime in the daemon through the SDK-first architecture.

Required tasks:

1. Embed the Pinet runtime session via Pi SDK.
2. Instantiate adapter factories from daemon-owned `pinet.*` config.
3. Own broker DB, socket, transport adapters, Ralph loop, maintenance, scheduler, and activity/health signals in the daemon.
4. Ensure operator Pi sessions connect as clients, not broker hosts.
5. Add graceful restart/recovery behavior:
   - reacquire lease;
   - reopen DB;
   - reconnect adapters;
   - resume timers;
   - allow workers/followers to reconnect.
6. Add integration tests or smoke tests for daemon startup and worker/follower reconnect.

Definition of done:

- daemon can run Pinet control plane without an operator Slack/Pi session owning infrastructure;
- workers/followers connect to daemon-owned broker;
- Slack bridge is an adapter under daemon/Pinet ownership.

Validation:

```bash
pnpm --filter @gugu910/pi-pinet-daemon test
pnpm --filter @gugu910/pi-pinet-core test
pnpm --filter @gugu910/pi-broker-core test
pnpm typecheck
pnpm test
```

## Phase 16 — daemon hardening and operator UX

Goal: make the daemon operable as durable local infrastructure.

Required tasks:

1. Add structured logs and activity/health events.
2. Add CLI inspection commands:
   - `pinet daemon status`;
   - `pinet daemon logs`;
   - `pinet daemon restart`;
   - `pinet daemon stop`.
3. Add clear error reporting for:
   - auth failures;
   - DB migration failures;
   - socket/lease conflicts;
   - adapter reconnect failures;
   - worker/follower reconnect issues.
4. Add durable recovery tests.
5. Update `plans/420-broker-daemon-prd.md` with final implementation decisions.
6. Add operator docs.

Definition of done:

- daemon is observable, restartable, and debuggable;
- errors surface through operator commands and logs;
- docs describe install/start/stop/recover workflows.

Validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Phase 17 — final cleanup, docs, and release readiness

Goal: remove refactor residue and make the final architecture the only public mental model.

Required tasks:

1. Delete remaining deprecated settings, imports, wrappers, aliases, and stale docs.
2. Remove or update historical planning docs so they cannot be mistaken for current architecture.
3. Update root README and package READMEs.
4. Update examples and extension registration docs.
5. Run import/export scan for unused exports.
6. Run prompt/tool guidance dedupe pass.
7. Run full security review against local/remote threat model.
8. Run full validation and at least one manual smoke test for:
   - Pinet with Slack transport;
   - Pinet with iMessage send transport;
   - durable read/context sync;
   - worker/follower reconnect;
   - daemon start/status/stop.

Definition of done:

- no stale Slack-owned Pinet runtime path remains;
- no compatibility residue remains unless explicitly documented as current product behavior;
- docs, tests, and package boundaries all describe the same architecture.

Final validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Final hygiene checks:

```bash
rg -g '!**/*.test.ts' 'autoConnect|autoFollow|slack\.proxy|source = "slack"|source \?\? "slack"'
rg -g '!**/*.test.ts' 'compatibility|legacy|deprecated|TODO' transport-core broker-core pinet-core slack-bridge imessage-bridge
rg -g '!**/*.test.ts' 'from "\.\/broker\/(agent-messaging|auth|leader|maintenance|message-send|paths|raw-tcp-loopback|router|types)'
```

## Cross-phase issue mapping

| Issue/PR | Implementation phase |
| --- | --- |
| #599 outbound content rendering | Phase 0 / Phase 2 input |
| #600 delivery claims | Phase 0 / Phase 8 reliability |
| #598 stableId reconnect cap | Phase 0 / Phase 12 input |
| #580 Slack thread association | Phase 0 / Phase 2 / Phase 11 |
| #601 durable inbox read | Phase 0 decision / Phase 11 implementation |
| #567/#568/#570 compatibility/multi-workspace stack | Phase 0 decision / Phase 12–13 restack |
| #264 split god file | Phase 4 / Phase 9 |
| #322 guardrails | Phase 12 |
| #324 stable ID takeover | Phase 12 |
| #325 remote TCP unsafe | Phase 12 |
| #373 iMessage shared core | Phase 10 |
| #403 rendering/parsing | Phase 2 |
| #406 broker-managed spawn | Phase 15+ after daemon ownership |
| #420 daemon PRD | Phase 14–16 |
| #464 WhatsApp/iMessage strategy | Phase 10+ future adapter work |
| #480/#549/#550 multi-workspace topology | Phase 13 |
| #481/#547/#548 scoped auth | Phase 12 |
| #482 named Pinet instance | Phase 1 / Phase 13 |
| #538 unauthorized context | Phase 11 / Phase 12 |
| #551 delete shims | Phase 4 |
| #552 remove aliases | Phase 1 |
| #553 dormant pinet-core | Phase 7–8 |
| #554 tool role split | Phase 0 / Phase 11 |
| #556 prompt overlay dedupe | Phase 8 / Phase 17 |
| #575 max-thread continuation | Phase 2 / Phase 11 |
| #582 steering vs follow-up classification | Phase 8 / Phase 11 |
| #588 tool surface audit | Phase 7 / Phase 11 / Phase 17 |
| #594 durable context sync | Phase 11 |
| #596 reload/error visibility | Phase 8 / Phase 16 |

## Merge discipline

For each PR created from this plan, include this checklist in the PR description:

```md
## Pinet refactor phase

- Phase:
- Responsibilities moved:
- Old paths deleted/shrunk:
- Compatibility shims introduced? If yes, deletion phase:
- Tests added/moved:
- Hygiene checks run:

## Validation

- [ ] pnpm lint
- [ ] pnpm typecheck
- [ ] pnpm test
- [ ] package-specific tests listed below
```

A PR should not merge if it adds a new abstraction but leaves the old owner fully alive without a named deletion in the same or next phase.
