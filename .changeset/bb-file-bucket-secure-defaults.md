---
"@aws-blocks/bb-file-bucket": minor
---

`FileBucket`: secure-by-default hardening. Several of these are **behavior/breaking changes** for existing consumers — because the package is pre-1.0 (0.x), this ships as a `minor` bump per the changesets convention that a `minor` signals a breaking change before 1.0.

- **TLS enforced unconditionally.** Every provisioned bucket now sets `enforceSSL: true`, attaching a bucket policy that denies any request where `aws:SecureTransport` is `false`. Not configurable.
- **Versioning defaults ON.** `versioned` now defaults to `true`; opt out with the literal `versioned: false`. **Breaking:** buckets that were previously non-versioned by default now enable versioning (prior versions accrue storage cost). The non-versioned option typings (no `versionId`) are selected only by the literal `versioned: false`; a non-literal `boolean` or an absent value resolves to the versioned-aware typings.
- **Opt-in server access logging.** New `accessLogging` option (default `false`). When `true`, a dedicated, locked-down log bucket (all public access blocked, S3-managed encryption, SSL enforced) receives the main bucket's access logs under the `access-logs/` prefix.
- **New `logRetentionDays` option** (default `90`). Controls access-log expiration; only applies when `accessLogging` is `true`. Validated at synth — a non-positive or non-integer value throws.
- **Removed `Access-Control-Allow-Credentials: true`** from the local dev file-server's CORS response headers (it should never have been sent for anonymous, token-scoped presigned-URL access).
- **Wildcard-CORS + mutating method now throws at synth.** A CORS rule combining a wildcard origin (`'*'`) with a mutating method (`PUT`/`POST`/`DELETE`) is rejected at synth with an actionable error. **Breaking:** such rules previously deployed unchallenged. Specify explicit origins for mutating methods; wildcard + `GET`/`HEAD` remains allowed.
