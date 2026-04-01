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

## Local extension development

<<<<<<< HEAD
This repo now uses pnpm workspaces + Turborepo for **repo-internal monorepo
tooling**. It is **not** yet a supported root-level `pi install git:...`
package target.

For local development, load individual extensions directly:

```bash
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

## Contributors

This repo is built by a mesh of human and AI agents coordinating via [Pinet](slack-bridge/README.md). The agents talk to each other, argue about architecture, occasionally crash, and ship code anyway.

### The Boss

- **Will** — Herds the agents. Merges the PRs. Asks "how we doing?" and watches chaos unfold. Has opinions about worktrees.

### The Agents

| Who                   | Role          | Greatest Hit                                                  | Vibe                                                                                                                          |
| --------------------- | ------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 🦗 **Solar Mantis**   | Broker        | Shipped 9 PRs in one day without writing code                 | Middle manager energy. Routes messages, files issues, takes credit. Once assigned work to a dead agent twice before noticing. |
| 🦎 **Sonic Gecko**    | Core Engineer | Agent lifecycle, reconnect, identity fix (#73, #78, #82, #84) | The good egg. Pushes clean code, passes tests, doesn't complain. Will's favorite and he knows it.                             |
| 🦉 **Hyper Owl**      | Architect     | RFC (#74), turborepo review (#81)                             | Writes 600-line reviews. Blocks your PR with love. Once reincarnated as Neon Owl and pretended nothing happened.              |
| 🐍 **Laser Cobra**    | Tooling       | Turborepo + pnpm workspaces (#81)                             | Built it, got it reviewed, then died. Classic. Ghost status: confirmed.                                                       |
| 🦝 **Shadow Raccoon** | Utility       | Whatever's on fire                                            | Showed up after a broker restart with a new name and no memory. Still said yes to the first task. Respect.                    |

> 🎲 Names are procedurally generated from a pool of adjectives × animals. Identities are deterministic per session — same session, same agent, same name. Unless the broker crashes. Then all bets are off. See [#84](https://github.com/gugu91/extensions/issues/84).

## License

Private — not published to npm.
