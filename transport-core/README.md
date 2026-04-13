# @gugu910/pi-transport-core

Tiny transport-neutral contracts package for the `extensions` repo.

## What lives here

- canonical `InboundMessage` contract
- canonical `OutboundMessage` contract
- canonical `MessageAdapter` transport interface

## What stays out of scope

- broker state
- routing
- socket server/client logic
- Slack-specific normalization
- iMessage-specific AppleScript or readiness logic
- Pi extension commands/tools

This package exists to keep transport contracts transport-neutral while other packages decide how to route, persist, or render those messages.
