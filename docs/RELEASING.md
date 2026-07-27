# Releasing AWS Blocks

This document describes how packages in this monorepo are versioned and published to npm.

## How it works

AWS Blocks uses [Changesets](https://github.com/changesets/changesets) for versioning and publishing. The flow is:

1. **Contributors add changesets** — each PR that changes a published package includes a `.changeset/*.md` file describing the change and its semver bump type (`patch`, `minor`).
2. **Changesets accumulate on `main`** — as PRs merge, changeset files pile up.
3. **The Release workflow prepares a version branch** — on every push to `main`, the `Release` workflow runs `changeset version` (consuming all pending changesets, bumping `package.json` versions, updating `CHANGELOG.md` files) and force-pushes the result to the `changeset-release/main` branch.
4. **A maintainer creates and merges the release PR** — this triggers the publish step.

## Release steps

> **Only AWS Blocks team members should perform releases.** External contributors do not need to worry about this process — just include a changeset in your PR.

### 1. Create the release PR

Open this link to create a PR from the prepared branch:

**→ [Create Release PR](https://github.com/aws-devtools-labs/aws-blocks/compare/main...changeset-release/main?expand=1&title=chore%3A+version+packages&body=Release+PR.+Steps+to+complete%3A%0A%0A1.+Get+2+approvals%0A2.+Squash+merge+after+checks+pass%0A3.+Monitor+npm+for+successful+publish%0A%0ASee+%5Bdocs%2FRELEASING.md%5D%28https%3A%2F%2Fgithub.com%2Faws-devtools-labs%2Faws-blocks%2Fblob%2Fmain%2Fdocs%2FRELEASING.md%29+for+details.)**

Title: `chore: version packages`

The diff will show version bumps and changelog updates for all packages with pending changes.

### 2. Get approvals

Require 2 team member approvals. Review the version bumps — ensure:
- Bump types are correct (`patch` for fixes, `minor` for breaking changes in pre-1.0)
- No unexpected packages are included
- Changelog entries are clear and customer-appropriate

### 3. Merge after CI passes

Once PR checks pass and approvals are in, squash merge the PR.

### 4. Verify the publish

After merge, the `Release` workflow runs again. This time it detects no changesets remain and runs the publish step:
- `npm run build` — builds all packages
- `changeset publish` — publishes bumped packages to npm with provenance

Verify:
- Check the [Release workflow run](https://github.com/aws-devtools-labs/aws-blocks/actions/workflows/publish-packages.yml) completed successfully
- Spot-check a package on npm: `npm view @aws-blocks/blocks version`
- Git tags and GitHub Releases are created automatically

## Pre-1.0 semver convention

While packages are pre-1.0:
- `patch` (0.1.1 → 0.1.2): non-breaking change
- `minor` (0.1.x → 0.2.0): **breaking** change
- `major`: blocked by CI (`block-major` guard) — leaving pre-release requires explicit sign-off

## Troubleshooting

### Release workflow shows red on `main`

The workflow may fail to auto-create the release PR due to GitHub token permissions. This is cosmetic — the `changeset-release/main` branch is still updated successfully. Create the PR manually using the link above.

### A package wasn't published

Check that:
- The package had a changeset in the merged PR
- The package name in the changeset matches `package.json` exactly
- The `changeset-check` CI job passed (validates coverage + structure)

### Need to publish urgently without the workflow

```bash
git checkout main && git pull
npm ci && npm run build
npx changeset version
npx changeset publish
```

This requires npm publish credentials (`NPM_TOKEN`) and should only be used as a last resort.
