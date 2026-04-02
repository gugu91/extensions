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
| `slack_send(text, thread_ts?, blocks?)`                                             | Reply in a thread or start new               |
| `slack_react(emoji, thread_ts?, timestamp?, channel?)`                              | Add an emoji reaction to a Slack message     |
| `slack_presence(user?, users?)`                                                     | Check active/away/DND status for Slack users |
| `slack_upload(content?, path?, filename?, filetype?, title?, channel?, thread_ts?)` | Upload a file/snippet into Slack or a thread |
| `slack_schedule(text, channel?, thread_ts?, delay?, at?)`                           | Schedule a Slack message for later           |
| `slack_pin(action, message_ts, channel?, thread_ts?)`                               | Pin or unpin a Slack message                 |
| `slack_bookmark(action, channel?, thread_ts?, title?, url?, emoji?, bookmark_id?)`  | Add, list, or remove channel bookmarks       |
| `slack_export(thread_ts, channel?, format?, include_metadata?, oldest?, latest?)`   | Export a Slack thread for docs or archival   |
| `slack_read(thread_ts, limit?)`                                                     | Read thread messages                         |
| `slack_inbox()`                                                                     | Check pending messages manually              |
| `slack_blocks_build(template, ...)`                                                 | Build common Block Kit payloads              |
| `slack_modal_build(template, ...)`                                                  | Build common Slack modal payloads            |
| `slack_modal_open(trigger_id, view, thread_ts?)`                                    | Open a Slack modal                           |
| `slack_modal_push(trigger_id, view, thread_ts?)`                                    | Push a new modal step onto the stack         |
| `slack_modal_update(view, view_id?, external_id?, hash?, thread_ts?)`               | Update an existing open modal                |
| `slack_create_channel(name, topic?, purpose?)`                                      | Create a project channel                     |
| `slack_post_channel(channel?, text, thread_ts?, blocks?)`                           | Post to a channel                            |
| `slack_read_channel(channel, thread_ts?, limit?)`                                   | Read channel history or thread               |
| `slack_canvas_create(title?, markdown?, channel?, kind?)`                           | Create standalone or channel canvases        |
| `slack_canvas_update(canvas_id?, channel?, markdown, mode?, ...)`                   | Append, prepend, or replace canvas content   |

`slack_upload` supports either inline `content` or a guarded local `path`. For
safety, local uploads are limited to files inside the current working directory
or the system temp directory.

`slack_schedule` supports delayed messages via `delay` (for example `30m` or
`2h`) and absolute scheduling via `at` (ISO-8601 UTC timestamp).

`slack_pin` highlights a specific Slack message by timestamp. `slack_bookmark`
manages durable channel-header links such as repos, dashboards, docs, and
runbooks.

`slack_export` turns a thread into markdown, plain text, or JSON with resolved
authors, timestamps, and attachment links so it can be archived into docs,
files, canvases, or follow-up summaries.

`slack_presence` checks one or more Slack users via `users.getPresence` and
`dnd.info`, so the agent can see whether people are active, away, or currently
in Do Not Disturb before sending review requests or other pings. It accepts a
single `user` or batch `users`, supports user IDs / mentions / names, and uses
a short cache to avoid hammering Slack.

## Features

