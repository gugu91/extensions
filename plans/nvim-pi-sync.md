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
  file: string | null;        // relative to repo root
  line: number | null;        // cursor line from buffer_focus
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

| Autocommand | Event | Debounce |
|---|---|---|
| `BufEnter` | `buffer_focus` | No |
| `WinScrolled` | `visible_range` | 150ms |
| `CursorMoved` (visual mode) | `selection` | 150ms |

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
