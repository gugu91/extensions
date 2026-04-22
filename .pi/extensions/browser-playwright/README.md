# browser-playwright

A Pi browser extension built around **one tool only**.

Instead of exposing a wide `browser_*` tool surface, the extension now exposes a
single `browser` tool that acts as a narrow command/channel into the browser
runtime. The extension owns the session, security, artifact, proxy, and runtime
complexity behind that one interface.

## Goals

- radically reduce the browser tool surface
- keep browser support feeling like one narrow ARC/comment channel
- preserve the existing safe Playwright runtime underneath
- make room for a second backend mode: `agent-browser`

## Current modes

The single tool supports two runtime modes:

- `playwright` — **implemented now** in this extension
- `agent-browser` — **scaffolded behind the same contract**, but may report a
  runtime blocker in environments where the SDK/runtime path is not available

## Tool contract

Tool: `browser`

Parameters:

- `mode` — optional, `playwright` or `agent-browser` (defaults to `playwright`)
- `session_id` — optional session handle for commands that operate on an
  existing session
- `page_id` — optional page/tab handle for commands that target a specific page
- `command` — the command-channel message sent to the runtime
- `payload_json` — optional JSON object merged with inline command arguments

### Command style

Use concise command messages with inline `key=value` arguments.

Examples:

```json
{ "command": "start url=https://example.com" }
```

```json
{ "session_id": "browser_123", "command": "navigate url=https://example.com/docs new_tab=true" }
```

```json
{ "session_id": "browser_123", "page_id": "page_abc", "command": "click selector=button" }
```

If quoting is awkward, pass structured arguments through `payload_json`:

```json
{
  "session_id": "browser_123",
  "command": "fill",
  "payload_json": "{\"page_id\":\"page_abc\",\"selector\":\"input[name='q']\",\"value\":\"Playwright docs\"}"
}
```

## Implemented Playwright commands

Supported commands in `mode=playwright`:

- `start`
- `info`
- `navigate`
- `snapshot`
- `extract`
- `click`
- `fill`
- `press`
- `wait`
- `screenshot`
- `tabs`
- `close`

Legacy command names like `browser_navigate` and `browser_wait_for` are accepted
as aliases **inside the single tool command channel**, but the extension does
not register those old tools anymore.

## Playwright runtime behavior

The underlying Playwright runtime is still the same safety-first host browser
implementation:

- reusable in-memory sessions keyed by `session_id`
- multiple tabs/pages keyed by `page_id`
- safe public-web defaults
- direct localhost top-level navigation allowed by default for local-app testing
- localhost/private-network subrequest guardrails remain enforced
- screenshots saved under `.pi/artifacts/browser-playwright/`
- explicit storage-state reuse from `.pi/state/browser-playwright/`

## Enable in this workspace

From the repo root:

```bash
pi
/reload
```

Or start a fresh Pi session in the repo after the files exist.

## Install Playwright

If the extension dependencies are not installed yet:

```bash
cd .pi/extensions/browser-playwright
npm install
```

For the default `chromium` engine, the extension prefers a host
Chrome/Chromium executable automatically when one is available.

If no compatible host browser is available, install the matching Playwright
browser binaries:

```bash
npx playwright install chromium
npx playwright install firefox
npx playwright install webkit
```

## Security defaults

Allowed by default:

- `http://...`
- `https://...`
- public internet targets
- direct top-level navigation to `localhost`, `127.0.0.1`, and `::1`

Blocked by default:

- localhost subrequests from arbitrary non-localhost pages
- private IPv4 ranges like `10.x`, `172.16-31.x`, `192.168.x`
- link-local / internal ranges when detectable
- obvious internal hostnames like `*.local`, `*.internal`,
  `host.docker.internal`, and single-label internal names
- non-HTTP(S) protocols

Optional env overrides:

```bash
export BROWSER_ALLOW_LOCALHOST=true
export BROWSER_ALLOW_PRIVATE_NETWORK=true
```

## Stored browser state

Saved Playwright login/session state is supported in a narrow, explicit way.

- place trusted Playwright `storageState` JSON files under
  `.pi/state/browser-playwright/`
- reuse one explicitly via the `start` command and `storage_state_name=...`
- the extension never auto-saves browser state on close or shutdown

Treat `.pi/state/browser-playwright/` as secret-bearing auth material.

## Artifacts

Screenshots are written under:

- `.pi/artifacts/browser-playwright/`

Current layout:

- `.pi/artifacts/browser-playwright/<session_id>/<timestamp>-<label>.png`

## Example flows

### Start a session and snapshot a page

```json
{ "command": "start url=https://example.com" }
```

Then:

```json
{ "session_id": "<from previous result>", "command": "snapshot" }
```

### Search and capture a screenshot

```json
{ "command": "start url=https://duckduckgo.com" }
```

```json
{
  "session_id": "<session_id>",
  "command": "fill",
  "payload_json": "{\"selector\":\"input[name='q']\",\"value\":\"Playwright docs\"}"
}
```

```json
{ "session_id": "<session_id>", "command": "press key=Enter" }
```

```json
{ "session_id": "<session_id>", "command": "wait text=Playwright timeout_ms=10000" }
```

```json
{ "session_id": "<session_id>", "command": "screenshot label=search-results full_page=true" }
```

## Development

Type-check the extension:

```bash
cd .pi/extensions/browser-playwright
npm run check
```

Run tests:

```bash
cd .pi/extensions/browser-playwright
npm test
```
