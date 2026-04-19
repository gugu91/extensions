# @gugu910/pi-transport-core

Tiny transport-neutral contracts package for the `extensions` repo.

## What lives here

- canonical `InboundMessage` contract
- canonical `OutboundMessage` contract
- normalized outbound `content` shape for transport-aware rendering with plain-text fallback
- canonical `MessageAdapter` transport interface

## What stays out of scope

- broker state
- routing
- socket server/client logic
- Slack-specific normalization
- iMessage-specific AppleScript or readiness logic
- Pi extension commands/tools

This package exists to keep transport contracts transport-neutral while other packages decide how to route, persist, or render those messages.

## Outbound content rules

`OutboundMessage.text` remains the backward-compatible plain-text fallback and persistence body.

When richer transport-aware rendering is available, callers may also send `OutboundMessage.content`:

- `content.text`: canonical plain-text body
- `content.markdown`: optional markdown-friendly representation for markdown/iMessage-style rendering
- `content.slackBlocks`: optional prebuilt Slack Block Kit payload

Transports should prefer their transport-specific representation when present, then fall back in this order:

1. transport-native content (`slackBlocks` for Slack)
2. `markdown` when a transport only needs text output
3. plain `text`

This keeps Slack, markdown-oriented exports, and plain-text/iMessage sends aligned without requiring every caller to collapse everything into one presentation string upfront.
