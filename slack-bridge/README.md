# slack-bridge (Pinet)

Slack assistant integration for [pi](https://github.com/badlogic/pi-mono) — multi-agent broker, thread routing, and inbox tools powered by Socket Mode.

## Install

```bash
pi install @gugu910/pi-slack-bridge
```

Or with npm:

```bash
npm install @gugu910/pi-slack-bridge
```

## Prerequisites

- A Slack workspace where you have permission to install apps
- Node.js 22+ (uses native `fetch` and `WebSocket`)
- [pi](https://github.com/badlogic/pi-mono) installed

## Slack App Setup

### 1. Create the app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
2. Choose **From a manifest**
3. Select your workspace
4. Paste the contents of [`manifest.yaml`](./manifest.yaml) from this directory
5. Click **Create**

The manifest configures Socket Mode, the assistant view, all required bot scopes, and event subscriptions automatically.

### 2. Generate tokens

You need two tokens:

| Token               | Where to find it                                                                 | Looks like   |
| ------------------- | -------------------------------------------------------------------------------- | ------------ |
| **App-Level Token** | Basic Information → App-Level Tokens → Generate (with `connections:write` scope) | `xapp-1-...` |
| **Bot Token**       | OAuth & Permissions → Install to Workspace → Bot User OAuth Token                | `xoxb-...`   |

### 3. Required bot scopes

These are included in the manifest, but for reference:

```
app_mentions:read    assistant:write      bookmarks:read
bookmarks:write      canvases:read        canvases:write
channels:history     channels:read        chat:write
files:write          groups:history       groups:read
im:history           im:read              im:write
pins:read            pins:write           reactions:read
reactions:write      users:read
```

## Configuration

Add your tokens to `~/.pi/agent/settings.json`:

```json
{
  "slack-bridge": {
    "botToken": "xoxb-your-bot-token",
    "appToken": "xapp-your-app-token"
  }
}
```

That's it for a minimal setup. Start pi and Pinet appears in Slack's sidebar.

### Environment variables (alternative)

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

Settings in `settings.json` take priority over env vars.

### Full settings reference

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedUsers": ["U09GWL270LA"],
    "defaultChannel": "C0APL58LB1R",
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "autoFollow": true,
    "suggestedPrompts": [{ "title": "Status", "message": "What are you working on?" }],
    "security": {
      "readOnly": false,
      "requireConfirmation": ["slack_create_channel"],
      "blockedTools": []
    }
  }
}
```

| Key                            | Required | Description                                           |
| ------------------------------ | -------- | ----------------------------------------------------- |
| `botToken`                     | **yes**  | Bot User OAuth Token (`xoxb-...`)                     |
| `appToken`                     | **yes**  | App-Level Token for Socket Mode (`xapp-...`)          |
| `allowedUsers`                 | no       | Slack user IDs that can interact (all users if unset) |
| `defaultChannel`               | no       | Default channel for `slack_post_channel`              |
| `logChannel`                   | no       | Channel for broker activity logs                      |
| `logLevel`                     | no       | `"errors"`, `"actions"` (default), or `"verbose"`     |
| `autoFollow`                   | no       | Auto-connect as follower when broker is running       |
| `suggestedPrompts`             | no       | Prompts shown when a user opens a new conversation    |
| `security.readOnly`            | no       | Block all write tools                                 |
| `security.requireConfirmation` | no       | Tools that need user approval before executing        |
| `security.blockedTools`        | no       | Tools that are completely disabled                    |

## Usage

Once configured, Pinet appears in Slack's sidebar. Users open it, type a message, and the pi agent responds.

```
User opens Pinet in Slack sidebar
  └─► types a message
        └─► 👀 reaction appears (thinking)
              └─► message queued for pi agent
                    └─► agent responds via slack_send
                          └─► 👀 removed, reply appears in thread
