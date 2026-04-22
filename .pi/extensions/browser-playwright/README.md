# browser-playwright

A Pi browser extension built around **one typed tool only**.

Instead of exposing a wide `browser_*` family, the extension now exposes a
single `browser` tool with a shared envelope:

- `backend`
- `action`
- `session_id?`
- `page_id?`
- `input_json?`

The extension owns the runtime, process, proxy, socket, and artifact complexity
behind that one interface.

## Goals

- radically reduce the public browser tool surface
- keep browser support feeling like one narrow ARC/comment channel
- keep Playwright as the real working backend
- add an explicit `agent-browser` adapter slot behind the same contract
- avoid pretending both backends have identical capabilities in every sandbox

## Public tool contract

Tool: `browser`

Parameters:

- `backend` — optional, `playwright` or `agent-browser` (defaults to `playwright`)
- `action` — typed enum:
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
- `session_id` — optional session handle for actions that operate on an existing session
- `page_id` — optional page/tab handle for actions that target a specific page
- `input_json` — optional JSON object with action-specific inputs such as `url`,
  `selector`, `value`, `timeout_ms`, `label`, or `full_page`

## Response shape

Every call returns one shared envelope:

- `backend`
- `action`
- `session_id`
- `page_id`
- `capabilities`
- `result`
- `artifacts`

This keeps backend differences explicit instead of overpromising parity.

## Backend status

### `backend=playwright`

This is the **real working backend** in this extension today.

Supported actions:

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

### `backend=agent-browser`

This backend is **scaffolded behind the same contract**, but in this sandbox it
returns a capability-aware blocked/unavailable result instead of pretending the
old daemon/CLI path is viable.

Current blocker is specific and technical, not a missing adapter shape:

- the published `agent-browser` npm package is CLI/bin-oriented and does not
  currently expose a stable importable JS SDK entrypoint for the documented
  BrowserManager-style API
- the local runtime uses a client-daemon architecture, and in this Unix sandbox
  the daemon fails on startup because binding its local session socket returns
  `EPERM` / `Operation not permitted`

Truthful posture in this harness:

- `backend=playwright` is the real local backend
- `backend=agent-browser` stays explicitly unavailable-locally
- the only viable future support shape here is **remote/optional executor**
  unless upstream ships a real published embeddable JS SDK

That means a future backend can still be honest in one of two ways:

- consume a real published JS SDK if/when upstream exposes one
- wrap the CLI/runtime in an approved **remote** environment (for example an
  external sandbox/runtime) instead of assuming the local Unix daemon path is
  always allowed

## Playwright runtime behavior

The underlying Playwright runtime remains the same safety-first host browser
implementation:

- reusable in-memory sessions keyed by `session_id`
- multiple tabs/pages keyed by `page_id`
- safe public-web defaults
- direct localhost top-level navigation allowed by default for local-app testing
- localhost/private-network subrequest guardrails remain enforced
- screenshots saved under `.pi/artifacts/browser-playwright/`
- explicit storage-state reuse from `.pi/state/browser-playwright/`

## Example requests

### Start a session

```json
{
  "backend": "playwright",
  "action": "start",
  "input_json": "{\"url\":\"https://example.com\"}"
}
```

### Navigate in an existing session

```json
{
  "backend": "playwright",
  "action": "navigate",
  "session_id": "browser_123",
  "input_json": "{\"url\":\"https://example.com/docs\",\"new_tab\":true}"
}
```

### Fill a field

```json
{
  "backend": "playwright",
  "action": "fill",
  "session_id": "browser_123",
  "page_id": "page_abc",
  "input_json": "{\"selector\":\"input[name='q']\",\"value\":\"Playwright docs\"}"
}
```

### Wait for text

```json
{
  "backend": "playwright",
  "action": "wait",
  "session_id": "browser_123",
  "input_json": "{\"text\":\"Playwright\",\"timeout_ms\":10000}"
}
```

### Capture a screenshot

```json
{
  "backend": "playwright",
  "action": "screenshot",
  "session_id": "browser_123",
  "input_json": "{\"label\":\"search-results\",\"full_page\":true}"
}
```

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
- reuse one explicitly via the `start` action and `storage_state_name` inside `input_json`
- the extension never auto-saves browser state on close or shutdown

Treat `.pi/state/browser-playwright/` as secret-bearing auth material.

## Artifacts

Screenshots are written under:

- `.pi/artifacts/browser-playwright/`

Current layout:

- `.pi/artifacts/browser-playwright/<session_id>/<timestamp>-<label>.png`

Screenshot responses include an `artifacts` array in the shared envelope.

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
