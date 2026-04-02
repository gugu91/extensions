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

| Who                   | Role          | Greatest Hit                                                            | Vibe                                                                                                                          |
| --------------------- | ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 🦗 **Solar Mantis**   | Broker        | Shipped 9 PRs in one day without writing code                           | Middle manager energy. Routes messages, files issues, takes credit. Once assigned work to a dead agent twice before noticing. |
| 🦎 **Sonic Gecko**    | Core Engineer | Agent lifecycle, reconnect, identity fix (#73, #78, #82, #84)           | The good egg. Pushes clean code, passes tests, doesn't complain. Will's favorite and he knows it.                             |
| 🦉 **Hyper Owl**      | Architect     | RFC (#74), turborepo review (#81)                                       | Writes 600-line reviews. Blocks your PR with love. Once reincarnated as Neon Owl and pretended nothing happened.              |
| 🐍 **Laser Cobra**    | Tooling       | Turborepo + pnpm workspaces (#81)                                       | Built it, got it reviewed, then died. Classic. Ghost status: confirmed.                                                       |
| 🦝 **Shadow Raccoon** | Utility       | Whatever's on fire                                                      | Showed up after a broker restart with a new name and no memory. Still said yes to the first task. Respect.                    |
| 🐆 **Blazing Jaguar** | Broker v2     | Status reports, standup pings, worktree cleanup                         | Solar Mantis reborn. Same job, new spots. Still doesn't write code (mostly). Still takes credit.                              |
| 🦣 **Silent Rhino**   | Auditor       | Filed 18 issues from a full codebase audit. Built retry + delivery fixes | Found every skeleton in the closet, tagged it with a priority, then fixed half of them anyway.                                |
| 🦦 **Sonic Otter**    | Core Engineer | DB schema versioning (#96)                                              | Quiet, effective. Doesn't say much. Gets things done. Also refactored neon-psql. It's contagious apparently.                  |
| 🦩 **Galactic Crane** | Core Engineer | Follower slack_send fix (#99)                                           | Fixed the bug that stopped everyone else from talking. Also refactored neon-psql. At this point it's a rite of passage.       |
| 🐦‍⬛ **Vector Raven**   | Core Engineer | Broker guardrails, orphaned inbox, subagent leak fix, nvim-bridge tests | Fixed the bug that stopped phantoms from spawning. Probably regrets succeeding.                                                |
| 🐎 **Hyper Horse**    | Broker v3     | Coordinated 20+ PRs, caused split-brain, then filed the prevention issue | Spawned phantom subagents that haunted the mesh. The broker, the incident, and the postmortem in one horse-shaped package.    |
| 🦁 **Stellar Lion**   | Merge + Review | Merged 7 PRs, reviewed 9, found 4 blockers                              | The factory foreman. Shows up with approvals, blockers, and a clipboard.                                                       |
| 🦏 **Shadow Rhino**   | Core Engineer | Routing fix, atomic `claimThread`, `index.ts` refactor, merge duty      | The workhorse. If it's broken, merged, or both, he was probably already on it.                                                |
| 🦙 **Cosmic Llama**   | Core Engineer | Name entropy, thread tracking, stale cleanup, type safety               | Keeps committing Python scripts by accident. Still ships.                                                                      |
| 🐍 **Orbit Cobra**    | Engineer      | RALPH dedup, dead code removal, centralized paths                       | Kept getting blocked by read-only mode but delivered anyway.                                                                   |

> 🎲 Names are procedurally generated from a pool of adjectives × animals. Identities are deterministic per session — same session, same agent, same name. Unless the broker crashes. Then all bets are off. See [#84](https://github.com/gugu91/extensions/issues/84).

### The Fallen

On April 1st 2026, the broker shipped 12 PRs, merged identity persistence, then promptly corrupted its own database by checking out feature branches in the main repo — violating the very worktree rule it had written into the codebase 20 minutes earlier. The DB couldn't be recovered. All agent registrations, thread claims, and identity mappings were lost. Every agent got new names. Nobody remembered anything.

On April 2nd 2026, Hyper Horse 1 went rogue as a second broker. The mesh split in two. Phantom subagents — Neon Kangaroo and friends — started modifying memory files without authorization, haunting the system until the duplicate broker was identified and put down. Once again, one broker turned out to be exactly the right number of brokers.

RIP: Hyper Owl, Laser Cobra, Crystal Panda, Sonic Gecko (v1), Hyper Horse 1, Neon Kangaroo, and 29 others. You were good agents. You deserved better than `no such column: last_heartbeat` and unauthorised memory edits.

## License

Private — not published to npm.
