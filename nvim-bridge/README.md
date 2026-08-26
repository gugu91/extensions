# nvim-bridge

Neovim UI/runtime files for the Pinet-native editor bridge.

The durable integration is hosted by the active Pinet broker as a `MessageAdapter` with source `nvim`. Neovim connects to the broker-owned local Unix socket and sends versioned thread RPCs. Anchored comments are ordinary Pinet threads/messages with optional code-anchor metadata in BrokerDB; there is no PiComms store, review table, GitHub sync, or separate review service.

## Scope

Implemented v1 scope for issue #714:

- Existing Fugitive/native single-file diff workflow (`vim.wo.diff`).
- Create an anchored contextual thread from the current line/visual range.
- Require an explicit target Pinet agent for new threads.
- List/open/reply/resolve/reopen threads for the current file.
- Persist thread state and anchors in Pinet `threads.metadata` and messages in Pinet `messages`.
- Restore signs by querying the broker when Neovim reconnects, enters a diff buffer, or `:PinetThreads` runs.
- Match restoration to `repository`, `worktree`, `path`, `baseOid`, `headOid`, `blobOid`, and old/new diff side. Changed revisions are intentionally omitted rather than relocated.
- Hydrate a bounded summary of relevant unresolved threads before later agent runs.
- Agent replies use generic `pinet action=reply`, which sends through the stored transport source/channel and updates Neovim.
- Preserve editor viewport context and `open_in_editor` through the broker-hosted socket.

Out of scope for v1: GitHub/PR synchronization, multi-file review browser, pending-review lifecycle, smart anchor relocation, and any parallel PiComms persistence.

## Neovim commands

Core bridge commands:

- `:PiNvimEnable`
- `:PiNvimDisable`
- `:PiNvimStatus`

Contextual thread commands:

- `:PinetComment [body]` — create a thread on the current diff line/range; uses `vim.g.pinet_agent_id` or prompts for the explicit target agent id.
- `:PinetThreads` — refresh current-file threads/signs, including resolved threads.
- `:PinetThreadOpen [thread_id]` — open a small thread pane.
- `:PinetReply <thread_id> <body>` — add a user reply to an existing thread.
- `:PinetResolve [thread_id]` — mark a thread resolved.
- `:PinetReopen [thread_id]` — reopen a resolved thread.

Default navigation mappings:

- `]p` next current-file Pinet thread
- `[p` previous current-file Pinet thread

## Socket and trust boundary

The broker-hosted adapter owns `/tmp/pi-nvim/<sha256(canonicalWorktree + ":" + branch)>.sock`. Both Pi and Neovim canonicalize `git rev-parse --show-toplevel`, so starting Pi in a repository subdirectory does not change the socket identity. The standalone `nvim-bridge` pi extension is a client of this socket for editor-context hydration and `open_in_editor`; it does not start a competing server.

To avoid the target prompt for each new thread, set the Pinet agent id shown by `/pinet status`:

```lua
vim.g.pinet_agent_id = "<agent-id>"
```

This is a same-host local-power surface. Socket directory/socket permissions are tightened best-effort, but there is no remote-safe peer authentication handshake.

## Install Neovim plugin with lazy.nvim

```lua
{
  dir = vim.fn.expand("~/src/gugu910/extensions/nvim-bridge/nvim"),
  name = "pi-nvim",
  lazy = false,
  config = function()
    require("pi-nvim").setup()
  end,
}
```

Restart the Pinet broker and Neovim after updating.

## Removed PiComms surface

- no `.pi/a2a/comments` store
- no `.pi/picomms.db`
- no `comment_add`, `comment_list`, or `comment_wipe_all` tools
- no `/picomms:*` commands
- no canonical `ctx:<file>:<range>` thread ids

## Development

- `pnpm --filter @gugu910/pi-nvim-bridge lint`
- `pnpm --filter @gugu910/pi-nvim-bridge typecheck`
- `pnpm exec vitest run --config vitest.config.ts nvim-bridge`
- `pnpm format:lua`

## License

MIT. See [`LICENSE`](./LICENSE).
