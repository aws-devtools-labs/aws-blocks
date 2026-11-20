# @aws-cdk-blocks/pipeline

## 1.0.0

The first stable release. The changes since 1.0.0-rc.1 are listed below. The notes for every other change since 0.x are under 1.0.0-rc.0 and 1.0.0-rc.1.

### Changes since `@aws-blocks/pipeline` 0.x

- The package is now `@aws-cdk-blocks/pipeline`. Install it in place of `@aws-blocks/pipeline`, and change the import specifiers.

### Since 1.0.0-rc.1

- 63e571c: Use AWS CDK Blocks consistently in starter apps, CLI messages, package metadata, and documentation. Package imports and commands are unchanged.

## 1.0.0-rc.1

### Patch Changes

- 8fbbeca: The hosting docs cover front-door compatibility, hosting options, and synth errors, and the package ships the custom front-door guide. The pipeline quick start uses `Pipeline.create()` and documents the pipeline options and their defaults.

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

### Patch Changes

- d01c34c: Adds API Extractor reports, `API.md`, for `@aws-cdk-blocks/hosting`, `@aws-cdk-blocks/pipeline`, and `@aws-cdk-blocks/bb-compute`. The block docs folder of `aws-cdk-blocks` ships them next to each package's README.
- d01c34c: A new test checks the code samples of every doc shipped in `docs/` against the packages. The bb-auth README's frontend sample matches with `isBlocksError(e, 'NotAuthenticatedException')` from `aws-cdk-blocks/client` instead of importing `AuthErrors` from `aws-cdk-blocks`.

## 0.2.4

### Patch Changes

- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 27c35e5: The docs state that `Secret` reads pick up rotated values after `cacheTtlSeconds`, not only on cold start, and that `EmailClient` validates recipient and size limits on AWS too. Other fixes cover the `useChat` anchor, `Pipeline` connection ARN examples, and the `KnowledgeBase` mock's chunking.

## 0.2.3

Dependency updates only.

## 0.2.2

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.2.1

### Patch Changes

- 4b74c7f: Adds `encodeManagedValue`, `decodeManagedValue`, `managedValueReplacer`, and `managedValueReviver` to `@aws-blocks/hosting`, so `secret()` and `config()` markers survive a JSON round-trip. `PipelineProps` takes an optional `postStage` hook that returns each stage's post-deploy steps.
- 5960fa4: Pipeline rejects an invalid stage name such as `qa_east` at synth, with a suggested valid name such as `qa-east`. A stage name must match `/^[A-Za-z][A-Za-z0-9-]*$/`.

## 0.2.0

### Minor Changes

- 9d4ccea: Adds `secret('KEY')` and `config('KEY')` to hosting and pipeline, which keep values in AWS Secrets Manager and SSM Parameter Store for `getSecret('KEY')` and `getConfig('KEY')` to read at runtime. Set values with `npm run secret` and `npm run config`, and run `npm run typegen` for typed keys.

### Patch Changes

- 947a1bd: `Pipeline.create()` no longer fails with "stage '<name>' contains no stacks" when the app resolves a different `aws-cdk-lib` copy than `@aws-blocks/pipeline`.

## 0.1.1

### Patch Changes

- e98bab4: Moves the `Pipeline` construct into the `@aws-blocks/pipeline` package and adds `partialBuildSpec` for CodeBuild runtime control. The CDK entrypoint of `@aws-blocks/core` re-exports `Pipeline`, `DeployStage`, and the pipeline configuration types.
