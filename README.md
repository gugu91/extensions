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
