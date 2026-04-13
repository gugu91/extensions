# @gugu910/pi-imessage-bridge

Thin macOS/iMessage **send-first** package for the `extensions` repo.

## What this slice does

This package now covers the smallest useful live transport path:

- adapter-local readiness checks for a local macOS iMessage MVP
- an AppleScript-backed outbound adapter for **send-first** delivery
- transport-local helpers that the shared broker/runtime core can call without burying iMessage logic inside `slack-bridge`

## Current MVP shape

The current implementation is intentionally narrow:

- **macOS only**
- **send-first**
- **AppleScript delivery** through `/usr/bin/osascript`
- **shared-core delivery** via the broker adapter seam
- **local history readiness** still modeled against `~/Library/Messages/chat.db`

That means outbound sends can work even when the local Messages database is unavailable, while startup/readiness reporting still makes the history blocker explicit.

In the current repo bring-up path, enable the adapter with `slack-bridge.imessage.enabled: true` and start the broker runtime with `/pinet-start`.

## What stays in this package

- readiness detection
- canonical local path assumptions for the Messages database
- AppleScript send helper + adapter-local transport code
- stable default thread-id helper for send-first bring-up

## What stays out of scope

- inbound iMessage sync
- chat database query plumbing
- generic transport UI redesign
- WhatsApp or other transport work
- broad Slack/Pinet separation cleanup beyond the existing broker adapter seam

## Example

```ts
import {
  createIMessageAdapter,
  detectIMessageMvpEnvironment,
  getDefaultIMessageThreadId,
} from "@gugu910/pi-imessage-bridge";

const readiness = detectIMessageMvpEnvironment();
if (readiness.canAttemptSend) {
  const adapter = createIMessageAdapter();
  await adapter.connect();
  await adapter.send({
    threadId: getDefaultIMessageThreadId("chat:alice"),
    channel: "chat:alice",
    text: "hello from pi",
  });
}
```
