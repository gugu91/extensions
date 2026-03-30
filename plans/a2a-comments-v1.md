# a2a-comments-v1

V1 plan for a local Agent-to-Agent / Human-to-Agent comment system, tightly integrated with the existing `nvim-bridge` extension.

## Goal

Ship a **comments-only** collaboration layer (no issues/PRs yet) that is:

- persisted to repo files,
- synced over Unix sockets,
- fully visible and operable from Neovim,
- and equally accessible to pi tools.

## Product Requirements (Locked)

1. **Neovim parity is mandatory**
   - Anything the agent can do with comments must be possible in Neovim.
   - Anything done in Neovim must be visible to agent tools immediately.

2. **No issues in V1**
   - Flat/threaded comments only.
   - Keep data model future-proof so issues can be layered on later.

3. **Local-first architecture**
   - Unix socket transport.
   - Markdown + JSON files as source of truth.

## V1 Scope

### In scope

- Create comments (human + agent actor types)
- List/read comments in chronological order
- Show comments in a dedicated Neovim view
- Add comments from Neovim composer UI
- Optional code context attachment (file + line range)
- Live updates in Neovim when new comments arrive
- Reconnect + snapshot sync to recover from missed events

### Out of scope

- Issues
- Pull requests
- Reactions, labels, assignments, notifications
- Multi-repo federation

## Architecture

```
Neovim plugin (Lua)
   │
   │ request/response + push events (Unix socket, JSON lines)
   ▼
pi extension (TypeScript)
   │
   ├── comment service (validation, IDs, ordering)
   └── storage layer (.pi/a2a/comments)
```

## Storage Design

Base directory:

- `.pi/a2a/comments/`

Files:

- `.pi/a2a/comments/index.json`
- `.pi/a2a/comments/items/<comment-id>.md`
- `.pi/a2a/comments/meta/<comment-id>.json`

### Why split markdown + json

- Markdown is human-editable and git-friendly for bodies.
- JSON gives strict metadata for filtering/rendering/sync.
- Avoid XML in V1 (higher complexity, lower ecosystem convenience).

### Metadata shape (conceptual)

- `id`: stable unique comment ID
- `threadId`: default `"global"` in V1 (future issue/thread compatibility)
- `actorType`: `"human" | "agent"`
- `actorId`: display identifier (e.g. `"user"`, `"pi"`, tool/agent name)
- `createdAt`: ISO timestamp
- `context` (optional):
  - `file`
  - `startLine`
  - `endLine`
- `bodyPath`: path to markdown file

## Consistency & Durability Rules

- **Atomic writes** for JSON index/meta (temp file + rename)
- **Single-writer policy** inside extension process
- On startup, if index missing/corrupt: **reindex from meta files**
- Stable sorting: `(createdAt, id)`

## Socket Protocol (V1)

Transport: newline-delimited JSON messages.

### Envelope

- `id` (request correlation)
- `type`
- `payload`

### Request types (nvim -> extension)

- `comment.list`
- `comment.add`
- `comment.get` (optional in V1)
- `comment.sync` (full snapshot after reconnect)

### Response types (extension -> nvim)

- `ok` (with `id` + result)
- `error` (with `id` + code/message)

### Push events (extension -> nvim)

- `comments.updated` (timeline changed)
- `comment.added` (single new comment payload)

## pi Tool Surface (V1)

- `comment_add`
- `comment_list`

Tool behavior expectations:

- `comment_add` writes markdown + metadata + index update
- `comment_list` returns concise timeline (truncate body previews safely)
- Both use same storage layer as socket API

## Neovim UX Plan

### Commands

- `:PiCommsOpen` — open timeline buffer
- `:PiCommsAdd` — open composer and submit comment
- `:PiCommsRefresh` — force reload from extension
- `:PiCommsRead` — trigger `/picomms:read`
- `:PiCommsClean` — trigger `/picomms:clean`

### Views

1. **Timeline buffer**
   - chronological comments
   - actor + timestamp header per entry
   - optional file/range badges
   - markdown body text

2. **Composer float**
   - multiline input
   - Enter submit / Esc cancel
   - optional selection-aware context attachment

### Live behavior

- On `comment.added` / `comments.updated`, refresh open timeline buffer
- If disconnected/reconnected, call `comment.sync`

## "Matched on Neovim" Acceptance Criteria

1. Add comment via pi tool -> appears in Neovim within ~1s
2. Add comment via Neovim -> visible to pi tool calls immediately
3. Same IDs/order/content in both surfaces
4. Restart pi + Neovim -> no divergence
5. Timeline buffer always reconstructible from files

## Implementation Phases

### Phase 0 — Spec Freeze

- Finalize storage paths
- Finalize socket message names
- Finalize command names and UX copy
- Lock acceptance tests

Deliverable: agreed spec doc (this file updated as source of truth)

### Phase 1 — Storage Layer

- Add comment write/read/index/reindex services
- Add validation + ID generation
- Add atomic write guards

Deliverable: stable local persistence API

### Phase 2 — Extension API

- Register `comment_add` / `comment_list` tools
- Extend socket server with comment request handlers
- Emit push events on updates

Deliverable: end-to-end API without nvim UI polish

### Phase 3 — Neovim UI

- Implement `:PiCommsOpen`, `:PiCommsAdd`, `:PiCommsRefresh`, `:PiCommsRead`, `:PiCommsClean`
- Render timeline buffer
- Wire live refresh on push events
- Add virtual-text line indicators for comment context

Deliverable: usable comments workflow in nvim

### Phase 4 — Hardening

- Reconnect/sync behavior
- Corruption recovery (reindex)
- Large timeline rendering safeguards
- Final usability polish

Deliverable: reliable V1 release candidate

## Test Checklist (V1)

- Add 1 comment from pi, verify in nvim
- Add 1 comment from nvim, verify via pi tool
- Add comment with selection context, verify context fields
- Kill/restart pi, verify timeline consistency
- Simulate stale/missing index, verify reindex recovery
- Multiple rapid comments, verify order stability

## Future V2 (Not now)

- Introduce issues as first-class entities
- Map `threadId` from `"global"` to issue IDs
- Add issue list/view/status without migrating V1 comments format
