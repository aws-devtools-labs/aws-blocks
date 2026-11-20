# @aws-cdk-blocks/create-block

## 1.0.0

The first stable release. The changes since 1.0.0-rc.2 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/create-block` 0.x

- The package is now `@aws-cdk-blocks/create-block`. Run `npm create @aws-cdk-blocks/block@latest` in place of `npm create @aws-blocks/block@latest`.
- 703238f: The scaffolded backend folder is `cdk-blocks/` instead of `aws-blocks/`.

### Since 1.0.0-rc.2

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The generated block README has an `## Errors` table seeded with `InvalidInput`, a `Default` column in the options table, and `TODO` markers on the paragraphs to replace.

## 1.0.0-rc.1

### Patch Changes

- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.
- e529b00: Client code can import the block error constants, `isBlocksError`, and `ApiError` from `aws-cdk-blocks`, which also exports `RealtimeErrors`. The Building Block classes and `sql` are still server-only, so browser code uses `import type` for their types.

## 1.0.0-rc.0

### Major Changes

- e50b9e9: **Breaking: every published package moves from the `@aws-blocks` scope to `@aws-cdk-blocks`, and `@aws-blocks/blocks` becomes the unscoped `aws-cdk-blocks`.**

  To upgrade:

  1. In `package.json`, replace `@aws-blocks/blocks` with `aws-cdk-blocks` and every other `@aws-blocks/` name with `@aws-cdk-blocks/`, for example `@aws-cdk-blocks/core`.
  2. Make the same replacement in the specifier of every import.
  3. Change each `Annotations.of(stack).acknowledgeWarning('@aws-blocks/…')` call to the `@aws-cdk-blocks/` prefix, or `cdk synth --strict` fails on the warning.
  4. Keep the CDK context key `@aws-blocks/bb-data:encryptStorageByDefault` in `cdk.json` as it is, because renaming it makes CloudFormation replace the cluster.
  5. If you publish a block, move its dependency from `@aws-blocks/core` to `@aws-cdk-blocks/core`.

  No export or option moved, and the old `@aws-blocks/*` packages stop receiving releases.

### Minor Changes

- 703238f: **Breaking: the scaffolded backend folder is `cdk-blocks/`, not `aws-blocks/`.**

  To upgrade:

  1. Rename the `aws-blocks/` directory to `cdk-blocks/`.
  2. Change the `"workspaces"` entry that names it.
  3. Change the `"name"` in its `cdk-blocks/package.json` to `cdk-blocks`.
  4. Change every `from 'aws-blocks'` import to import `cdk-blocks`.
  5. Rename an `aws-blocks/migrations` directory or set an explicit migrations path, because `DEFAULT_MIGRATIONS_ROOT` is now `./cdk-blocks/migrations`.

  The reserved URL namespace, such as `/aws-blocks/api` and `/aws-blocks/auth/*`, keeps its path, so deployed routes and OAuth callback URLs keep working.

### Patch Changes

- aaf419f: The sandbox, deploy, and destroy scripts run their `cdk` commands without a shell. Only the sandbox's local dev-server command still runs under a shell.
- e098c7a: New Building Blocks scaffolded inside the AWS Blocks repo get a JSDoc pointer to their docs bundled in `aws-cdk-blocks` at `docs/<package>/README.md`, instead of a `node_modules` package directory.
- afb2707: The external-mode "Next steps" `cd` hint uses the `--dir` target instead of the default package folder name. A path that contains spaces or shell metacharacters is shell-quoted.

## 0.3.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.2.2

### Patch Changes

- 66f4be2: **Breaking: `BlocksStack.handler`, `BlocksBackend.handler`, and `Scope.handler` are removed.**

  To upgrade:

  1. Replace `blocksStack.handler.addEnvironment('KEY', value)` with `registerConfig(blocksStack, 'KEY', value)`.
  2. Replace `resource.grantRead(blocksStack.handler)` with `resource.grantRead(blocksStack.executionRole)`.
  3. Replace `blocksStack.handler.addToRolePolicy(statement)` with `blocksStack.executionRole.addToPrincipalPolicy(statement)`.
  4. In a custom Building Block, replace `this.handler` with `this.executionRole` or `registerConfig(this, …)`.
  5. Replace `handler.addEnvironment('CORS_ALLOWED_ORIGINS', …)` with `defaults: { ...BlocksPresets.production, allowedOrigins: [...] }`.

  A real environment variable of the same name wins over a `registerConfig` entry, where the last `addEnvironment` call won before.

## 0.2.1

### Patch Changes

- d4b32f2: `@aws-blocks/create-block` ships `README.md` and `DESIGN.md` in the published package.
- f04dbc4: The block scaffolder checks the npm scope derived from the workspace `package.json` `name` against the same allowlist as the `--scope` flag. It runs `npm run build` and `npm test` through an argument array instead of a shell string.

## 0.2.0

### Minor Changes

- a4ee47e: Adds `@aws-blocks/create-block`, a scaffolder for new Building Blocks. Run `npm create @aws-blocks/block@latest <ClassName>` to generate a complete `bb-*` package with its layers, docs, and passing tests.

### Patch Changes

- b49fdd9: `@aws-blocks/create-block` has the `aws-blocks` keyword, so it appears in `npm search keywords:aws-blocks`.