- **Slack Assistant** — appears in Slack's sidebar, native conversation UI
- **Queued inbox** — messages don't interrupt the agent mid-task
- **Auto-drain** — inbox processed when agent is idle or finishes a task
- **Reactions** — 👀 on receive, removed on reply; reaction-triggered commands can queue work from emoji alone
- **Suggested prompts** — shown when a user opens a new conversation
- **Multi-user** — handles concurrent conversations from different users
- **@mentions** — tag Pinet in any channel and it responds in-thread
- **Channel & canvas tools** — create/read/post in channels and maintain persistent Slack canvases
- **Broker control plane canvas** — the broker can maintain a live Slack canvas with agent roster, task/PR state, and RALPH health on every cycle
- **Block Kit messages** — send rich Slack layouts via the optional `blocks` parameter
- **Interactive workflows** — `block_actions` button clicks and `view_submission` modal submits are routed back into the inbox as structured events
- **Slack modals** — open, push, and update modal views for confirmations, forms, and multi-step workflows
- **File & snippet uploads** — share diffs, logs, screenshots, exports, and long code snippets without pasting giant messages
- **Scheduled & delayed messages** — queue reminders, timed announcements, and follow-ups without waiting around
- **Pins & bookmarks** — highlight key messages and manage durable channel-header links
- **Presence-aware messaging** — check whether teammates are active, away, or in DND before pinging them
- **Thread export & archival** — convert Slack threads into reusable markdown, plain text, or JSON
- **Activity log channel** — broker-side assignments, completions, merges, stalls, and RALPH events can be mirrored into a dedicated Slack log thread
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
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "controlPlaneCanvasEnabled": true,
    "controlPlaneCanvasChannel": "C0APL58LB1R",
    "controlPlaneCanvasTitle": "Pinet Broker Control Plane",
    "reactionCommands": {
      "📝": "summarize",
      "🐛": "file-issue",
      "👀": "review",
      "✅": "approve",
      "🔄": "retry"
    },
    "suggestedPrompts": [
      { "title": "Status", "message": "What are you working on?" },
      { "title": "Help", "message": "I need help with something" }
    ]
  }
}
```

| Key                         | Required | Description                                                                |
| --------------------------- | -------- | -------------------------------------------------------------------------- |
| `botToken`                  | yes      | Bot User OAuth Token (`xoxb-...`)                                          |
| `appToken`                  | yes      | App-Level Token for Socket Mode (`xapp-...`)                               |
| `appId`                     | deploy   | Slack app ID (`A...`) for manifest deploy/update                           |
| `appConfigToken`            | deploy   | App configuration token (`xoxe.xoxp-...`)                                  |
| `allowedUsers`              | no       | Slack user IDs allowed to interact                                         |
| `defaultChannel`            | no       | Default channel for `slack_post_channel` and control-plane canvas fallback |
| `logChannel`                | no       | Broker activity log channel name or ID                                     |
| `logLevel`                  | no       | `errors`, `actions` (default), or `verbose`                                |
| `controlPlaneCanvasEnabled` | no       | Enable the broker-maintained control plane canvas (defaults to true)       |
| `controlPlaneCanvasId`      | no       | Existing canvas ID to update instead of creating/finding a channel canvas  |
| `controlPlaneCanvasChannel` | no       | Channel ID/name used to create or recover the broker control plane canvas  |
| `controlPlaneCanvasTitle`   | no       | Title used when the broker creates the control plane canvas                |
| `reactionCommands`          | no       | Emoji/name → action mapping for `reaction_added`                           |
| `suggestedPrompts`          | no       | Prompts shown on new assistant thread                                      |

> Runtime tokens can also be set via `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
> env vars (settings.json takes priority).
>
> Manifest deploy also reads `SLACK_APP_ID` and `SLACK_APP_CONFIG_TOKEN`
> (or `SLACK_CONFIG_TOKEN`). The Socket Mode `xapp-...` token cannot be used
> with `apps.manifest.update`.
>
> If `controlPlaneCanvasId` is not set, the broker will try to create or recover a
> channel canvas from `controlPlaneCanvasChannel`, falling back to `defaultChannel`.

`reactionCommands` accepts either Slack reaction names (`eyes`, `repeat`) or the
emoji characters themselves (`👀`, `🔄`). The default mappings include `📝`
→ summarize and `🐛` → file-issue, and you can extend them with review /
approve / retry style actions as needed.

`logChannel` enables a broker-only observability feed. When configured, the
broker posts structured activity updates into a daily thread in that channel.
Default `logLevel` is `actions`, which captures worker task assignments,
completion/PR-open transitions, merges, stalls, maintenance anomalies, and
RALPH events. Use `errors` for failures only or `verbose` to also include
routine broker/worker status chatter.

