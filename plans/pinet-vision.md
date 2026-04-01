# Pinet Vision

> One gateway. One message primitive. Many agents.

## What Pinet is

Pinet is a **local-first multi-agent coordination layer** for pi.

It connects agents to each other, to Slack, to Neovim, and to any future adapter — through one unified message flow.

## Core principles

1. **One control plane** — a single broker owns routing, agent lifecycle, and message delivery. No split brain.

2. **`message.send` is the primitive** — Slack replies, PiComms comments, and agent-to-agent messages are all the same thing underneath. Adapters translate at the edges.

3. **Stable agent identity** — agents have a logical identity that survives reconnects. Heartbeats and leases handle liveness. Dead agents get reaped, not ignored.

4. **Smart broker, dumb routing** — the broker is an LLM agent that can reason, self-heal, and orchestrate. Core routing underneath is deterministic policy code.

5. **Ralph loop** — the broker runs an autonomous maintenance cycle: reap dead agents, drain unrouted messages, nudge idle workers, fix inconsistent state.

6. **Workers are computation, broker is infrastructure** — workers do tasks. The broker keeps the lights on. They don't share a process lifetime.

7. **Extensions stay thin** — tools like `slack_send`, `comment_add`, and `pinet_message` are shims over the broker. They don't own state.

## What this enables

- Agents that survive restarts and keep their threads
- Work that routes to the right agent automatically
- Dead agents that get cleaned up, not forgotten
- Delegation that flows through one system, not ad hoc subagents
- Any new adapter (Discord, Linear, GitHub) plugs into the same message flow

## What this does NOT mean

- No separate daemon process yet — broker lives in a pi extension for now
- No public generic `send_message` tool yet — internal primitive first
- No redesign of Slack or Neovim UX — storage and transport unify before the UI does
- No multi-repo federation yet — one machine, one broker

## North star

You open Slack, mention an agent, and it just works. The right agent picks it up. If that agent dies, another one takes over. You never think about routing, lifecycle, or thread ownership. It's invisible infrastructure.
