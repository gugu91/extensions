# Contributing

## Development

- Install dependencies with `pnpm install`.
- Before opening a PR, run `pnpm check` and `pnpm test` from the repo root.

## Versioning and releases

This repo uses Changesets for package versioning. If your PR should change the version of a published package, run `pnpm changeset`, commit the generated file under `.changeset/`, and open your PR as usual. On every push to `main`, GitHub Actions will run `pnpm check` and `pnpm test`; if changesets are queued it will open or update a **Version Packages** PR, and merging that PR will publish the bumped public packages to npm automatically.

Maintainers also need an `NPM_TOKEN` repository secret with publish access to `@gugu910/*`. Without it, the workflow can still prepare the **Version Packages** PR, but the publish step will fail after that PR is merged until the secret is added.
