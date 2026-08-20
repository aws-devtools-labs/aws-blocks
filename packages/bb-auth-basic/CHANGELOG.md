# @aws-blocks/bb-auth-basic

## 0.1.6

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-kv-store@0.1.6
  - @aws-blocks/auth-common@0.1.5
  - @aws-blocks/bb-app-setting@0.1.4
  - @aws-blocks/bb-logger@0.1.4

## 0.1.5

### Patch Changes

- 3c56267: `AuthBasic` and `Logger` now report `bbName`/`bbVersion` to `Scope`, so they appear in telemetry like every other Building Block.

  Both were listed in the umbrella's `aws-blocks.vendorize` map, so `scripts/generate-bb-names.mjs` had already generated them into `OFFICIAL_BB_NAMES` — but neither passed `bbMeta` to `super()`, and `Scope` only records a block in its registry when `bbName` is set. Their entries in that set were therefore inert: `Scope.getRegisteredBlocks()` could never name either block, so `product.buildingBlocks` under-reported two of the most widely used blocks. Each package now carries the standard `prebuild` (`generate-version.mjs AuthBasic` / `Logger`), which generates the `BB_NAME`/`BB_VERSION` its constructor passes through — the same wiring the other blocks use.

  `Logger` is composed internally by most other blocks (`new Logger(this, 'logger', { level: 'error' })`), so it will now be reported for effectively every application, and `totalCount` rises accordingly. That is the intended reading of the existing `Logger` entry in the vendorize map, not a new disclosure: `getRegisteredBlocks()` still exposes only names already on the official list, and customer-chosen block names remain counted-but-unnamed.

  `@aws-blocks/blocks` takes a `patch` because it re-exports both blocks; sibling releases stay inside its caret range, so `changeset version` would not bump it on its own (#273, #212). `@aws-blocks/core` needs no bump — both names were already present in the generated `OFFICIAL_BB_NAMES`, so that file is byte-identical.

- Updated dependencies [75f5446]
- Updated dependencies [2ed4177]
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [b83aaba]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/auth-common@0.1.4
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-kv-store@0.1.5
  - @aws-blocks/bb-logger@0.1.3

## 0.1.4

### Patch Changes

- 61bd709: Keep AuthBasic error constants browser-safe by exporting them from a shared module instead of re-exporting through the server entry.

## 0.1.3

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
- Updated dependencies [683bf49]
  - @aws-blocks/core@0.1.6
  - @aws-blocks/auth-common@0.1.3
  - @aws-blocks/bb-kv-store@0.1.4

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
