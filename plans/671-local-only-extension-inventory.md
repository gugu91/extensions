# Plan: safely inventory local-only Pi extensions

- Follow-up to #671
- Status: planning only — no code or local configuration is copied in this PR
- Last updated: 2026-05-01

## Executive summary

Some Pi extensions may exist only in a local operator environment and may include
sensitive paths, workspace names, prompts, tokens, private endpoints, logs, or
user-specific configuration. The safest path is a read-only, two-tier inventory:
keep the detailed evidence local, then publish only sanitized classifications,
migration decisions, and follow-up issue slices.

This plan deliberately does **not** inspect, copy, summarize, or quote private
local extension contents. Future migration work should start from sanitized
metadata and only copy reviewed code after a security/privacy pass.

## Confidentiality rules for all follow-up work

Public GitHub artifacts must not include:

- local absolute paths or host/user/workspace names
- tokens, credentials, API keys, app IDs, team IDs, or account identifiers
- private URLs, internal service names, socket paths, or database details
- screenshots, logs, raw command output, or stack traces from local environments
- user-specific settings, prompt text, aliases, contacts, channel names, or
  private repo/package names
- unreviewed source snippets from local-only extensions

Use sanitized labels such as `local-extension-a`, `local-extension-b`, or a
high-level capability category. Keep the private mapping from sanitized label to
actual local artifact outside the public repository.

## 1. Read-only inventory approach

### Phase 0 — prepare a private evidence log

Create a local-only inventory worksheet outside the public repo. The worksheet
may contain sensitive details, but it must never be committed, pasted into a
GitHub issue, or attached to a PR. At minimum, track:

- sanitized public label
- private local identifier/path, if needed for local operators
- whether a `package.json` exists
- whether the package declares `keywords: ["pi-package"]`
- whether a `pi.extensions` entrypoint is declared
- whether the extension registers tools, commands, event handlers, skills, or
  prompt/context surfaces
- whether it reads config, environment variables, secrets, filesystem state,
  network resources, shell commands, browser state, Slack/Pinet/iMessage data, or
  database connections
- whether it has tests, lint/typecheck setup, build output, docs, and license
  headers
- initial sensitivity classification: low, medium, high, or unknown

### Phase 1 — enumerate candidates without reading contents deeply

Use local-only, read-only filesystem inspection. Prefer metadata first:

1. identify candidate package roots by `package.json`, Pi manifest fields, or
   extension entrypoint naming conventions
2. record only sanitized labels in public notes
3. avoid printing full paths in terminal output that could be copied into public
   artifacts
4. avoid running extension code, install scripts, build scripts, migrations, or
   package lifecycle hooks during discovery
5. avoid opening screenshots, logs, local databases, credential stores, browser
   storage, or generated caches

The public result of this phase should be a count and category summary, not a
raw listing of local paths or contents.

### Phase 2 — classify behavior from metadata and targeted source review

After candidate roots are known, review files locally with least exposure:

- start with manifests, README files, and test names
- inspect source only enough to classify capability and risk
- do not copy source into the public repo during planning
- do not quote sensitive strings, prompt text, settings examples, or private
  endpoint names
- mark unknowns explicitly instead of guessing

Suggested public-safe categories:

- **security/permission mediation** — controls access to local-power tools,
  commands, or confirmations
- **prompt/UI decoration** — adjusts prompts, status lines, footers, or display
  context
- **transport/integration adapter** — bridges to an external service or local app
- **operator workflow helper** — automates local-only workflow or machine setup
- **experimental/research** — not ready for shared packaging

### Phase 3 — publish a sanitized decision table

A future planning update may publish a table shaped like this:

| Sanitized label   | Public category               | Sensitivity    | Recommended disposition             | Follow-up                |
| ----------------- | ----------------------------- | -------------- | ----------------------------------- | ------------------------ |
| local-extension-a | security/permission mediation | high/unknown   | evaluate privately before migration | private review checklist |
| local-extension-b | prompt/UI decoration          | medium/unknown | document or migrate after redaction | public packaging issue   |

Do not include the private mapping, local path, raw package name, or unique local
configuration in the public table unless the maintainer explicitly approves it as
non-sensitive.

## 2. Disposition criteria

### Migrate into this repo

Choose this when all are true:

- the extension has general value for Pi extension users
- sensitive local configuration can be replaced with documented settings and env
  var placeholders
- the code can satisfy this repo's zero-runtime-dependency preference or has a
  clearly justified exception
- ownership fits an existing workspace package or a clearly bounded new package
- tests can run without private services or local-only credentials
- license and provenance are clear

### Split into a separate public repo

Choose this when:

- the extension is useful beyond this repo but has a different release cadence,
  audience, or dependency profile
- it would add substantial tool/prompt surface area unrelated to the existing
  packages
- it needs its own docs, governance, or public issue tracker

### Split into a private repo

Choose this when:

- the implementation is reusable for the operator but not safe to publish
- it depends on private services, organization-specific workflows, or proprietary
  prompts/configuration
- redaction would remove most of the useful behavior

### Keep local-only

Choose this when:

- it is machine-specific, experimental, or primarily personal workflow glue
- the code cannot be tested without sensitive local state
- the extension manipulates high-risk local-power surfaces and needs more private
  hardening first
- there is no maintainer-approved public use case yet

### Document only

Choose this when:

- the idea is useful but implementation details are sensitive
- a public architecture note, threat model, or capability summary is enough
- future work should reimplement from scratch rather than copy local code

## 3. Security/privacy review checklist before copying anything

Before any code, docs, tests, fixtures, examples, or generated files move into a
public branch, confirm:

### Secrets and identifiers

- no tokens, credentials, private URLs, team/account IDs, local usernames, host
  names, workspace names, or absolute paths
- no `.env`, local settings, credential caches, browser state, Slack export data,
  Pinet mail data, database files, screenshots, logs, or generated traces
- examples use placeholders such as `<token>`, `<workspace>`, and `<local-path>`

### Prompt and user-data safety

- no private system prompts, user preference text, contact names, channel names,
  project names, or conversation excerpts
- no prompt injection vectors are copied from untrusted local docs/examples
- any user-facing prompt guidance is generalized and reviewed

### Local-power behavior

- shell, filesystem, browser, database, Slack/Pinet, iMessage, and network access
  are explicitly documented and guarded
- mutating actions have confirmation, allowlist, or guardrail names where needed
- tools expose compact schemas and progressive help for cold action families
- dispatcher actions use precise guardrail names such as
  `<extension>:<action>` when applicable

### Dependency/provenance/license

- source ownership is clear
- license compatibility is confirmed
- runtime dependencies are avoided unless explicitly justified
- generated code, vendored snippets, and copied third-party examples are removed
  or attributed correctly

### Public artifact hygiene

- PR description, commits, issue bodies, review comments, screenshots, and test
  output contain only sanitized labels and high-level behavior
- commit history is checked before pushing; sensitive data must not be committed
  and then removed in a later commit

## 4. Proposed packaging/workspace shape if migration is appropriate

Default to one package per independently useful Pi extension:

```text
<sanitized-package>/
  index.ts              # Pi extension composition root
  helpers.ts            # pure/testable logic, when needed
  helpers.test.ts       # Vitest coverage for pure logic
  README.md             # public usage and settings docs
  package.json          # pi manifest and package metadata
  tsconfig.json
  eslint.config.mjs
  LICENSE               # if package-level license is used
```

Root workspace updates for a migrated extension:

- add the package directory to `pnpm-workspace.yaml`
- add the extension entrypoint to root `package.json` `pi.extensions` only if it
  should load by default in this repo's local development configuration
- keep optional/high-risk extensions opt-in by package install or explicit local
  settings rather than enabling them globally by default
- place shared, transport-neutral logic in an existing core package only when it
  is genuinely reused by multiple packages

Package manifest expectations:

```json
{
  "name": "@gugu910/pi-<sanitized-extension>",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./index.ts"] }
}
```

For high-risk local-power extensions, prefer a small adapter package plus a
separate pure helper module so guardrails, tests, and docs are easy to review.

## 5. Testing/typecheck/lint strategy for future migration

For any future migration PR:

1. run `pnpm install --frozen-lockfile` in the worktree before checks
2. add unit tests next to extracted pure helpers
3. add regression tests for guardrail, confirmation, redaction, and config-loading
   behavior
4. use temp directories and mocked environment variables; never require private
   local paths or credentials in tests
5. keep fixtures synthetic and explicitly sanitized
6. run at minimum:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If the extension touches a live integration, include a manual smoke checklist in
the PR but keep the automated test suite offline and deterministic.

## 6. Follow-up issue/PR slices

Recommended public-safe slices:

1. **Private inventory pass** — local operator creates the private evidence log
   and publishes only a sanitized count/category summary.
2. **Sanitized disposition table** — public PR or issue comment with one row per
   sanitized label and no local identifiers.
3. **Security/privacy review for candidate A** — private review first; public
   issue only records high-level risk class and migration decision.
4. **Package scaffold for approved candidate** — create empty/sanitized package
   structure, docs, tests, and settings schema without copying sensitive code.
5. **Implementation migration for approved candidate** — copy or reimplement only
   reviewed code, with tests and redacted docs.
6. **Post-migration audit** — verify commit history, PR text, release notes, and
   package tarball contents contain no sensitive local data.

Each issue body should use sanitized labels, high-level categories, acceptance
criteria, and checklist items. Keep private mappings and detailed findings in the
local evidence log.
