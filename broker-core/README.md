# @gugu910/pi-broker-core

Transport-neutral broker kernel primitives for the `extensions` repo.

## What lives here

- broker domain types
- broker SQLite state and persistence
- routing and backlog maintenance logic
- direct/broadcast agent messaging helpers
- broker auth / lock / path / loopback utilities

## What stays out of scope

- Slack adapter and event normalization
- Slack tools, Home tabs, canvases, and manifest concerns
- Pi extension command/tool wiring
- broker runtime orchestration and RALPH UI flows
- follower runtime and single-player runtime glue
