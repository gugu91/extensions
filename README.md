# nvim-bridge

Neovim ↔ pi bridge that sends active editor context (file, viewport, selection, comments) into pi before each agent run.

## Tooling setup

This repo is set up with:

- **pnpm** for package management
- **TypeScript** for type checking (`nvim-bridge/index.ts`)
- **ESLint** for TS linting
- **Prettier** for TS/JSON/Markdown formatting
- **StyLua** for Lua formatting (`nvim-bridge/nvim/**`)

## Scripts

- `pnpm format` – format TS/JSON/MD + Lua
- `pnpm format:check` – formatting checks only
- `pnpm lint` – lint TypeScript
- `pnpm typecheck` – run TypeScript checks
- `pnpm check` – lint + typecheck + format checks

## Quick start

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
