# Changelog

All notable changes to this repository are documented in this file.

## [0.1.0] - 2026-04-02

First public release prep for the Pi extensions monorepo. This cut rolls up 66 pull requests merged on 2026-04-02 and aligns with the publish-ready package metadata landed in [#222](https://github.com/gugu91/extensions/pull/222).

> Note: issue #196 was originally filed as `v0.0.1`, but the publish-ready package versions on `main` are already `0.1.0`, so this changelog follows the versions actually present in the repo.

### Version verification

- `pi-extensions` — `0.1.0`
- `@gugu910/pi-slack-bridge` — `0.1.0`
- `@gugu910/pi-nvim-bridge` — `0.1.0`
- `@gugu910/pi-neon-psql` — `0.1.0`
- `@gugu910/pi-slack-api` — `0.1.0`
- `@gugu910/pi-ext-types` — `0.1.0`

### Release highlights

- Slack Bridge grew into a much broader operator surface: scheduling, uploads, canvases, Block Kit, bookmarks, pinning, exports, modals, presence, deploy tooling, and broker observability.
- Pinet broker/worker coordination was hardened across routing, reconnects, stale agent cleanup, RALPH reporting, wake-ups, inbox delivery, worktree enforcement, and broadcast/delegation flows.
- Packaging and workspace infrastructure were prepared for public npm distribution with publish metadata, generated Slack API packaging, shared types, and expanded automated coverage.

### Features (24)

- [#116](https://github.com/gugu91/extensions/pull/116) — ralph loop nudge followUp delivery + agent observability (#102, #103)
- [#152](https://github.com/gugu91/extensions/pull/152) — expose agent PIDs in pinet_agents tool output (#117)
- [#180](https://github.com/gugu91/extensions/pull/180) — add pinet-unfollow command (#176)
- [#181](https://github.com/gugu91/extensions/pull/181) — report worker task completion status in RALPH loop
- [#187](https://github.com/gugu91/extensions/pull/187) — add pinet reload and exit controls (#118)
- [#189](https://github.com/gugu91/extensions/pull/189) — steer delegation through Pinet
- [#190](https://github.com/gugu91/extensions/pull/190) — enforce main-checkout worktree rule
- [#193](https://github.com/gugu91/extensions/pull/193) — add Pinet broadcast channels
- [#194](https://github.com/gugu91/extensions/pull/194) — add scheduled Pinet wake-ups
- [#200](https://github.com/gugu91/extensions/pull/200) — add Slack canvas tools (#26)
- [#201](https://github.com/gugu91/extensions/pull/201) — add Slack file upload tool (#34)
- [#204](https://github.com/gugu91/extensions/pull/204) — add Slack manifest deploy command
- [#206](https://github.com/gugu91/extensions/pull/206) — add agent-name personalities
- [#208](https://github.com/gugu91/extensions/pull/208) — add generated Slack API workspace package
- [#213](https://github.com/gugu91/extensions/pull/213) — add Slack scheduled message tool (#33)
- [#216](https://github.com/gugu91/extensions/pull/216) — add Slack pinning and bookmarks tools (#25)
- [#218](https://github.com/gugu91/extensions/pull/218) — add pinet idle/free signal (#214)
- [#219](https://github.com/gugu91/extensions/pull/219) — add reaction-triggered Slack actions
- [#220](https://github.com/gugu91/extensions/pull/220) — add Slack thread export tool (#29)
- [#221](https://github.com/gugu91/extensions/pull/221) — add Slack Block Kit support (#27)
- [#224](https://github.com/gugu91/extensions/pull/224) — add Slack presence awareness
- [#225](https://github.com/gugu91/extensions/pull/225) — add broker control plane canvas dashboard (#217)
- [#229](https://github.com/gugu91/extensions/pull/229) — add Slack modal workflows
- [#230](https://github.com/gugu91/extensions/pull/230) — add broker activity log channel (#30)

### Fixes (34)

- [#113](https://github.com/gugu91/extensions/pull/113) — allow Ralph loop follow-up repeats after cooldown
- [#115](https://github.com/gugu91/extensions/pull/115) — deliver pinet messages to broker's own inbox
- [#145](https://github.com/gugu91/extensions/pull/145) — enforce single-broker lock to prevent split-brain (#119)
- [#146](https://github.com/gugu91/extensions/pull/146) — add color entropy to agent names (issue #120)
- [#148](https://github.com/gugu91/extensions/pull/148) — broker routing regression + worker reply tool rules (#121, #122)
- [#150](https://github.com/gugu91/extensions/pull/150) — clean up stale agent rows and orphaned threads on purge (issue #140)
- [#151](https://github.com/gugu91/extensions/pull/151) — cap Slack API retry at 3 attempts to prevent infinite recursion (#124)
- [#153](https://github.com/gugu91/extensions/pull/153) — add hard broker guardrails to prevent coding (#107)
- [#154](https://github.com/gugu91/extensions/pull/154) — make claimThread atomic to prevent TOCTOU race (#125)
- [#155](https://github.com/gugu91/extensions/pull/155) — bound in-memory caches with TTL + max-size eviction (#129)
- [#159](https://github.com/gugu91/extensions/pull/159) — clean unregister inbox rows and requeue a2a work (#137)
- [#160](https://github.com/gugu91/extensions/pull/160) — add proper types for activeBroker and brokerClient (Issue #126)
- [#161](https://github.com/gugu91/extensions/pull/161) — clear broken reconnect state after re-register failure (#139)
- [#162](https://github.com/gugu91/extensions/pull/162) — remove blocking execSync from agent metadata lookup (#133)
- [#163](https://github.com/gugu91/extensions/pull/163) — harden broker JSON-RPC request validation (#147)
- [#166](https://github.com/gugu91/extensions/pull/166) — remove dead code client-extension.ts
- [#167](https://github.com/gugu91/extensions/pull/167) — centralize hardcoded socket and database paths
- [#168](https://github.com/gugu91/extensions/pull/168) — warn when SQLite WAL mode falls back (#142)
- [#169](https://github.com/gugu91/extensions/pull/169) — keep local subagents out of the Pinet mesh (#156)
- [#170](https://github.com/gugu91/extensions/pull/170) — share TypeBox through workspace package (#144)
- [#177](https://github.com/gugu91/extensions/pull/177) — stop replaying stale RALPH ghost alerts
- [#178](https://github.com/gugu91/extensions/pull/178) — abort in-flight Slack API calls on shutdown (#135)
- [#179](https://github.com/gugu91/extensions/pull/179) — keep follower a2a traffic out of the Slack inbox (#175)
- [#183](https://github.com/gugu91/extensions/pull/183) — tighten broker client typing (#126)
- [#184](https://github.com/gugu91/extensions/pull/184) — expire stale Slack confirmation state
- [#185](https://github.com/gugu91/extensions/pull/185) — detect psql binary path across platforms (#141)
- [#186](https://github.com/gugu91/extensions/pull/186) — harden follower inbox delivery across restart
- [#192](https://github.com/gugu91/extensions/pull/192) — keep broker db authoritative for thread tracking (#131)
- [#195](https://github.com/gugu91/extensions/pull/195) — add timestamp to RALPH loop messages (#191)
- [#198](https://github.com/gugu91/extensions/pull/198) — report initial RALPH task status (#197)
- [#205](https://github.com/gugu91/extensions/pull/205) — use broker-specific generated names (#202)
- [#209](https://github.com/gugu91/extensions/pull/209) — timestamp all RALPH loop messages (#191)
- [#211](https://github.com/gugu91/extensions/pull/211) — route direct-addressed Slack threads (#207)
- [#226](https://github.com/gugu91/extensions/pull/226) — dedup retried Slack Socket Mode events

### Infrastructure & Quality (6)

- [#171](https://github.com/gugu91/extensions/pull/171) — consolidate duplicate Slack API wrappers (Issue #130)
- [#173](https://github.com/gugu91/extensions/pull/173) — extract Slack API and tool registrations from slack-bridge index (#127)
- [#174](https://github.com/gugu91/extensions/pull/174) — add nvim-bridge coverage (#134)
- [#188](https://github.com/gugu91/extensions/pull/188) — cover neon-psql core query helpers (#149)
- [#212](https://github.com/gugu91/extensions/pull/212) — cover neon-psql query execution path (#149)
- [#222](https://github.com/gugu91/extensions/pull/222) — prep packages for npm publish readiness

### Docs (2)

- [#210](https://github.com/gugu91/extensions/pull/210) — refresh repo README
- [#228](https://github.com/gugu91/extensions/pull/228) — add Pinet philosophy section
