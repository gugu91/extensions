# Changelog

All notable changes to this repository will be documented in this file.

## v0.0.1 - 2026-04-02 (release prep)

> Release prep note: Issue #196 referenced 38 merged PRs earlier in the day. By the time this prep branch was cut from `origin/main`, there were 43 merged PRs from 2026-04-02 included in the release notes below.

### Version prep

| Package                   | Previous version | Prepared version |
| ------------------------- | ---------------- | ---------------- |
| `pi-extensions`           | `0.1.0`          | `0.0.1`          |
| `@gugu91/pi-slack-bridge` | `0.1.0`          | `0.0.1`          |
| `@gugu91/pi-nvim-bridge`  | `0.1.0`          | `0.0.1`          |
| `@gugu91/pi-neon-psql`    | `0.1.0`          | `0.0.1`          |
| `@gugu91/pi-ext-types`    | `0.1.0`          | `0.0.1`          |

### Highlights

#### Slack bridge / Pinet / broker reliability

- Ralph loop follow-up delivery, worker observability, cooldown handling, timestamps, stale ghost-alert suppression, worker completion tracking, and initial assignment reporting all landed in the broker loop.
- Broker durability and routing improved with self-inbox delivery, single-broker locking, JSON-RPC validation hardening, reconnect recovery fixes, atomic thread claiming, bounded caches, broker-thread source-of-truth lookups, scheduled wake-ups, broadcast channels, reload/exit controls, unfollow support, and Pinet-first delegation guidance.
- Follower and broker delivery were hardened across restart and shutdown with safer inbox ACK timing, stale confirmation cleanup, follower a2a leak fixes, and shutdown cancellation for in-flight Slack API calls.

#### Worktree / operator safety / repo workflow

- Worktree-aware agent metadata and visibility landed, with main-checkout protection, worktree-only edit enforcement, canonical repo identity for linked worktrees, and orphaned worktree cleanup surfaced in RALPH.
- Broker guardrails were strengthened so the broker coordinates instead of coding, and local subagents are kept out of the Pinet mesh.

#### Package / tool / test coverage improvements

- `neon-psql` gained cross-platform `psql` path detection and deeper helper coverage.
- `nvim-bridge` gained dedicated test coverage.
- Slack bridge internals were refactored by extracting Slack API/tool registration code and consolidating duplicate Slack wrappers.
- Shared TypeBox types now flow through the workspace package.

### Included merged PRs (2026-04-02)

- [#113](https://github.com/gugu91/extensions/pull/113) fix: allow Ralph loop follow-up repeats after cooldown
- [#115](https://github.com/gugu91/extensions/pull/115) fix: deliver pinet messages to broker's own inbox
- [#116](https://github.com/gugu91/extensions/pull/116) feat: ralph loop nudge followUp delivery + agent observability (#102, #103)
- [#145](https://github.com/gugu91/extensions/pull/145) fix: enforce single-broker lock to prevent split-brain (#119)
- [#146](https://github.com/gugu91/extensions/pull/146) fix: add color entropy to agent names (issue #120)
- [#148](https://github.com/gugu91/extensions/pull/148) fix: broker routing regression + worker reply tool rules (#121, #122)
- [#150](https://github.com/gugu91/extensions/pull/150) fix: clean up stale agent rows and orphaned threads on purge (issue #140)
- [#151](https://github.com/gugu91/extensions/pull/151) fix: cap Slack API retry at 3 attempts to prevent infinite recursion (#124)
- [#152](https://github.com/gugu91/extensions/pull/152) feat: expose agent PIDs in pinet_agents tool output (#117)
- [#153](https://github.com/gugu91/extensions/pull/153) fix: add hard broker guardrails to prevent coding (#107)
- [#154](https://github.com/gugu91/extensions/pull/154) fix: make claimThread atomic to prevent TOCTOU race (#125)
- [#155](https://github.com/gugu91/extensions/pull/155) fix: bound in-memory caches with TTL + max-size eviction (#129)
- [#159](https://github.com/gugu91/extensions/pull/159) fix: clean unregister inbox rows and requeue a2a work (#137)
- [#160](https://github.com/gugu91/extensions/pull/160) fix: add proper types for activeBroker and brokerClient (Issue #126)
- [#161](https://github.com/gugu91/extensions/pull/161) fix: clear broken reconnect state after re-register failure (#139)
- [#162](https://github.com/gugu91/extensions/pull/162) fix: remove blocking execSync from agent metadata lookup (#133)
- [#163](https://github.com/gugu91/extensions/pull/163) fix: harden broker JSON-RPC request validation (#147)
- [#166](https://github.com/gugu91/extensions/pull/166) fix: remove dead code client-extension.ts
- [#167](https://github.com/gugu91/extensions/pull/167) fix: centralize hardcoded socket and database paths
- [#168](https://github.com/gugu91/extensions/pull/168) fix: warn when SQLite WAL mode falls back (#142)
- [#169](https://github.com/gugu91/extensions/pull/169) fix: keep local subagents out of the Pinet mesh (#156)
- [#170](https://github.com/gugu91/extensions/pull/170) fix: share TypeBox through workspace package (#144)
- [#171](https://github.com/gugu91/extensions/pull/171) refactor: consolidate duplicate Slack API wrappers (Issue #130)
- [#173](https://github.com/gugu91/extensions/pull/173) refactor: extract Slack API and tool registrations from slack-bridge index (#127)
- [#174](https://github.com/gugu91/extensions/pull/174) test: add nvim-bridge coverage (#134)
- [#177](https://github.com/gugu91/extensions/pull/177) fix: stop replaying stale RALPH ghost alerts
- [#178](https://github.com/gugu91/extensions/pull/178) fix: abort in-flight Slack API calls on shutdown (#135)
- [#179](https://github.com/gugu91/extensions/pull/179) fix: keep follower a2a traffic out of the Slack inbox (#175)
- [#180](https://github.com/gugu91/extensions/pull/180) feat: add pinet-unfollow command (#176)
- [#181](https://github.com/gugu91/extensions/pull/181) feat: report worker task completion status in RALPH loop
- [#183](https://github.com/gugu91/extensions/pull/183) fix: tighten broker client typing (#126)
- [#184](https://github.com/gugu91/extensions/pull/184) fix: expire stale Slack confirmation state
- [#185](https://github.com/gugu91/extensions/pull/185) fix: detect psql binary path across platforms (#141)
- [#186](https://github.com/gugu91/extensions/pull/186) fix: harden follower inbox delivery across restart
- [#187](https://github.com/gugu91/extensions/pull/187) feat: add pinet reload and exit controls (#118)
- [#188](https://github.com/gugu91/extensions/pull/188) test: cover neon-psql core query helpers (#149)
- [#189](https://github.com/gugu91/extensions/pull/189) feat: steer delegation through Pinet
- [#190](https://github.com/gugu91/extensions/pull/190) feat: enforce main-checkout worktree rule
- [#192](https://github.com/gugu91/extensions/pull/192) fix: keep broker db authoritative for thread tracking (#131)
- [#193](https://github.com/gugu91/extensions/pull/193) feat: add Pinet broadcast channels
- [#194](https://github.com/gugu91/extensions/pull/194) feat: add scheduled Pinet wake-ups
- [#195](https://github.com/gugu91/extensions/pull/195) fix: add timestamp to RALPH loop messages (#191)
- [#198](https://github.com/gugu91/extensions/pull/198) fix: report initial RALPH task status (#197)
