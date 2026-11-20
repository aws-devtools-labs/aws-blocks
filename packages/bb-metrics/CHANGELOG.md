# @aws-cdk-blocks/bb-metrics

## 1.0.0

The first stable release, with no changes since 1.0.0-rc.2. The notes for every change since 0.x are under 1.0.0-rc.0, 1.0.0-rc.1 and 1.0.0-rc.2.

### Changes since `@aws-blocks/bb-metrics` 0.x

- The package is now `@aws-cdk-blocks/bb-metrics`. Install it in place of `@aws-blocks/bb-metrics`, and change the import specifiers.

## 1.0.0-rc.2

### Patch Changes

- 0b422ee: The docs state that `namespace` defaults to the block's `fullId`. `InvalidNamespace` is thrown by `new Metrics(...)` at run time and in local dev, not during synth.

## 1.0.0-rc.1

### Patch Changes

- e529b00: The README error examples import the error constants and `isBlocksError` from `aws-cdk-blocks`, which works in backend and client code.
- fbe48c5: Local data moved from `.bb-data/{fullId}/` to `.cdk-blocks/local/data/{fullId}/`, and existing data is copied over on first use. The `@aws-cdk-blocks/core` changelog has the upgrade steps.

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

- 6d3077e: Docstrings, READMEs, and design notes that pointed at `DistributedTable` describe `KVStore` with a `schema` and a `key`.

## 0.2.0

### Minor Changes

- 88747f5: A Building Block's mock entry throws when it is loaded in a deployed environment, so bundle your backend with the `aws-runtime` export condition. `@aws-blocks/core/bb-utils` exports the check as `assertNotMockInDeployedEnv(bbName)`.

### Patch Changes

- a3969b5: `Metrics.fromExisting()` works during `cdk synth`. A top-level `metrics.child()` call throws the synth-time error, like `emit()`, instead of `x is not a function`.
- a3969b5: A Building Block runtime method called at the top level of a backend module throws `<Class>.<method>() cannot be called during CDK synth` instead of `TypeError: x is not a function`.
- d366907: Updates dependencies in a manual bump dated 2026-10-19.
- 33e8d73: The `Metadata.AWSToolsMetrics.AWSBlocks` template entry now also lists the Building Blocks used by the app (`bb=`) and a count of custom blocks (`custom=`).

## 0.1.9

### Patch Changes

- 92fa27b: Internal refactor that creates named errors through `@aws-blocks/core`'s `blocksError`. No behavior change.

## 0.1.8

### Patch Changes

- a23b8d8: **Breaking: a plain `Error` thrown from an API method reaches the client as a generic `500` with `"Internal error"` instead of its raw message.** To send a specific status, name, and message to the client, throw an `ApiError`, for example `new ApiError("Todo not found", 404, { name: "TodoNotFoundException" })`. Building Block errors keep their name and message on the wire.

## 0.1.7

### Patch Changes

- 5eee114: Every published package carries an npm `keywords` array with the shared `aws-blocks` tag, so `npm search keywords:aws-blocks` finds it.

## 0.1.6

Dependency updates only.

## 0.1.5

Dependency updates only.

## 0.1.4

Dependency updates only.

## 0.1.3

### Patch Changes

- 0491157: `Metrics`, `Tracer`, and `DistributedDatabase` report `bbName` and `bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

## 0.1.2

### Patch Changes

- ba3bf7b: Adds a `DESIGN.md` to each building-block package that describes its architecture, API surface, mock implementation, and key design decisions. It ships on npm alongside `README.md`.

## 0.1.1

### Patch Changes

- 270c049: Ports documentation from the internal staging repo.
- c0558f3: Minor improvements

## 0.1.0

Initial version
