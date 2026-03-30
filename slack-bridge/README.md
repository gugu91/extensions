# slack-bridge (Pinet)

Pi extension that turns the agent into a Slack assistant app. Users open
Pinet from Slack's sidebar, type a message, and the pi agent responds — no
channel setup required.

## How it works

```
User opens Pinet in Slack
  └─► types a message
        └─► 👀 reaction appears
              └─► message queued for pi agent
                    └─► agent responds via slack_send
                          └─► 👀 removed, reply appears in thread
```

**Hybrid inbox model:** Messages queue up while the agent is busy. When the
agent finishes its current task, it automatically drains the inbox and responds.
If the agent is idle, incoming messages are processed immediately.

## Tools

| Tool                            | Description                     |
| ------------------------------- | ------------------------------- |
| `slack_send(text, thread_ts?)`  | Reply in a thread or start new  |
| `slack_read(thread_ts, limit?)` | Read thread messages            |
| `slack_inbox()`                 | Check pending messages manually |

## Features

- **Slack Assistant** — appears in Slack's sidebar, native conversation UI
- **Queued inbox** — messages don't interrupt the agent mid-task
- **Auto-drain** — inbox processed when agent is idle or finishes a task
- **Reactions** — 👀 on receive, removed on reply
- **Suggested prompts** — shown when a user opens a new conversation
- **Multi-user** — handles concurrent conversations from different users
- **Channel awareness** — notified when added to channels

## Setup

### 1. Create a Slack App

https://api.slack.com/apps → **Create New App** → **From a manifest** →
paste `manifest.yaml` from this directory.

### 2. Generate tokens

- **App-Level Token:** Basic Information → App-Level Tokens → Generate
  with `connections:write` scope → copy the `xapp-...` token
- **Bot Token:** OAuth & Permissions → Install to Workspace → copy the
  `xoxb-...` token

### 3. Set env vars

```bash
export SLACK_BOT_TOKEN="xoxb-..."   # Bot User OAuth Token
export SLACK_APP_TOKEN="xapp-..."   # App-Level Token (Socket Mode)
```

Use direnv for convenience:

```bash
# .env.personal.local (gitignored)
SLACK_BOT_TOKEN="xoxb-..."
SLACK_APP_TOKEN="xapp-..."

# .envrc
dotenv_if_exists .env.personal.local
```

### 4. Install extension

```bash
ln -s /path/to/extensions/slack-bridge ~/.pi/agent/extensions/slack-bridge
```

Then `/reload` in pi.

That's it — Pinet appears in Slack's sidebar automatically.

## Manifest

The `manifest.yaml` includes all required scopes and events. Use it when
creating the app (**From a manifest**) or paste it into **App Manifest** in
settings.

Current scopes: `app_mentions:read`, `assistant:write`, `canvases:read`,
`canvases:write`, `channels:history`, `channels:read`, `chat:write`,
`groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`,
`reactions:write`, `users:read`

Current events: `app_mention`, `assistant_thread_started`,
`assistant_thread_context_changed`, `member_joined_channel`,
`message.channels`, `message.groups`, `message.im`

## Architecture

- **Socket Mode** — outbound WebSocket from pi to Slack (no public URL needed)
- **Zero npm deps** — native `fetch` + `WebSocket` (Node 22+)
- **Hybrid inbox** — queue when busy, auto-process when idle
- **Reactions** — 👀 as lightweight "thinking" indicator (no chat lock)

## Status

Use `/slack` in pi to check connection status, active threads, and DM channel.

Footer shows `slack ✦` when connected, with unread count (e.g. `slack ✦ 3`).
