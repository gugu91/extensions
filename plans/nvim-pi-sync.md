# nvim-pi-sync

Neovim plugin + pi extension that keeps pi aware of what you're looking at in nvim.

## Architecture

```
Neovim (Lua) ──Unix socket──> Pi Extension (node:net server)
                                      │
                                      ▼
                               Injects editor context
                               into LLM via before_agent_start
```

## Socket Discovery

Path: `/tmp/pi-nvim/<sha256(repoRoot + ":" + branch)>.sock`

Both sides compute it from `git rev-parse --show-toplevel` + `git branch --show-current`.
Same repo + same branch = same socket. Different branches are isolated.

## Protocol

Newline-delimited JSON over Unix socket. Nvim -> pi only.

```json
{"type":"buffer_focus","file":"src/foo.ts","line":42}
{"type":"visible_range","file":"src/foo.ts","start":30,"end":80}
{"type":"selection","file":"src/foo.ts","start":55,"end":60}
```

File paths are relative to repo root.

## Pi Extension

Location: `/Users/guglielmoporcellini/src/gugu910/extensions/nvim-bridge/index.ts`

Symlinked into `~/.pi/agent/extensions/nvim-bridge` or registered in `settings.json`.

### Behavior

- `session_start`: Compute socket path from cwd, create Unix socket server via `node:net`, unlink stale socket if exists.
- On connection data: Parse newline-delimited JSON, update `editorState` object, set `dirty = true`.
- `before_agent_start`: If `dirty`, inject a message with current editor context (file + line numbers), set `dirty = false`.
- `session_shutdown`: Close server, unlink socket file.

### State

```ts
interface EditorState {
  file: string | null; // relative to repo root
  line: number | null; // cursor line from buffer_focus
  visibleStart: number | null;
  visibleEnd: number | null;
  selectionStart: number | null;
  selectionEnd: number | null;
}
```

### Injected Message

Only when `dirty`. Example:

```
User is viewing src/foo.ts, lines 30-80 (cursor at line 42), selection on lines 55-60.
```

Uses `before_agent_start` return `{ message: { customType: "nvim-context", content: "...", display: true } }`.

## Neovim Plugin

Location: `/Users/guglielmoporcellini/src/gugu910/extensions/nvim-bridge/nvim/`

Symlinked or added to nvim runtimepath.

### Files

```
nvim/
├── plugin/
│   └── pi-nvim.lua     # Autocommand setup, plugin entry
└── lua/
    └── pi-nvim/
        ├── init.lua     # Public API (setup, enable/disable)
        ├── socket.lua   # Connection management, reconnect
        └── events.lua   # Event formatting, debounce
```

### Autocommands

| Autocommand                 | Event           | Debounce |
| --------------------------- | --------------- | -------- |
| `BufEnter`                  | `buffer_focus`  | No       |
| `WinScrolled`               | `visible_range` | 150ms    |
| `CursorMoved` (visual mode) | `selection`     | 150ms    |

### Socket Connection

- `vim.loop.new_pipe()` to connect.
- Reconnect on disconnect with backoff (1s, 2s, 4s, max 10s).
- Compute socket path by shelling out to git (cached, invalidated on `DirChanged` / `FocusGained`).

### Debounce

`vim.defer_fn` based. Each event type has its own timer. New events cancel the pending timer.

## File Tree

```
/Users/guglielmoporcellini/src/gugu910/extensions/
└── nvim-bridge/
    ├── index.ts                  # Pi extension
    └── nvim/
        ├── plugin/
        │   └── pi-nvim.lua       # Autocommand setup
        └── lua/
            └── pi-nvim/
                ├── init.lua      # Public API
                ├── socket.lua    # Unix socket client
                └── events.lua    # Event formatting, debounce
```

## Setup

1. Symlink pi extension:

   ```bash
   ln -s /Users/guglielmoporcellini/src/gugu910/extensions/nvim-bridge ~/.pi/agent/extensions/nvim-bridge
   ```

2. Add nvim plugin to runtimepath (e.g. in `init.lua`):

   ```lua
   vim.opt.rtp:prepend("/Users/guglielmoporcellini/src/gugu910/extensions/nvim-bridge/nvim")
   require("pi-nvim").setup()
   ```

3. Both pi and nvim must be in the same git repo on the same branch.

## Issue #714 implemented slice: Pinet contextual threads

The active replacement is intentionally small and Pinet-native:

- Anchored Neovim comments are ordinary Pinet transport threads with `source: "nvim"`.
- Durable state lives only in BrokerDB `threads.metadata` and `messages.metadata`/`messages.body`.
- Metadata is versioned as `pinetKind: "contextual_thread"`, `schemaVersion: 1`, with `codeAnchor` and `state.resolved` fields. Anchors carry canonical `repository`, `worktree`, `path`, `baseOid`, `headOid`, `blobOid`, old/new `side`, and the line range.
- The active broker owns `/tmp/pi-nvim/<sha256(canonicalWorktree + ":" + branch)>.sock`; Neovim is a UI adapter, not an agent. The Pi extension uses the same socket as a client for viewport hydration and `open_in_editor`.
- New threads require an explicit target agent and are pre-created with explicit owner binding before the inbound message routes through existing Pinet inbox machinery.
- Relevant unresolved threads are revision-filtered and injected into later agent runs with bounded message history; resolved threads remain durable but are omitted.
- Agents reply with the generic Pinet dispatcher `reply` action against an existing thread id; no review-specific tool or table exists.
- v1 supports one current Fugitive/native diff file. GitHub sync, multi-file review UI, and anchor relocation remain deferred; changed revisions are omitted rather than guessed.

## Issue #1022: normal documents, ownership, and subscriptions

The contextual-thread adapter also supports ordinary tracked buffers through a shared broker document domain:

- `documents` stores one durable owner and transport-neutral metadata.
- `document_aliases` binds native identities such as a canonical Git worktree file or Slack thread to that document.
- `document_subscriptions` stores additional agent recipients. Subscriptions grant delivery, not ownership or reply authority.
- Neovim Git-file document identity hashes canonical `repository`, `worktree`, and repo-relative `path`; Slack thread identity hashes its scope, channel, and thread timestamp.
- Both runtime paths resolve existing aliases before minting a document id. `:PinetBindSlack <thread_id>` provides the explicit cross-adapter rebind when a Slack conversation corresponds to a tracked file; subsequent Slack ingress reuses that canonical Git document.
- Contextual threads retain their existing `threads`/`messages` lifecycle and reference the shared `documentId`. The router fans document events out once to the unique owner/subscriber set.
- Agent replies continue through the generic transport send path; document subscribers receive those persisted replies without changing the thread owner.
- Diff anchors remain schema v1. Normal-buffer anchors use schema v2 with `anchorKind: "normal"`, current `headOid`, optional committed `headBlobOid`, current in-memory `blobOid`, and `dirty`. They never claim an old/new diff side.
- Normal-buffer restoration remains exact: a changed or unsaved buffer blob does not inherit signs from a different content identity.
