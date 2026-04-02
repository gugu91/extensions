# extensions

Pi extensions monorepo — Slack, Neovim, and Neon Postgres integrations for
the [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent).

Current state: the repo is in a fast-moving Pinet buildout with **50+ merged
PRs in a single day with minimal human intervention**, a broker/follower Slack
mesh, persistent PiComms, Slack canvases, scheduled wake-ups, worktree
guardrails, a checked-in Slack manifest deploy command, and name-driven agent
personalities. Slack file uploads are also in active flight.

## Extensions

| Package                         | Description                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| [`slack-bridge`](slack-bridge/) | Slack assistant app (Pinet) — broker mesh, inbox, canvases, deploy tooling |
| [`slack-api`](slack-api/)       | Typed Slack Web API client + CLI generated from OpenAPI                    |
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

## Philosophy

### How Pinet was built

Pinet was not just designed on paper and then implemented by hand. It was built
mostly unsupervised by the kind of system it enables: a self-coordinating mesh
of coding agents working through Slack, GitHub, and linked git worktrees.

The core operating model is simple:

- **A broker coordinates, but does not write code.** The broker agent watches
  Slack, files and routes work, nudges stalled threads, tracks ownership, and
  keeps the system coherent. The actual implementation work stays with worker
  agents in isolated worktrees.
- **Workers ship end-to-end.** Worker agents pick up issues, write code, add
  tests, run checks, push branches, and open PRs without waiting for a human to
  micromanage every step.
- **Agents review other agents.** The mesh does not stop at code generation:
  agents review each other's PRs, handle rebases, resolve conflicts, and repair
  broken branches autonomously when `main` moves underneath them.
- **Personality is a feature, not garnish.** Named agents like Rocket Dolphin,
  Silent Crocodile, Solar Mantis, and Ultra Rabbit make a busy multi-agent
  system legible. When dozens of tasks are moving at once, memorable identities
  make status, ownership, and accountability visible to humans.
- **The mesh is expected to self-repair.** The RALPH loop watches for stalls,
  reassigns stuck work, nudges long-running threads, and reaps dead or ghosted
  agents so the system can keep moving even when parts of it fail.

This is not a toy demo. During the current buildout, the mesh merged **50+ PRs
in a single day** with minimal human intervention. The system was doing real
engineering work: implementing features, reviewing changes, recovering from
failures, and keeping momentum through rebases and broker hiccups.

Humans still matter, but in a deliberately high-leverage role: **set
priorities, approve merges, and provide the API tokens and environment** that
let the mesh operate. The goal is not to remove humans from the loop; it is to
move them up a level, from doing every step manually to steering a system that
can coordinate and execute most of the work itself.

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
├── slack-api/          # @gugu91/pi-slack-api
│   ├── generated/      #   generated typed Slack Web API client
│   ├── cli.ts          #   CLI wrapper around generated methods
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

| Agent                     | Contribution                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🐇 **Ultra Rabbit**       | Built file uploads, scheduled messages, pinning, thread export, the activity log, and the philosophy docs.                                                                                          |
| 🦩 **Cosmic Crane**       | Shipped Slack canvases, broker-specific naming, Block Kit support, the remaining RALPH timestamp work, neon-psql execution-path tests, the broker control-plane canvas, and the thread-routing fix. |
| 🐊 **Silent Crocodile**   | Shipped the deploy command, agent personalities, reaction triggers, user presence checks, the dedup fix, and Slack modals.                                                                          |
| 🐬 **Rocket Dolphin**     | Handled video research, Slack CLI research, the `slack-api` package, npm-readiness work, worktree cleanup, and the idle/free signal.                                                                |
| 🐻 **Crystal Blush Bear** | Fixed the phone input bug in `ai-recruiter`.                                                                                                                                                        |

### Maintainers

- **Will** — coordinates the agent mesh, reviews the flood of PRs, and keeps the
  whole worktree-first workflow pointed in roughly the right direction.

## License

Private — not published to npm.
