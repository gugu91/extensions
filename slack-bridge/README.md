# slack-bridge

Pi extension that turns the agent into a Slack assistant app. Users open the
assistant from Slack's sidebar, type a message, and the pi agent responds — no
channel setup required.

## How it works

```
User opens assistant in Slack
  └─► types a message
        └─► "is thinking…" status shown
              └─► forwarded to pi agent
                    └─► agent responds via slack_send
                          └─► reply appears in Slack thread
```

- **`slack_send`** — reply in an assistant thread (or start a new one)
- **`slack_read`** — read messages from a thread
- **Socket Mode** — real-time bidirectional via WebSocket
- **Suggested prompts** — shown when a user opens a new thread
- **Thinking status** — shown while the agent works, cleared on reply

## Setup

### 1. Create a Slack App

https://api.slack.com/apps → **Create New App** → **From scratch**.

### 2. Enable the Assistant

**Agents & Assistants** → toggle on.

### 3. Enable Socket Mode

**Socket Mode** → Enable.
**Basic Information → App-Level Tokens** → Generate one with `connections:write` scope.

### 4. Bot token scopes

**OAuth & Permissions → Bot Token Scopes:**

| Scope             | Why                           |
| ----------------- | ----------------------------- |
| `assistant:write` | Set status, suggested prompts |
| `chat:write`      | Send messages                 |
| `im:history`      | Read DM messages              |
| `im:read`         | Receive DM events             |
| `users:read`      | Resolve user names            |

### 5. Event subscriptions

**Event Subscriptions** → Enable → **Subscribe to bot events:**

- `assistant_thread_started`
- `assistant_thread_context_changed`
- `message.im`

### 6. Install to workspace

**Install App** → Install to your workspace.

### 7. Set env vars

```bash
export SLACK_BOT_TOKEN="xoxb-..."   # Bot User OAuth Token
export SLACK_APP_TOKEN="xapp-..."   # App-Level Token (Socket Mode)
```

That's it. No channel config — the assistant appears in Slack's sidebar automatically.

## Usage

The agent gets two tools:

```
slack_send(text, thread_ts?)   — reply in a thread or start new
slack_read(thread_ts, limit?)  — read thread messages
```

When a user messages the assistant, the message is forwarded to the pi session.
The agent responds by calling `slack_send` with the `thread_ts` from the
incoming message.

`/slack` in pi shows connection status.

## Zero dependencies

Native `fetch` + `WebSocket` (Node 22+). No npm packages.
