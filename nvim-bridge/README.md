# nvim-bridge

Neovim ↔ pi bridge that sends active editor context (file, viewport, selection) into pi before each agent run, and provides a thin Neovim-to-Pinet request adapter.

PiComms has been removed from this environment. Durable coordination should use Pinet (`pinet action=read/send/lanes/...`) instead of a separate local comment store.

## How it works

- A pi extension (`index.ts`) starts a same-host Unix socket server.
- A Neovim plugin (`nvim/**`) sends editor events to that socket.
- Before each agent run, pi injects context like:
  - current file
  - visible line range
  - cursor line
  - selection
- `:PinetAsk` and `:PinetRead` send lightweight follow-up prompts to the active pi session; the agent can then use Pinet tools for coordination.

> Important: Neovim and pi must be in the **same git repo and same branch**.

## Trust boundary notes

`nvim-bridge` is a **same-host local-power surface**.

- The Unix socket under `/tmp/pi-nvim/<hash>.sock` assumes local trust between Neovim and the pi process on the same machine.
- There is **no peer authentication handshake** on that socket today; the main boundary is host-local access plus the repo/branch-derived socket name.
- The bridge tightens the socket directory/socket permissions on a best-effort basis, but that is intentionally narrow hardening rather than a transport redesign.

Treat the socket as local editor-control access for the current host, not as a remote-safe transport.

## Install / configure

### 1) Link this as a pi extension

From your repo root:

```bash
ln -s "$(pwd)/nvim-bridge" ~/.pi/agent/extensions/nvim-bridge
```

If you already have a link:

```bash
rm -f ~/.pi/agent/extensions/nvim-bridge
ln -s "$(pwd)/nvim-bridge" ~/.pi/agent/extensions/nvim-bridge
```

### 2) Add Neovim plugin with lazy.nvim

Because the Neovim plugin lives in `nvim-bridge/nvim`, point lazy to that directory:

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

If this repo is elsewhere, change the `dir` path.

### 3) Restart pi + Neovim

After linking/configuring, restart both so socket + autocommands are initialized.

### Keymaps

This plugin does **not** define global keymaps by default. Define mappings in your Neovim config (e.g. lazy `keys` field).

## Usage

Core bridge commands:

- `:PiNvimEnable`
- `:PiNvimDisable`
- `:PiNvimStatus`

Pinet adapter commands:

- `:PinetAsk [message]` — send the current buffer/cursor/range plus message to the active pi session as a Pinet-oriented request.
- `:PinetRead` — ask the active pi session to check pending Pinet follow-ups for this repository/context.

Examples:

```vim
:PinetAsk please review this function with another agent
:'<,'>PinetAsk coordinate this selected block via Pinet
:PinetRead
```

The adapter intentionally does not store comments, draw comment indicators, or maintain a local timeline. It packages Neovim context and asks the active pi session to use Pinet for durable lanes, delegation, and follow-up tracking.

Removed PiComms surface:

- no `.pi/a2a/comments` store is initialized by `nvim-bridge`
- no `comment_add`, `comment_list`, or `comment_wipe_all` tools are registered
- no `/picomms:*` commands are registered
- no `:PiComms*` Neovim commands or line indicators are registered

## Development tooling

- **pnpm** for package management
- **TypeScript** for type checking (`index.ts`)
- **ESLint** for TS linting
- **Prettier** for TS/JSON/Markdown formatting
- **StyLua** for Lua formatting (`nvim/**`)

### Scripts (from repo root)

- `pnpm format` – format TS/JSON/MD + Lua
- `pnpm format:check` – formatting checks only
- `pnpm lint` – lint TypeScript
- `pnpm typecheck` – run TypeScript checks
- `pnpm check` – lint + typecheck + format checks

### Quick start

```bash
# macOS
brew install stylua

pnpm install
pnpm check
```

## Git hooks (Husky)

- **pre-commit**: runs `lint-staged` to auto-format staged files
  - Prettier: `*.{ts,tsx,js,mjs,cjs,json,md,yml,yaml}`
  - StyLua: `nvim-bridge/nvim/**/*.lua`
- **pre-push**: runs `pnpm lint && pnpm typecheck`

## Notes

- Lua files are intentionally ignored by Prettier and formatted with StyLua.
- A local ambient type declaration is provided in `types/pi-coding-agent.d.ts` so `tsc` can run without requiring external SDK types.
- If `/tmp` or your local machine account is shared more broadly than usual, remember that `nvim-bridge` still relies on same-host trust rather than explicit socket peer auth.

## License

MIT. See [`LICENSE`](./LICENSE).
