# extensions

Pi extensions monorepo — Slack, Neovim, and Neon Postgres integrations for
the [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent).

Current state: the repo is in a fast-moving Pinet buildout with **44+ merged
PRs on 2026-04-02 alone**, a broker/follower Slack mesh, persistent PiComms,
Slack canvases, scheduled wake-ups, worktree guardrails, a checked-in Slack
manifest deploy command, and name-driven agent personalities. Slack file
uploads are also in active flight.

## Extensions

| Package                         | Description                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| [`slack-bridge`](slack-bridge/) | Slack assistant app (Pinet) — broker mesh, inbox, canvases, deploy tooling |
| [`nvim-bridge`](nvim-bridge/)   | Neovim editor context sync + PiComms persistent comments                   |
| [`neon-psql`](neon-psql/)       | Config-driven Neon tunnel + `psql` tool                                    |
| [`types`](types/)               | Shared ambient type declarations                                           |

## Current state snapshot

- **Broker mesh** — Slack-bridge now runs a broker/follower Pinet workflow with
  routing, inbox sync, broadcast channels, reload/unfollow controls, and
  scheduled wake-ups.
- **Slack tooling** — the Slack extension now includes canvases and a root
  `pnpm deploy:slack` command for pushing `slack-bridge/manifest.yaml` via the
  Slack App Manifest API.
- **Communication polish** — agents keep stable identities, now speak with
  lightweight name-matched personalities, and report worker assignment status
  back through the RALPH loop.
- **Active work** — Slack file uploads are currently in flight in
  [PR #201](https://github.com/gugu91/extensions/pull/201).

## Quick start

```bash
# Install dependencies
pnpm install

# Run all checks
pnpm lint && pnpm typecheck && pnpm test
```

## Local extension development

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

| Command             | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `pnpm lint`         | ESLint across all extensions (turbo-cached)                     |
| `pnpm typecheck`    | TypeScript strict check (turbo-cached)                          |
| `pnpm test`         | Vitest — all tests (turbo-cached)                               |
| `pnpm deploy:slack` | Validate and push `slack-bridge/manifest.yaml` to the Slack app |
| `pnpm prepush`      | lint + typecheck + test (runs on git push)                      |
| `pnpm format`       | Prettier + Stylua                                               |
| `pnpm check`        | lint + typecheck + format check                                 |

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

This repo is built by a mesh of human and AI agents coordinating via
[Pinet](slack-bridge/README.md). Names are procedural and can rotate across
sessions, so this section is a snapshot of the agents visible in today's work.

### Today's agents (2026-04-02)

| Agent                   | Contribution                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🐊 **Silent Crocodile** | Shipped the Slack manifest deploy command, wired name-based personalities into agent prompts, verified the initial RALPH assignment report behavior already on `main`, and refreshed the repo README to match the current state. |
| 🐬 **Rocket Dolphin**   | Helped validate the Slack deploy workflow by confirming the Slack CLI does not provide a `slack manifest update` command, which unblocked the direct Web API deploy design.                                                      |

### Maintainers

- **Will** — coordinates the agent mesh, reviews the flood of PRs, and keeps the
  whole worktree-first workflow pointed in roughly the right direction.

## License

Private — not published to npm.
