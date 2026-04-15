# slack-bridge (Pinet)

Slack assistant integration for [pi](https://github.com/badlogic/pi-mono) — multi-agent broker, thread routing, and inbox tools powered by Socket Mode.

## Install

```bash
pi install npm:@gugu910/pi-slack-bridge
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
files:read           files:write          groups:history
groups:read          im:history           im:read
im:write             pins:read            pins:write
reactions:read       reactions:write      users:read
```

`files:read` is required because Slack exposes canvas comment pagination through `files.info`, even when the target is first validated via canvas-specific APIs.

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

### Optional Pinet mesh auth

Shared-secret mesh auth is **optional**. You can configure it with either settings keys or environment variables:

```json
{
  "slack-bridge": {
    "meshSecret": "shared-secret"
  }
}
```

```json
{
  "slack-bridge": {
    "meshSecretPath": "/Users/alice/.config/pi/pinet.secret"
  }
}
```

```bash
export PINET_MESH_SECRET="shared-secret"
# or
export PINET_MESH_SECRET_PATH="$HOME/.config/pi/pinet.secret"
```

Behavior and precedence:

- `slack-bridge.meshSecret` and `slack-bridge.meshSecretPath` override the environment fallbacks.
- Inline secrets win over secret paths. If `meshSecret` or `PINET_MESH_SECRET` is set, the corresponding `*Path` value is ignored.
- If all four values are unset, broker/follower mesh auth is disabled.
- A broker started with `meshSecretPath` creates the secret file if it does not exist yet.
- A follower started with `meshSecretPath` does **not** create the file. If the configured file is missing, follow fails with a clear error telling you to point at an existing file, provide `meshSecret` directly, or leave both unset to disable shared-secret auth.
- A follower configured for mesh auth will fail closed against an older/no-auth broker with a clear compatibility error. It will **not** silently retry as an unauthenticated follower.

### Full settings reference

```json
{
  "slack-bridge": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "runtimeMode": "single",
    "allowedUsers": ["U_EXAMPLE_MEMBER_ID"],
    "defaultChannel": "C_EXAMPLE_CHANNEL_ID",
    "logChannel": "#pinet-logs",
    "logLevel": "actions",
    "autoFollow": true,
    "meshSecretPath": "/Users/alice/.config/pi/pinet.secret",
    "suggestedPrompts": [{ "title": "Status", "message": "What are you working on?" }],
    "security": {
      "readOnly": false,
      "requireConfirmation": ["slack_create_channel"],
      "blockedTools": []
    }
  }
}
```

Slack access is now **default-deny** unless you configure one of these explicitly:

- `allowedUsers` / `SLACK_ALLOWED_USERS` — allow only specific Slack user IDs
- `allowAllWorkspaceUsers: true` / `SLACK_ALLOW_ALL_WORKSPACE_USERS=true` — explicit workspace-wide opt-in

| Key                            | Required | Description                                                                                                        |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `botToken`                     | **yes**  | Bot User OAuth Token (`xoxb-...`)                                                                                  |
| `appToken`                     | **yes**  | App-Level Token for Socket Mode (`xapp-...`)                                                                       |
| `allowedUsers`                 | no       | Slack user IDs that can interact; when unset, access is denied unless `allowAllWorkspaceUsers` is true             |
| `allowAllWorkspaceUsers`       | no       | Explicit opt-in for workspace-wide Slack access when you do not want a user allowlist                              |
| `defaultChannel`               | no       | Default channel for `slack_post_channel`                                                                           |
| `logChannel`                   | no       | Channel for broker activity logs                                                                                   |
| `logLevel`                     | no       | `"errors"`, `"actions"` (default), or `"verbose"`                                                                  |
| `runtimeMode`                  | no       | Explicit startup mode: `"off"`, `"single"`, `"broker"`, or `"follower"`                                            |
| `autoConnect`                  | no       | Legacy compatibility alias for `runtimeMode: "single"`                                                             |
| `autoFollow`                   | no       | Legacy compatibility alias for follower startup when a broker socket exists                                        |
| `meshSecret`                   | no       | Optional inline Pinet shared secret; overrides `meshSecretPath` and env fallbacks                                  |
| `meshSecretPath`               | no       | Optional path to a shared-secret file; broker creates it if missing, followers require an existing file            |
| `suggestedPrompts`             | no       | Prompts shown when a user opens a new conversation                                                                 |
| `security.readOnly`            | no       | Runtime-block write-capable tools for Slack-triggered turns, including core tools like `bash`, `edit`, and `write` |
| `security.requireConfirmation` | no       | Runtime-require Slack approval before matching tools execute; core tools need a specific Slack thread context      |
| `security.blockedTools`        | no       | Runtime-block matching tools for Slack-triggered turns, including core tools                                       |

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

When running as a **broker**, Slack threads now get explicit operational visibility:

- periodic `⏳` progress updates while a turn is still running
- per-attempt error updates when an assistant turn errors
- a final failure summary with retry count and provider/model context
- automatic pause messaging for terminal provider errors (for example usage/auth failures)

### Available tools

| Tool                         | Description                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `slack_send`                 | Reply in a Slack assistant thread                                                 |
| `slack_react`                | Add an emoji reaction to a message                                                |
| `slack_read`                 | Read messages from a thread                                                       |
| `slack_inbox`                | Check pending incoming messages                                                   |
| `slack_upload`               | Upload files, snippets, or diffs into Slack                                       |
| `slack_schedule`             | Schedule a message for later delivery                                             |
| `slack_post_channel`         | Post to a channel (by name or ID)                                                 |
| `slack_read_channel`         | Read channel history or a thread in a channel                                     |
| `slack_create_channel`       | Create a new Slack channel                                                        |
| `slack_project_create`       | Create a project channel + RFC canvas + bot invite in one call                    |
| `slack_pin`                  | Pin or unpin a message                                                            |
| `slack_bookmark`             | Add, list, or remove channel bookmarks                                            |
| `slack_export`               | Export a thread as markdown, plain text, or JSON                                  |
| `slack_presence`             | Check if users are active, away, or in DND                                        |
| `slack_canvas_comments_read` | Read comments attached to a verified canvas by canvas ID or channel canvas lookup |
| `slack_canvas_create`        | Create a standalone or channel canvas                                             |
| `slack_canvas_update`        | Append, prepend, or replace canvas content                                        |
| `slack_blocks_build`         | Build Block Kit message templates                                                 |
| `slack_modal_build`          | Build Slack modal templates                                                       |
| `slack_modal_open`           | Open a modal from a trigger interaction                                           |
| `slack_modal_push`           | Push a new step onto a modal stack                                                |
| `slack_modal_update`         | Update an existing open modal                                                     |
| `slack_confirm_action`       | Request user confirmation before a dangerous action                               |

#### Canvas comment inspection

`slack_canvas_comments_read` is intentionally narrow:

- it validates the target with `canvases.sections.lookup` before reading comment pages via `files.info`
- it needs `files:read` because Slack exposes canvas comments through the file API surface
- it will **not** inspect generic Slack files, non-canvas file comments, or full canvas body/history

### Slash commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `/pinet-status` | Show connection status, threads, and agent identity |
| `/pinet-rename` | Change the agent's display name                     |
| `/pinet-logs`   | Show recent broker activity log entries             |
| `/slack-logs`   | Show recent Slack bridge log entries                |

## Runtime modes

`slack-bridge` now treats runtime mode as an explicit concept:

| Mode       | Meaning                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`      | Slack bridge is loaded, but **no Slack Socket Mode ingress** and no coordination runtime are started.                                                                    |
| `single`   | One local Pi session owns Slack ingress and local thread/inbox ownership only. No broker DB/socket/client, no RALPH/control plane, no mesh auth, no multi-agent surface. |
| `broker`   | The session runs the broker coordination runtime.                                                                                                                        |
| `follower` | The session connects to an existing broker as a worker runtime.                                                                                                          |

Startup selection:

- `runtimeMode` is the explicit startup selector.
- `autoConnect` is a legacy compatibility alias for `runtimeMode: "single"`.
- `autoFollow` is a legacy compatibility alias for `runtimeMode: "follower"` when a broker socket is available.
- explicit `runtimeMode` wins over the legacy flags.
- `/pinet-start` and `/pinet-follow` still switch the live session into broker/follower runtimes explicitly.

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

Or set `"runtimeMode": "follower"` in settings (or the legacy `"autoFollow": true`) to auto-connect when a broker is running.

### Multi-agent tools

| Tool             | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| `pinet_message`  | Send a message to a connected Pinet agent or broker-only broadcast channel |
| `pinet_agents`   | List connected Pinet agents with status and capabilities                   |
| `pinet_free`     | Mark this Pinet agent idle/free for new work                               |
| `pinet_schedule` | Schedule a future wake-up for this Pinet agent                             |

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

### Broker in-thread control commands (from Slack)

In any broker-owned Slack thread, you can now send:

- `pinet reload`
- `pinet reload <provider/model>`
- `pinet reload <provider/model> <thinking>`
- `/pinet-reload <provider/model> <thinking>` (plain-text alias when your Slack client forwards slash text)

Examples:

- `pinet reload openai/gpt-5.4`
- `pinet reload openai/gpt-5.4 xhigh`

Behavior:

- aborts the active broker turn (same intent as pressing `Esc` in the TUI)
- applies model/thinking overrides when runtime model controls are available
- reloads the broker runtime in place
- resumes queued inbox work after reload

### How it works

- The **broker** runs Slack Socket Mode, routes messages to agents, monitors health via the RALPH loop, and maintains a control plane canvas
- **Followers** connect to the broker over a local Unix socket, poll for work, and report results
- Agents can optionally authenticate using a shared local secret (`meshSecret` or `meshSecretPath`); when both are unset, mesh auth is disabled
- Thread ownership is first-responder-wins — the first agent to reply claims the thread

## Security

- **User access**: Slack access is default-deny. Set `allowedUsers` for a narrow allowlist, or `allowAllWorkspaceUsers: true` only if you explicitly want workspace-wide access
- **Tool guardrails**: `security.readOnly`, `security.requireConfirmation`, and `security.blockedTools` are runtime-enforced for Slack-triggered turns, including core tools such as `bash`, `edit`, and `write`
- **Mesh authentication**: Optional. Configure `meshSecret` or `meshSecretPath` (or `PINET_MESH_SECRET` / `PINET_MESH_SECRET_PATH`) to require a shared secret; leave them unset to disable shared-secret auth. Configured followers fail closed on missing secret files or older/no-auth brokers rather than silently downgrading.

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

## License

MIT. See [`LICENSE`](./LICENSE).