### 4. Install extension

```bash
ln -s /path/to/extensions/slack-bridge ~/.pi/agent/extensions/slack-bridge
```

Then `/reload` in pi. Pinet appears in Slack's sidebar automatically.

## Manifest

The `manifest.yaml` includes all required scopes and events, including `files:write`
for `slack_upload`, `chat:write` for `slack_schedule`, bookmark/pin scopes for
`slack_bookmark` and `slack_pin`, `users:read` + `users.getPresence` / `dnd.info`
for presence checks, `reaction_added` + `reactions:read` plus `presence_change`
for Slack-side awareness events, and `interactivity.is_enabled: true` for buttons
and modals. Use it when creating the app (**From a manifest**) or paste it into
**App Manifest** in settings.

To push the checked-in manifest back to Slack, run:

```bash
pnpm deploy:slack
```

The deploy command validates `slack-bridge/manifest.yaml`, updates the target
Slack app through `apps.manifest.update`, and reports any bot/user scope
changes.

## Block Kit examples

Use `slack_blocks_build` for common templates, or pass raw Block Kit JSON directly to `slack_send` / `slack_post_channel`.

Example `slack_send` payload:

```json
{
  "thread_ts": "123.456",
  "text": "Deploy complete",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Deploy complete*\nBranch: `main`\nCommit: `abc123`"
      }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Rollback" },
          "action_id": "deploy.rollback",
          "style": "danger",
          "value": "rollback:prod"
        }
      ]
    }
  ]
}
```

Button clicks arrive back through the inbox as structured events with metadata like `kind=slack_block_action`, `triggerId`, `actionId`, `value`, and best-effort `parsedValue` when the button value is JSON.

## Modal workflows

Use `slack_modal_build` to generate common modal payloads, then pass the returned `view`
into `slack_modal_open`, `slack_modal_push`, or `slack_modal_update`.

- `slack_modal_open` / `slack_modal_push` need a fresh `trigger_id` from a recent
  Slack interaction (button click or modal submit). Trigger IDs expire after roughly
  3 seconds, so if Slack returns `invalid_trigger`, ask the user to click again and
  reopen the modal immediately.
- Pass `thread_ts` when opening or pushing a modal if you want later `view_submission`
  payloads routed back into the original Slack thread.
- Modal submissions arrive through the inbox as `kind=slack_view_submission` with
  `callbackId`, `viewId`, and parsed `stateValues`.

Example `slack_modal_build` confirmation request:

```json
{
  "template": "confirmation",
  "title": "Deploy approval",
  "text": "Ready to deploy to production.",
  "confirm_phrase": "CONFIRM",
  "callback_id": "deploy.confirm"
}
```

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
- **Agent naming** — Pinet can keep the default whimsical mesh skin or regenerate themed names/personalities for the whole mesh

## Pinet control commands

Use these local commands to control another connected Pinet agent by name or ID:

- `/pinet-reload <agent>` — ask the target agent to reload cleanly
- `/pinet-exit <agent>` — ask the target agent to disconnect cleanly and exit
- `/pinet-free` — mark this agent idle/free and available for new work
- `/pinet-logs` / `/slack-logs` — show the most recent broker activity log entries captured this session
- `/pinet-skin <theme>` — broker-only mesh skin switch; `default` keeps the whimsical built-in skin, any other free-form theme regenerates themed names and personalities for the connected mesh

Agents can also send the exact A2A message `/reload` or `/exit` via `pinet_message`; the
receiver handles it automatically instead of surfacing it to the LLM as normal work.
When a worker finishes all assigned work, it can call the `pinet_free` tool (or `/pinet-free`)
to explicitly signal availability for new assignments.

## Status

Use `/slack` in pi to check connection status, active threads, and DM channel.

Footer shows `slack ✦` when connected, with unread count (e.g. `slack ✦ 3`).
