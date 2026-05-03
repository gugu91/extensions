# nvim-bridge

Neovim ↔ pi bridge that sends active editor context (file, viewport, selection) into pi before each agent run.

PiComms is disabled in this environment while the replacement Pinet-native Neovim adapter is tracked separately in issue #714.

## How it works

- A pi extension (`index.ts`) starts a same-host Unix socket server.
- A Neovim plugin (`nvim/**`) sends editor events to that socket.
- Before each agent run, pi injects context like:
  - current file
  - visible line range
  - cursor line
  - selection

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

Disabled PiComms surface:

- no `.pi/a2a/comments` store is initialized by `nvim-bridge`
- no `comment_add`, `comment_list`, or `comment_wipe_all` tools are registered
- no `/picomms:*` commands are registered
- no `:PiComms*` Neovim commands are registered
- no PiComms panel or line indicators are initialized on startup

Use Pinet directly for durable coordination while the replacement Neovim adapter is designed.

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
