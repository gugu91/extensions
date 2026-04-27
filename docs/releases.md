# Release workflow

This repo ships workspace packages to npm manually after code lands on `main`.
The goal is simple: merged fixes should have a short, explicit path from GitHub
into published npm packages.

## Release policy

- Treat every user-facing fix as **unreleased** until the relevant package is
  published to npm.
- Keep release prep **small and package-scoped**. Do not batch unrelated fixes
  just because they landed near each other.
- Prefer a patch release for bug fixes unless the package surface clearly needs
  a minor or major bump.
- Update `CHANGELOG.md` in the same PR that prepares a release.
- Verify the package tarball locally before publishing.
- **Publish only from `main`.** Never publish from a feature branch, stacked branch,
  or worktree branch even if the commits are already approved.

## Package list

Public workspace packages in this repo:

- `@gugu910/pi-slack-bridge`
- `@gugu910/pi-nvim-bridge`
- `@gugu910/pi-neon-psql`
- `@gugu910/pi-slack-api`
- `@gugu910/pi-transport-core`

The root `pi-extensions` package is private and is only bumped for repo-level
tracking when a release note needs to reflect the current published surface.

## Manual release checklist

1. Start from an up-to-date `main` checkout.
2. Confirm you are publishing from `main`, not a feature branch or issue worktree branch.
3. Identify the package(s) whose fixes should ship.
4. Bump only the package version(s) that need a release.
5. Update `CHANGELOG.md` with:
   - release date
   - version verification
   - the shipped highlights
   - linked PRs/issues when useful
6. Run focused verification for each releasing package:
   - `pnpm --filter <package> lint`
   - `pnpm --filter <package> typecheck`
   - `pnpm --filter <package> test` (if the package has tests)
   - `pnpm --filter <package> pack`
7. Inspect the tarball contents to confirm the npm surface is correct.
8. Install the tarball locally in a temp directory and smoke-import the published exports before `npm publish`.
9. Merge the release-prep PR.
10. Publish from `main`:

- `pnpm --filter <package> publish --access public --no-git-checks`

11. Tag the release if maintainers want a matching git tag.
12. Confirm npm shows the new version.

## Pack verification

`pnpm --filter <package> pack` is the minimum pre-publish gate because it checks
what npm users will actually receive, not just what exists in the repo.

After generating the tarball, do one more operator-level check before publish:
install that tarball into a temporary directory and smoke-test the exports that
npm users rely on. At minimum, confirm the package installs cleanly and that a
basic `import` of the documented entrypoint works.

For this repo, a good pack review confirms:

- `dist/` is present and up to date
- `README.md` and `LICENSE` are included
- package-specific runtime assets are included (`manifest.yaml`, `nvim/`,
  Python helpers, CLI bin files, etc.)
- no local-only or sensitive files leaked into the tarball

A simple pattern is:

```bash
PACKAGE="@gugu910/pi-slack-bridge"
TARBALL="$(pnpm --filter "$PACKAGE" pack | tail -n 1)"
TMPDIR="$(mktemp -d)"

cd "$TMPDIR"
npm init -y
npm install "/absolute/path/to/$TARBALL"
node --input-type=module -e 'await import("@gugu910/pi-slack-bridge")'
```

The exact smoke import can vary by package, but the rule stays the same: verify
real installability and real exports before `npm publish`.

## Current gap this workflow closes

Historically, `main` has been ahead of npm, which leaves users installing stale
packages even after fixes merged. This workflow makes the release path explicit:

- merge the fix
- prep a small release PR
- verify the exact npm tarball
- publish from `main`

That is intentionally manual for now so maintainers do not need to wire npm
secrets into CI before the release process is clear and repeatable.
