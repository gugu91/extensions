# nvim-bridge

Neovim ↔ pi bridge that sends active editor context (file, viewport, selection, one-shot comments) into pi before each agent run, and now also supports persistent local A2A comments.

## How it works

- A pi extension (`index.ts`) starts a Unix socket server.
- A Neovim plugin (`nvim/**`) sends events to that socket.
- Before each agent run, pi injects context like:
  - current file
  - visible line range
  - cursor line
  - selection
  - optional one-shot comment

> Important: Neovim and pi must be in the **same git repo and same branch**.

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
    require("pi-nvim").setup({
      comment_keymap = "<leader>pc", -- one-shot context comment
      a2a_comment_keymap = "<leader>pa", -- persistent A2A comment
      a2a_open_keymap = "<leader>pl", -- open timeline
    })
  end,
}
```

If this repo is elsewhere, change the `dir` path.

### 3) Restart pi + Neovim

After linking/configuring, restart both so socket + autocommands are initialized.

## Usage

Core bridge commands:

- `:PiNvimEnable`
- `:PiNvimDisable`
- `:PiNvimStatus`

One-shot context comment (injected into next agent run):

- `:'<,'>PiNvimComment`

Persistent A2A comments (stored under `.pi/a2a/comments`):

- `:PiCommentsOpen [thread]` — open comments timeline in a floating side panel
- `:PiCommentsRefresh [thread]` — refresh timeline from pi
- `:PiCommentAdd [thread]` — add a persistent comment

Default keymaps (if enabled in setup):

- One-shot context comment: `<leader>pc`
- Add persistent A2A comment: `<leader>pa`
- Open A2A timeline: `<leader>pl`

Composer controls:

- `Enter` → submit comment
- `Shift-Enter` / `Ctrl-j` → newline
- `Esc` → cancel

Timeline panel controls:

- `a` → add comment
- `r` → refresh
- `q` → close panel

Global wipe (all threads) is available via skill:

- `/skill:wipe-a2a-comments`

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
