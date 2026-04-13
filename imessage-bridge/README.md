# @gugu910/pi-imessage-bridge

Tiny macOS/iMessage MVP scaffold for the `extensions` repo.

## What this slice does

This package does **not** wire iMessage into the live broker yet.

Instead, it makes the smallest useful next slice concrete:

- codifies the current MVP assumptions for a local-first iMessage transport
- detects whether the current host can plausibly support that MVP
- gives the future adapter a stable, tested home for adapter-local readiness checks

## Current MVP assumptions

A first iMessage transport in this repo is expected to be:

- **macOS only**
- **local-first**
- **send-capable via AppleScript** through `/usr/bin/osascript`
- **history-aware via the local Messages database** at `~/Library/Messages/chat.db`

That keeps the first slice close to the repo's local-hosted operating model and avoids inventing transport/core wiring before the shared messaging seam is ready.

## Why this lands before the shared messaging seam

The unresolved ports/adapters work is about how a future `imessage-bridge` plugs into the shared broker/runtime core.

This package stays below that line:

- no broker registration
- no routing changes
- no new runtime mode
- no Slack/iMessage crossover logic

It is safe to land independently because it only captures adapter-local environment assumptions.

## Out of scope

- inbound iMessage handling
- AppleScript send implementation
- chat database queries
- shared messaging-core wiring
- any dependency on `#366`

## Example

```ts
import { detectIMessageMvpEnvironment } from "@gugu910/pi-imessage-bridge";

const environment = detectIMessageMvpEnvironment();
if (!environment.readyForLocalMvp) {
  console.log(environment.blockers);
}
```
