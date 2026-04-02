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

| Tool                                                                                | Description                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------- |
| `slack_send(text, thread_ts?)`                                                      | Reply in a thread or start new               |
| `slack_upload(content?, path?, filename?, filetype?, title?, channel?, thread_ts?)` | Upload a file/snippet into Slack or a thread |
| `slack_schedule(text, channel?, thread_ts?, delay?, at?)`                           | Schedule a Slack message for later           |
| `slack_read(thread_ts, limit?)`                                                     | Read thread messages                         |
| `slack_inbox()`                                                                     | Check pending messages manually              |
| `slack_create_channel(name, topic?, purpose?)`                                      | Create a project channel                     |
| `slack_post_channel(channel?, text, thread_ts?)`                                    | Post to a channel                            |
| `slack_read_channel(channel, thread_ts?, limit?)`                                   | Read channel history or thread               |
| `slack_canvas_create(title?, markdown?, channel?, kind?)`                           | Create standalone or channel canvases        |
| `slack_canvas_update(canvas_id?, channel?, markdown, mode?, ...)`                   | Append, prepend, or replace canvas content   |

`slack_upload` supports either inline `content` or a guarded local `path`. For
safety, local uploads are limited to files inside the current working directory
or the system temp directory.

`slack_schedule` supports delayed messages via `delay` (for example `30m` or
`2h`) and absolute scheduling via `at` (ISO-8601 UTC timestamp).

## Features

- **Slack Assistant** — appears in Slack's sidebar, native conversation UI
- **Queued inbox** — messages don't interrupt the agent mid-task
- **Auto-drain** — inbox processed when agent is idle or finishes a task
- **Reactions** — 👀 on receive, removed on reply
- **Suggested prompts** — shown when a user opens a new conversation
- **Multi-user** — handles concurrent conversations from different users
- **@mentions** — tag Pinet in any channel and it responds in-thread
- **Channel & canvas tools** — create/read/post in channels and maintain persistent Slack canvases
- **File & snippet uploads** — share diffs, logs, screenshots, exports, and long code snippets without pasting giant messages
- **Scheduled & delayed messages** — queue reminders, timed announcements, and follow-ups without waiting around
- **Agent identity** — agents pick a fun name + emoji per task
- **Thread persistence** — thread state survives `/reload`
- **Remote agent control** — send `/reload` or `/exit` to another Pinet agent
- **Worktree-aware routing** — linked worktree agents keep the canonical repo identity, report their worktree path, and ghost worktrees are flagged for cleanup
- **Main checkout protection** — source edits are blocked from the main checkout; feature work must happen in linked worktrees
- **User allowlist** — restrict who can interact with the agent

## Setup

### 1. Create a Slack App

https://api.slack.com/apps → **Create New App** → **From a manifest** →
paste `manifest.yaml` from this directory.

### 2. Generate tokens

- **App-Level Token:** Basic Information → App-Level Tokens → Generate
  with `connections:write` scope → copy the `xapp-...` token
- **Bot Token:** OAuth & Permissions → Install to Workspace → copy the
  `xoxb-...` token
- **App Config Token:** App settings page → **Your App Configuration Tokens** →
  Generate Token → copy the `xoxe.xoxp-...` token
- **App ID:** Basic Information → **App Credentials** → copy the `A...` app ID

### 3. Configure

Add to `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "appId": "A0123456789",
    "appConfigToken": "xoxe.xoxp-...",
    "allowedUsers": ["U09GWL270LA"],
    "defaultChannel": "C0APL58LB1R",
    "suggestedPrompts": [
      { "title": "Status", "message": "What are you working on?" },
      { "title": "Help", "message": "I need help with something" }
    ]
  }
}
```

| Key                | Required | Description                                      |
| ------------------ | -------- | ------------------------------------------------ |
| `botToken`         | yes      | Bot User OAuth Token (`xoxb-...`)                |
| `appToken`         | yes      | App-Level Token for Socket Mode (`xapp-...`)     |
| `appId`            | deploy   | Slack app ID (`A...`) for manifest deploy/update |
| `appConfigToken`   | deploy   | App configuration token (`xoxe.xoxp-...`)        |
| `allowedUsers`     | no       | Slack user IDs allowed to interact               |
| `defaultChannel`   | no       | Default channel for `slack_post_channel`         |
| `suggestedPrompts` | no       | Prompts shown on new assistant thread            |

> Runtime tokens can also be set via `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
> env vars (settings.json takes priority).
>
> Manifest deploy also reads `SLACK_APP_ID` and `SLACK_APP_CONFIG_TOKEN`
> (or `SLACK_CONFIG_TOKEN`). The Socket Mode `xapp-...` token cannot be used
> with `apps.manifest.update`.

### 4. Install extension

```bash
ln -s /path/to/extensions/slack-bridge ~/.pi/agent/extensions/slack-bridge
```

Then `/reload` in pi. Pinet appears in Slack's sidebar automatically.

## Manifest

The `manifest.yaml` includes all required scopes and events, including `files:write`
for `slack_upload`. `slack_schedule` uses Slack's existing `chat:write` scope, so
no extra manifest scope is required. Use it when creating the app (**From a
manifest**) or paste it into **App Manifest** in settings.

To push the checked-in manifest back to Slack, run:

```bash
pnpm deploy:slack
```

The deploy command validates `slack-bridge/manifest.yaml`, updates the target
Slack app through `apps.manifest.update`, and reports any bot/user scope
changes.

## Security

Set `allowedUsers` in settings.json to restrict who can interact with the
agent. Only listed users' messages are queued; others receive a polite
rejection. If not set, all users are allowed.

Find user IDs in Slack: click a user's profile → **More** → **Copy member ID**.

## Architecture

- **Socket Mode** — outbound WebSocket from pi to Slack (no public URL needed)
- **Zero npm deps** — native `fetch` + `WebSocket` (Node 22+)
- **Hybrid inbox** — queue when busy, auto-process when idle
- **Reactions** — 👀 as lightweight "thinking" indicator (no chat lock)
- **Agent naming** — LLM picks a fun name + emoji per task

## Pinet control commands

Use these local commands to control another connected Pinet agent by name or ID:

- `/pinet-reload <agent>` — ask the target agent to reload cleanly
- `/pinet-exit <agent>` — ask the target agent to disconnect cleanly and exit

Agents can also send the exact A2A message `/reload` or `/exit` via `pinet_message`; the
receiver handles it automatically instead of surfacing it to the LLM as normal work.

## Status

Use `/slack` in pi to check connection status, active threads, and DM channel.

Footer shows `slack ✦` when connected, with unread count (e.g. `slack ✦ 3`).
