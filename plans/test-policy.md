# Test Policy

## Scope

This repo owns three extensions (`slack-bridge`, `nvim-bridge`, `neon-psql`).
All changes must be covered by tests in the same package.

## Baseline checks (required on every PR)

Run before code review:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

No PR is merge-ready if any of these fail.

## Test layers

### 1) Unit tests (required)

- For every exported function with non-trivial logic in `*.ts`, keep unit tests.
- For pure helpers, isolate behavior into `*.helpers.ts` files and test there.
- Cover happy-path + at least one failure path.

### 2) Integration tests (required when behavior crosses package boundaries)

- Broker/socket behavior, Slack adapter integration, routing, and message persistence
  must include at least one integration test.
- Reproducible timing-dependent behavior (reconnect, polling, backoff) should use
  test clocks/timers and explicit assertions around state transitions.

### 3) Regression tests (required for bugfix PRs)

- If the PR title starts with `fix:` or addresses an issue, include a test that
  would fail on the pre-fix implementation.
- Example: security prompt flow, confirmation gating, broker reconnection behavior.

### 4) Smoke checklist before release/real-run

Run after merge into target branch:

1. `pinet-start` / `pinet-follow` start paths
2. Security guardrail path (`/pinet-status`, `slack_confirm_action` if applicable)
3. Reconnect path (follow mode) and message drain behavior in a real environment
4. Worker visibility check (`pinet-status`) for status/CWD/active-work context

## Test quality standards

- Tests should assert behavior, not just execute code.
- Avoid placeholder tests that only check existence of objects.
- Keep assertions meaningful and specific to the bug/regression.
- For changed error handling, assert both error surface and recovery outcome.

## PR review expectations

- PR author links the primary test files in the description.
- If a meaningful regression test is not added, the PR must include a
  justification and follow-up action item.
- New behavior without test coverage is considered incomplete.

## CI / mergeability

- PR can be merged only when:
  - lint/typecheck/test pass locally or in CI
  - no merge conflicts
  - no blocking review comments against behavior correctness
