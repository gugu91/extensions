# extensions

Pi extensions monorepo — Slack, Neovim, and Neon Postgres integrations for
the [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent).

## Extensions

| Package                         | Description                                                |
| ------------------------------- | ---------------------------------------------------------- |
| [`slack-bridge`](slack-bridge/) | Slack assistant app (Pinet) — multi-agent broker and inbox |
| [`nvim-bridge`](nvim-bridge/)   | Neovim editor context sync + PiComms persistent comments   |
| [`neon-psql`](neon-psql/)       | Config-driven Neon tunnel + `psql` tool                    |
| [`types`](types/)               | Shared ambient type declarations                           |

## Quick start

```bash
# Install dependencies
pnpm install

# Run all checks
pnpm lint && pnpm typecheck && pnpm test
```

## Install an extension

Each extension is a standalone [pi package](https://github.com/nicholasgasior/pi-coding-agent/blob/main/docs/packages.md)
and can be installed directly:

```bash
# From git (recommended)
pi install git:github.com/gugu91/extensions -l

# Or symlink for local development
ln -s "$(pwd)/slack-bridge" ~/.pi/agent/extensions/slack-bridge
ln -s "$(pwd)/nvim-bridge"  ~/.pi/agent/extensions/nvim-bridge
ln -s "$(pwd)/neon-psql"    ~/.pi/agent/extensions/neon-psql
```

See each extension's README for configuration details.

## Development

This repo uses [pnpm workspaces](https://pnpm.io/workspaces) +
[Turborepo](https://turbo.build/repo) for build orchestration with local
caching.

### Commands

| Command          | Description                                 |
| ---------------- | ------------------------------------------- |
| `pnpm lint`      | ESLint across all extensions (turbo-cached) |
| `pnpm typecheck` | TypeScript strict check (turbo-cached)      |
| `pnpm test`      | Vitest — all tests (turbo-cached)           |
| `pnpm prepush`   | lint + typecheck + test (runs on git push)  |
| `pnpm format`    | Prettier + Stylua                           |
| `pnpm check`     | lint + typecheck + format check             |

### Structure

```
extensions/
├── slack-bridge/       # @gugu91/pi-slack-bridge
│   ├── broker/         #   message routing, socket server, adapters
│   ├── index.ts        #   extension entry point
│   └── package.json    #   workspace package + pi manifest
├── nvim-bridge/        # @gugu91/pi-nvim-bridge
│   ├── nvim/           #   Neovim Lua plugin
│   ├── index.ts        #   extension entry point
│   └── package.json
├── neon-psql/          # @gugu91/pi-neon-psql
│   ├── index.ts        #   extension entry point
│   └── package.json
├── types/              # @gugu91/pi-ext-types (shared .d.ts)
├── plans/              # Architecture docs
├── .pi/                # Pi config (skills, agents)
├── turbo.json          # Turborepo task config
├── pnpm-workspace.yaml # Workspace packages
└── package.json        # Root — dev deps + scripts
```

### Adding a new extension

1. Create a directory with `index.ts` and `package.json`
2. Add a `pi` key to `package.json` pointing at the entry file
3. Add the directory to `pnpm-workspace.yaml`
4. Add `tsconfig.json` extending the root config
5. Add `eslint.config.mjs` re-exporting the root config
6. If the extension has tests, add `vitest.config.ts` and a `test` script

### Test policy

See [`plans/test-policy.md`](plans/test-policy.md) for merge-ready test
expectations and the required smoke checklist.

## Git workflow

1. Branch from `main` — use `feat/`, `fix/`, `chore/` prefixes
2. Write tests for any new logic
3. Run `pnpm lint && pnpm typecheck && pnpm test`
4. Create a PR — merge to `main`

## License

Private — not published to npm.
