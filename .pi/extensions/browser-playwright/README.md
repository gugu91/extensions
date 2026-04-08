# browser-playwright

A project-local Pi extension that gives agents reusable host-side browser access through Playwright.

It is designed for real browsing and lightweight web interaction, not just test automation:

- start and reuse browser sessions across tool calls
- navigate public sites
- snapshot and extract page content
- click, fill, press, wait, inspect tabs, and capture screenshots
- keep screenshots and artifacts inside the workspace
- block localhost and private/internal network targets by default

## Location

This extension lives at:

- `.pi/extensions/browser-playwright/`

Pi auto-discovers extensions from `.pi/extensions/`, so this extension becomes available after reload.

## Enable in this workspace

From the repo root:

```bash
pi
/reload
```

Or start a fresh Pi session in the repo after the files exist.

## Install Playwright

If the extension has not been installed yet, install its local dependencies from the extension directory:

```bash
cd .pi/extensions/browser-playwright
npm install
npx playwright install chromium
```

Chromium is the default engine. If you start a session with `browser: "firefox"` or
`browser: "webkit"`, install matching browser binaries instead:

```bash
npx playwright install firefox
npx playwright install webkit
```

The extension intentionally fails with exact engine-aware commands when:

- the `playwright` package is missing
- the requested browser engine binaries are missing

## Security defaults

The extension is safe by default.

Allowed by default:

- `http://...`
- `https://...`
- public internet targets

Blocked by default:

- `localhost`
- `127.0.0.1`
- `::1`
- private IPv4 ranges like `10.x`, `172.16-31.x`, `192.168.x`
- link-local / internal ranges when detectable
- obvious internal hostnames like `*.local`, `*.internal`, `host.docker.internal`, and single-label internal names
- non-HTTP(S) protocols

Opt-in overrides for trusted development workflows:

```bash
export BROWSER_ALLOW_LOCALHOST=true
export BROWSER_ALLOW_PRIVATE_NETWORK=true
```

Recommended practice:

- keep both flags unset for public-web browsing
- enable them only for a trusted local app or private-network target
- unset them again after that workflow

## Session model

- sessions are stored in memory and keyed by `session_id`
- each session owns one Playwright browser + one browser context
- each session can contain multiple tabs/pages keyed by `page_id`
- `browser_navigate` can reuse the active tab or open a new one
- `browser_tabs` lists pages and can switch the active page
- `browser_close` can close a tab or the entire session
- sessions are cleaned up on Pi shutdown
- idle sessions are also swept automatically after `BROWSER_PLAYWRIGHT_IDLE_TIMEOUT_MS` (default: 15 minutes)
- saved login state reuse is **explicit opt-in only** via Playwright `storageState` JSON import

Important limitations:

- live browser sessions are still process-local and in-memory only
- a Pi reload or process restart still drops live browser sessions
- only explicit Playwright `storageState` JSON reuse is supported — not arbitrary browser-profile mounting
- storage state is never auto-saved on close, reload, or shutdown

## Stored browser state

Saved Playwright login/session state is supported in a deliberately narrow, safety-first way.

How it works:

- place a trusted Playwright `storageState` JSON file under `.pi/state/browser-playwright/`
- reuse it explicitly by passing `storage_state_name` to `browser_session_start`
- names are sanitized to `<name>.json`
- raw cookies / localStorage values are **not** echoed in tool output

Current scope:

- explicit **import/reuse** is supported
- built-in export/save is intentionally **not** provided in this first safety-focused version
- browser state is never auto-saved on close, reload, or shutdown

Guardrails:

- no arbitrary absolute host paths
- no directory traversal inputs
- no symlink escapes for saved state files or the saved-state root
- no automatic persistence of auth state

Treat `.pi/state/browser-playwright/` as secret-bearing auth material:

- do not commit it
- do not share it casually
- delete saved state files when they are no longer needed

## Artifacts

Screenshots are written under:

- `.pi/artifacts/browser-playwright/`

Current screenshot layout:

- `.pi/artifacts/browser-playwright/<session_id>/<timestamp>-<label>.png`

`browser_screenshot` returns structured metadata including:

- `path`
- `url`
- `title`
- `timestamp`
- `full_page`

## Tool surface

Required tools provided:

1. `browser_session_start`
2. `browser_session_info`
3. `browser_navigate`
4. `browser_snapshot`
5. `browser_extract`
6. `browser_click`
7. `browser_fill`
8. `browser_press`
9. `browser_wait_for`
10. `browser_screenshot`
11. `browser_tabs`
12. `browser_close`

## Usage flows

### 1. Navigate to a public docs site and extract text

```json
{ "session_id": "<from browser_session_start>", "url": "https://example.com" }
```

Tool: `browser_navigate`

```json
{ "session_id": "<session_id>" }
```

Tool: `browser_snapshot`

```json
{ "session_id": "<session_id>", "selector": "h1" }
```

Tool: `browser_extract`

### 2. Search a public site and take a screenshot

```json
{ "session_id": "<session_id>", "url": "https://duckduckgo.com" }
```

Tool: `browser_navigate`

```json
{ "session_id": "<session_id>", "selector": "input[name='q']", "value": "Playwright docs" }
```

Tool: `browser_fill`

```json
{ "session_id": "<session_id>", "key": "Enter" }
```

Tool: `browser_press`

```json
{ "session_id": "<session_id>", "text": "Playwright", "timeout_ms": 10000 }
```

Tool: `browser_wait_for`

```json
{ "session_id": "<session_id>", "label": "search-results", "full_page": true }
```

Tool: `browser_screenshot`

### 3. Reuse a trusted saved `storageState` JSON file

Place a trusted Playwright `storageState` JSON file at:

- `.pi/state/browser-playwright/github-login.json`

Then start a new session that reuses that saved state:

```json
{ "storage_state_name": "github-login" }
```

Tool: `browser_session_start`

This is explicit opt-in only. The extension does not auto-save state, and tool output does not print raw cookies or localStorage values.

### 4. Trusted local app after explicit opt-in

First opt in:

```bash
export BROWSER_ALLOW_LOCALHOST=true
```

Then navigate:

```json
{ "session_id": "<session_id>", "url": "http://localhost:3000" }
```

Tool: `browser_navigate`

Without the env opt-in, that navigation is blocked.

## Notes for agents

- start with `browser_session_start`
- reuse the same `session_id` for a multi-step browsing task
- keep `page_id` from previous results when a task depends on a specific tab
- use `browser_snapshot` before interacting when you need a quick page map
- use `browser_extract` for selector-specific text/attribute reads
- close sessions you no longer need with `browser_close`
