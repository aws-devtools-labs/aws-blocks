# @aws-blocks/bb-file-bucket

## 0.2.0

### Minor Changes

- 1b66571: `FileBucket`: secure-by-default hardening. Several of these are **behavior/breaking changes** for existing consumers — because the package is pre-1.0 (0.x), this ships as a `minor` bump per the changesets convention that a `minor` signals a breaking change before 1.0.
  
  - **TLS enforced unconditionally.** Every provisioned bucket now sets `enforceSSL: true`, attaching a bucket policy that denies any request where `aws:SecureTransport` is `false`. Not configurable.
  - **Versioning defaults ON.** `versioned` now defaults to `true`; opt out with the literal `versioned: false`. **Breaking:** buckets that were previously non-versioned by default now enable versioning (prior versions accrue storage cost). The non-versioned option typings (no `versionId`) are selected only by the literal `versioned: false`; a non-literal `boolean` or an absent value resolves to the versioned-aware typings.
  - **Opt-in server access logging routed through stack posture.** New `accessLogging` option; when not set per-block it falls back to the stack `BlocksDefaults.accessLogging`. When enabled, a dedicated, locked-down log bucket (all public access blocked, S3-managed encryption, SSL enforced) receives the main bucket's access logs under the `access-logs/` prefix.
  - **Access-log retention follows the stack posture's `logRetention`.** Log expiration now derives from `BlocksDefaults.logRetention` (`ONE_WEEK` in sandbox / `ONE_YEAR` in production; `RetentionDays.INFINITE` keeps logs indefinitely) instead of a per-block day count. **Breaking (within this unmerged PR):** the per-block `logRetentionDays` option has been **removed** — access-log retention is no longer configured per-block.
  - **Removal policy routed through stack posture.** `removalPolicy` still accepts an explicit per-block `'destroy'|'retain'`; when omitted it now falls back to `BlocksDefaults.removalPolicy` (`DESTROY` in sandbox, `RETAIN` in production), replacing the previous `sandboxMode`-context behavior.
  - **New `noncurrentVersionExpirationDays` option** (default `90`). With versioning on (the default), noncurrent object versions are automatically expired after this many days to bound the storage cost that versioning would otherwise let grow unbounded. Must be a positive integer — a non-positive or non-integer value throws at synth. Disable versioning (`versioned: false`) to drop the rule entirely.
  - **Removed `Access-Control-Allow-Credentials: true`** from the local dev file-server's CORS response headers (it should never have been sent for anonymous, token-scoped presigned-URL access).
  - **Wildcard-CORS + mutating method now throws at synth.** A CORS rule combining a wildcard origin (`'*'`) with a mutating method (`PUT`/`POST`/`DELETE`) is rejected at synth with an actionable error. **Breaking:** such rules previously deployed unchallenged. Specify explicit origins for mutating methods; wildcard + `GET`/`HEAD` remains allowed.
  - **Mock mirrors the CDK synth-time validation.** The local/unit `FileBucket` now reproduces the CDK's two synth-time guards verbatim — the noncurrent-version-expiration range check (positive-integer, validated regardless of `versioned`) and the wildcard-CORS/mutating-method guard — so local and unit runs fail the same way `cdk synth` would (mock↔cdk parity). Both are gated on `!bucket`, matching the CDK's external-bucket early-return.
  - **External `bucket` option documented as not receiving the secure defaults.** The `bucket` option's TSDoc and the README "Wrapping an Existing Bucket" section now state that a wrapped/existing bucket bypasses every secure default (`enforceSSL`, versioning/noncurrent expiration, access logging, `blockPublicAccess`, encryption, the wildcard-CORS guard) — the caller owns that bucket's posture.

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0
  - @aws-blocks/bb-logger@0.1.6

## 0.1.5

### Patch Changes

- 309a236: refactor(bb): attach IAM grants to the shared execution role
  
  Data and auth blocks now grant permissions to the shared Blocks execution role
  (`this.executionRole`) instead of the handler function directly. Grants land on
  the same role the handler assumes, so the effective runtime permissions are
  identical — this decouples IAM wiring from the concrete Lambda function ahead of
  the multi-compute model.
  
  For `bb-distributed-data`, the DSQL endpoint and region now flow through the
  config registry (loaded into `process.env` at cold start, like every other
  block) rather than being set as direct handler environment variables, and the
  migration Lambda maps the shared execution role's ARN.
- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0
  - @aws-blocks/bb-logger@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0
  - @aws-blocks/bb-logger@0.1.4

## 0.1.3

### Patch Changes

- bd59e60: Harden the local dev file server against stored XSS and token forgery. Downloads are now served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`, so an uploaded `text/html`/SVG payload can no longer execute inline in the app's origin. The HMAC secret used to sign presigned-URL tokens is now a per-process random value instead of a hardcoded, source-visible literal, so tokens can no longer be forged offline. Both the token-minting mock and the validating dev file server share the same in-process value, so local presigned-URL round-trips are unaffected.
- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
- Updated dependencies [3c56267]
  - @aws-blocks/core@0.1.17
  - @aws-blocks/bb-logger@0.1.3

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- Updated dependencies [ba3bf7b]
  - @aws-blocks/bb-logger@0.1.2

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
