## Issue / problem solved

- Closes/Fixes/Refs: #
- Why this is prioritized:

## Troubleshooting / diagnosis

- How the problem was reproduced or investigated:
- Evidence for the root cause (logs, traces, failing tests, screenshots, etc.):
- Relevant constraints or edge cases:

## Design philosophy

- Guiding principle for this change:
- Simplicity review:
  - [ ] Comments explain non-obvious reasons or invariants; clearer code replaces narration.
  - [ ] Tests exercise states reachable through production boundaries rather than bypassing them.
  - [ ] One-use helpers are inlined unless they form a documented semantic seam.
- If this touches Pinet / `slack-bridge`: how does it preserve token-efficient progressive discovery?
  - Hot-path schemas/prompts stay compact:
  - Cold paths remain discoverable through dispatcher `help` / per-action schemas or docs/skills:
  - Templates/examples/large usage guidance stay out of always-loaded prompts/tool schemas:

## Repo design fit

- Existing architecture/conventions this follows:
- Extension/package boundaries preserved:
- Guardrail, security, auth, or local-power implications:

## Alternatives considered

- Alternative(s) considered:
- Why they were not chosen:

## Testing / validation

- Tests added or updated:
- Commands run:
  - [ ] `pnpm lint`
  - [ ] `pnpm typecheck`
  - [ ] `pnpm test`
  - [ ] Other:
- Manual validation:

## Review notes / follow-ups

- Known limitations or non-blocking concerns:
- Follow-up issues/PRs:
- Reviewer focus areas:
