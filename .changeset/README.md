# Changesets workflow

This repo uses [Changesets](https://github.com/changesets/changesets) to record package version bumps and changelog notes in PRs.

## Contributor flow

1. Make your code changes.
2. If your PR should change a published package version, run `pnpm changeset` from the repo root.
3. Select the affected package(s), choose the bump type, and write a short human-readable summary.
4. Commit the generated markdown file in `.changeset/` alongside your code changes.

## What happens after merge

- Every push to `main` runs the release workflow.
- If changeset files are queued, GitHub Actions opens or updates a **Version Packages** PR with the version bumps and changelog entries.
- When that PR is merged, the next run publishes the bumped public packages to npm automatically.

If a PR is tooling-only or should not publish anything, do not add a release changeset unless a maintainer explicitly wants to force a release cycle.
