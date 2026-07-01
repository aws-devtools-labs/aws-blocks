# @aws-blocks/bb-data

## 0.2.0

### Minor Changes

- 42fcbdf: Add an `ssl` option to external database connections and verify the server's TLS
  certificate by default.

  `fromExisting({ connectionString })` now accepts an `ssl` option and verifies the
  server certificate by default instead of silently disabling verification. The `ssl`
  option is a discriminated union — `{ rejectUnauthorized?: true; ca?: string } | { rejectUnauthorized: false }` —
  so the misleading `{ ca, rejectUnauthorized: false }` (a pinned CA that `pg` would
  ignore) is a compile-time error. A TLS 1.2 floor is enforced on every connection.
  `bb-data pull` prompts for your provider CA and commits it to
  `aws-blocks/database.ca.ts` (a public, non-secret cert bundled into the deployed
  function), so the generated connection is verified by default — including in the
  deployed Lambda — with no runtime configuration. `DATABASE_CA_CERT` (inline PEM or
  file path) overrides the committed cert. Without any CA, local dev falls back to a
  visible, editable `rejectUnauthorized: false`, while the **deployed function and
  non-interactive (CI) migrations fail closed** rather than running unverified. Local
  dev keeps the previous unverified default for self-signed local databases (now with
  a warning when `ssl` is omitted, since the deployed runtime verifies).

  Upgrade note: if you call `fromExisting({ connectionString })` **directly** (not via
  `db pull`-generated code) with no `ssl` option, the connection now verifies the
  server certificate. Providers that use a private CA (e.g. Supabase) require pinning
  it — pass `ssl: { ca }` (the certificate contents) — otherwise the connection will
  fail to validate. Pass `ssl: { rejectUnauthorized: false }` to keep the previous
  behavior explicitly. `db pull`-generated apps are unaffected in default
  connectivity.

  CI note: the `bb-data` CLI and migration paths (migrate status, generate-types,
  baseline, external migrations) now **fail closed in non-interactive runs** (`CI`
  set, excluding `CI=false`/`0`) when no CA is available. If you run these in CI/CD,
  set `DATABASE_CA_CERT` to your provider CA (inline PEM or a file path); otherwise
  they will throw instead of connecting unverified. Interactive (local) runs keep the
  warned, encrypted-but-unverified fallback.

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-app-setting@0.1.3
  - @aws-blocks/bb-logger@0.1.2

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-app-setting@0.1.1
  - @aws-blocks/bb-logger@0.1.1
  - @aws-blocks/data-common@0.1.1

## 0.1.0

Initial version
