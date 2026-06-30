# @aws-blocks/bb-kv-store

## 0.1.4

### Patch Changes

- 683bf49: fix(bb-kv-store): discover tests via a glob so the user-agent suite runs

  The `test` script enumerated compiled test files by hand and had drifted from
  the real sources: it ran a non-existent `dist/logger-injection.test.js` (a stale
  leftover) and omitted `dist/user-agent.test.js`, so the user-agent integration
  suite silently never ran in CI — a false green.

  The script now globs `dist/*.test.js` (matching the `bb-email-client` /
  `bb-tracer` idiom and keeping `--test-concurrency=1`), so every compiled test
  file is auto-discovered and the enumerate-and-omit drift is structurally
  impossible. Enabling the user-agent suite surfaced a stale, never-run test that
  expected a custom (non-official) ancestor BB to appear in the user-agent chain;
  per `@aws-blocks/core`'s design only official BB names are emitted, so that test
  was corrected and a case asserting custom names are excluded was added. No
  runtime change to `@aws-blocks/core`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
  - @aws-blocks/core@0.1.6

## 0.1.3

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

## 0.1.2

### Patch Changes

- 18880ff: Minor test improvements
- Updated dependencies [18880ff]
  - @aws-blocks/core@0.1.2

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
