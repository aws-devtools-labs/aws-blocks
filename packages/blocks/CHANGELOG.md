# @aws-blocks/blocks

## 0.1.5

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
- Updated dependencies [f24d3c3]
- Updated dependencies [d4a1390]
  - @aws-blocks/auth-common@0.1.2
  - @aws-blocks/bb-agent@0.1.3
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-async-job@0.1.2
  - @aws-blocks/bb-auth-basic@0.1.2
  - @aws-blocks/bb-auth-cognito@0.1.4
  - @aws-blocks/bb-auth-oidc@0.1.3
  - @aws-blocks/bb-cron-job@0.1.3
  - @aws-blocks/bb-dashboard@0.1.2
  - @aws-blocks/bb-data@0.1.2
  - @aws-blocks/bb-distributed-data@0.1.2
  - @aws-blocks/bb-distributed-table@0.1.3
  - @aws-blocks/bb-email-client@0.1.3
  - @aws-blocks/bb-file-bucket@0.1.2
  - @aws-blocks/bb-knowledge-base@0.1.3
  - @aws-blocks/bb-kv-store@0.1.3
  - @aws-blocks/bb-logger@0.1.2
  - @aws-blocks/bb-metrics@0.1.2
  - @aws-blocks/bb-realtime@0.1.2
  - @aws-blocks/bb-tracer@0.1.4

## 0.1.4

### Patch Changes

- 7fd51e0: fix(bb-auth-cognito): discriminate `SignInResult` on a string `status` field

  `SignInResult` (from `signIn` / `confirmSignIn` / `autoSignIn`) now discriminates
  on a string `status` (`'signedIn' | 'continueSignIn'`) instead of the `isSignedIn`
  boolean, so native-client codegen (Swift / Kotlin / Dart) emits clean, named,
  switch-decoded variants. Narrow with `if (result.status === 'signedIn')`.

  Breaking change to the `SignInResult` shape (pre-release): `isSignedIn` is removed,
  not aliased.

- Updated dependencies [7fd51e0]
- Updated dependencies [e98bab4]
  - @aws-blocks/bb-auth-cognito@0.1.3
  - @aws-blocks/core@0.1.3

## 0.1.3

### Patch Changes

- 835c425: docs(bb-agent): document AgentStreamChunk types and Message roles
- Updated dependencies [835c425]
- Updated dependencies [dd07335]
  - @aws-blocks/bb-agent@0.1.2

## 0.1.2

### Patch Changes

- 7b80811: Add in-repo Building Block docs discoverability.

  The `@aws-blocks/blocks` package now ships a `docs/` folder containing every Building Block README (one per block) plus a generated `index.md` with a decision tree and catalog. This gives humans and AI agents a single, stable path to all block documentation — `node_modules/@aws-blocks/blocks/docs/` — instead of scattering them across 19+ individual package paths.

  - `@aws-blocks/blocks`: adds `docs/` to the published package (assembled at build time via `scripts/sync-block-docs.mjs`). README expanded to be a comprehensive guide (architecture, workflow, best practices, common mistakes).
  - `@aws-blocks/create-blocks-app`: AGENTS.md templates updated to point to the blocks README and docs folder as the canonical entry points.

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-auth-cognito@0.1.1
  - @aws-blocks/bb-auth-oidc@0.1.1
  - @aws-blocks/auth-common@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-distributed-table@0.1.1
  - @aws-blocks/bb-file-bucket@0.1.1
  - @aws-blocks/bb-kv-store@0.1.1
  - @aws-blocks/bb-metrics@0.1.1
  - @aws-blocks/bb-realtime@0.1.1
  - @aws-blocks/bb-agent@0.1.1
  - @aws-blocks/bb-async-job@0.1.1
  - @aws-blocks/bb-auth-basic@0.1.1
  - @aws-blocks/bb-cron-job@0.1.1
  - @aws-blocks/bb-dashboard@0.1.1
  - @aws-blocks/bb-data@0.1.1
  - @aws-blocks/bb-distributed-data@0.1.1
  - @aws-blocks/bb-email-client@0.1.1
  - @aws-blocks/bb-knowledge-base@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/bb-tracer@0.1.1

## 0.1.0

Initial version
