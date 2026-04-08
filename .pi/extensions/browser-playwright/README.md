# browser-playwright

A project-local Pi extension that gives agents reusable host-side browser access through Playwright.

It is designed for real browsing and lightweight web interaction, not just test automation:

- start and reuse browser sessions across tool calls
- navigate public sites
- snapshot and extract page content
- click, fill, press, wait, inspect tabs, and capture screenshots
- explicitly save and later reuse workspace-local Playwright `storageState` JSON
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

Important limitations:

- live browser sessions are still process-local and in-memory only
- a Pi reload or process restart drops live browser sessions
- saved auth reuse is explicit and file-based; it does not keep sessions alive across reloads by itself
- only Playwright `storageState` JSON reuse is supported; arbitrary browser profile mounting is not

## Stored storage state

Explicit auth-state reuse is supported for Playwright `storageState` JSON only.

Import into a new session:

- pass `storage_state_name` to `browser_session_start`

Export from an existing session:

- use `browser_storage_state_save`

Storage-state files are written under:

- `.pi/state/browser-playwright/<name>.json`

Safety rules:

- storage-state files are **secret-bearing auth material**
- storage-state reuse is **explicit opt-in only**
- there is **no** auto-save on session close, Pi reload, or shutdown
- tool results return only safe metadata like the saved path and counts, never raw cookies or token values
- saved-state handling stays workspace-local; arbitrary host paths, traversal, symlink escapes, and browser-profile mounting are not supported
- importing saved auth state does **not** weaken the extension's normal localhost/private-network blocking rules

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
13. `browser_storage_state_save`

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

### 3. Trusted local app after explicit opt-in

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

### 4. Save login state, then reuse it explicitly later

Save state from an authenticated session:

```json
{ "session_id": "<session_id>", "name": "github-login" }
```

Tool: `browser_storage_state_save`

Start a new session with that saved state:

```json
{ "browser": "chromium", "storage_state_name": "github-login", "url": "https://github.com" }
```

Tool: `browser_session_start`

This reuses the saved Playwright `storageState` JSON from `.pi/state/browser-playwright/github-login.json`.

## Notes for agents

- start with `browser_session_start`
- reuse the same `session_id` for a multi-step browsing task
- keep `page_id` from previous results when a task depends on a specific tab
- use `browser_snapshot` before interacting when you need a quick page map
- use `browser_extract` for selector-specific text/attribute reads
- close sessions you no longer need with `browser_close`
