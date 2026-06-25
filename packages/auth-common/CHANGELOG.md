# @aws-blocks/auth-common

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- d4a1390: Fix `onAuthChange` and `Authenticator` to paint a synchronous first frame.

  Both previously deferred their initial emit/render behind the async
  `ensureState().then(...)`, so a signed-out UI never painted synchronously on
  subscribe — leaving a blank first frame and causing non-deterministic timeouts
  in CI harnesses (and contradicting `onAuthChange`'s documented "calls callback
  immediately" contract). `onAuthChange` now emits the last-known user from the
  shared cache synchronously, then refreshes from the async hydration — with a
  dedupe to avoid a spurious `null → user` flash and a `.catch` so a rejected
  `getAuthState()` never strands the UI. `Authenticator` does the same synchronous
  first paint from the cache and gains the same `.catch` hardening.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1

## 0.1.0

Initial version