```

Messages queue while the agent is busy. When the agent finishes, it automatically drains the inbox and responds.

### Available tools

| Tool                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `slack_send`           | Reply in a Slack assistant thread                              |
| `slack_react`          | Add an emoji reaction to a message                             |
| `slack_read`           | Read messages from a thread                                    |
| `slack_inbox`          | Check pending incoming messages                                |
| `slack_upload`         | Upload files, snippets, or diffs into Slack                    |
| `slack_schedule`       | Schedule a message for later delivery                          |
| `slack_post_channel`   | Post to a channel (by name or ID)                              |
| `slack_read_channel`   | Read channel history or a thread in a channel                  |
| `slack_create_channel` | Create a new Slack channel                                     |
| `slack_project_create` | Create a project channel + RFC canvas + bot invite in one call |
| `slack_pin`            | Pin or unpin a message                                         |
| `slack_bookmark`       | Add, list, or remove channel bookmarks                         |
| `slack_export`         | Export a thread as markdown, plain text, or JSON               |
| `slack_presence`       | Check if users are active, away, or in DND                     |
| `slack_canvas_create`  | Create a standalone or channel canvas                          |
| `slack_canvas_update`  | Append, prepend, or replace canvas content                     |
| `slack_blocks_build`   | Build Block Kit message templates                              |
| `slack_modal_build`    | Build Slack modal templates                                    |
| `slack_modal_open`     | Open a modal from a trigger interaction                        |
| `slack_modal_push`     | Push a new step onto a modal stack                             |
| `slack_modal_update`   | Update an existing open modal                                  |
| `slack_confirm_action` | Request user confirmation before a dangerous action            |

### Slash commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `/pinet-status` | Show connection status, threads, and agent identity |
| `/pinet-rename` | Change the agent's display name                     |
| `/pinet-logs`   | Show recent broker activity log entries             |
| `/slack-logs`   | Show recent Slack bridge log entries                |

## Pinet (Multi-Agent Mode)

Pinet supports a broker/follower architecture for coordinating multiple pi agents over Slack.

### Quick start

**Broker** (one per mesh — coordinates routing and health):

```
/pinet-start
```

**Follower** (workers that connect to the broker):

```
/pinet-follow
```

Or set `"autoFollow": true` in settings to auto-connect when a broker is running.

### Multi-agent tools

| Tool             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `pinet_message`  | Send a message to another connected agent             |
| `pinet_agents`   | List connected agents with status and capabilities    |
| `pinet_free`     | Signal that this agent is idle and available for work |
| `pinet_schedule` | Schedule a future wake-up message for this agent      |

### Broker commands

| Command                 | Description                                |
| ----------------------- | ------------------------------------------ |
| `/pinet-start`          | Start as the mesh broker                   |
| `/pinet-follow`         | Connect as a follower worker               |
| `/pinet-unfollow`       | Disconnect from the broker                 |
| `/pinet-reload <agent>` | Ask another agent to reload                |
| `/pinet-exit <agent>`   | Ask another agent to exit                  |
| `/pinet-free`           | Mark this agent as idle                    |
| `/pinet-skin <theme>`   | Change the mesh naming theme (broker only) |

### How it works

- The **broker** runs Slack Socket Mode, routes messages to agents, monitors health via the RALPH loop, and maintains a control plane canvas
- **Followers** connect to the broker over a local Unix socket, poll for work, and report results
- Agents authenticate using a shared local secret (`~/.pi/pinet.secret`, created automatically)
- Thread ownership is first-responder-wins — the first agent to reply claims the thread

## Security

- **User allowlist**: Set `allowedUsers` to restrict who can interact with Pinet
- **Tool guardrails**: Use `security.requireConfirmation` and `security.blockedTools` to control tool access
- **Mesh authentication**: Broker/follower connections use a local shared secret file

Find Slack user IDs: click a user's profile → **More** → **Copy member ID**.

---

## Development

### Build

```bash
pnpm run build
```

### Lint / Typecheck / Test

```bash
pnpm lint
pnpm typecheck
pnpm test
```

### Deploy manifest to Slack

```bash
pnpm deploy:slack
```

Requires `appId` and `appConfigToken` in settings (or `SLACK_APP_ID` / `SLACK_APP_CONFIG_TOKEN` env vars).

### Architecture

- **Socket Mode** — outbound WebSocket, no public URL needed
- **Zero runtime npm deps** — native `fetch`, `WebSocket`, `node:sqlite` (Node 22+)
- **Hybrid inbox** — queue when busy, auto-drain when idle
- **Reactions** — 👀 as a lightweight "thinking" indicator
- **Thread persistence** — thread state survives `/reload`
