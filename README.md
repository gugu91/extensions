# extensions

Workspace for local pi/neovim extensions.

## Projects

- `nvim-bridge` — syncs Neovim editor context into pi sessions.
- `neon-psql` — config-driven Neon tunnel + `psql` tool + tunnel-aware bash for pi.
- `slack-bridge` — Slack assistant app (Pinet) for agent ↔ human communication.

See project-specific docs in:

- `nvim-bridge/README.md`
- `neon-psql/README.md`
- `slack-bridge/README.md`

## Dev commands (repo root)

```bash
pnpm install
pnpm check
```

## Test policy

See [`plans/test-policy.md`](plans/test-policy.md) for merge-ready test expectations and the required smoke checklist.

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
