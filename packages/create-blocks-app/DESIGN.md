# create-blocks-app: notes for contributors

## Registering a template

Every folder under `templates/` is a self-registering template. Each `package.json` in that folder sets a `blocksTemplateDescription` field, which the CLI reads to build the `--help` catalog, so the CLI is the source of truth for the template list and descriptions.

## `@aws-cdk-blocks/*` dependency ranges

- A template declares each `@aws-cdk-blocks/*` dependency as `"*"`, a placeholder.
- Inside this monorepo the CLI rewrites the placeholders in the app's root `package.json` to `file:` paths to the sibling packages.
- From the published CLI it stamps the range listed for that package in create-blocks-app's own `devDependencies`, which `changeset version` keeps on the package's current release line.
- When a template starts using another `@aws-cdk-blocks/*` package, add it to create-blocks-app's `devDependencies` too; the unit tests fail until you do.
- A devDependency bump never releases the CLI on its own, so `.changeset/config.json` puts create-blocks-app and `aws-cdk-blocks` in one `fixed` group: every blocks release also releases the CLI, with the updated ranges.
- A new release line of a package blocks depends on (such as `@aws-cdk-blocks/hosting`) falls outside blocks' caret range for it, so changesets releases blocks, and with it the CLI.
- A template imports Building Blocks from `aws-cdk-blocks`, and only writes an `@aws-cdk-blocks/*` package that blocks itself lists in `dependencies`.
