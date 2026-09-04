# FileBucket — Design

Design document for FileBucket. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-file-bucket`
**Type:** Primitive (new infrastructure)
**AWS Service:** Amazon S3

## Design Decisions

**D-FB-1: Buffer body type instead of ReadableStream**
**Decision:** `put()` accepts `Buffer | string`, `get()` returns `Buffer` in `FileContent.body`.
**Rationale:** ReadableStream adds complexity for the common case (small-to-medium files). Buffer is simpler to work with in Lambda (where the entire response must be buffered anyway). For large files, presigned URLs (`getUrl`/`putUrl`) are the recommended pattern. This favors client-safe return types.

**D-FB-2: Segregated internal storage in mock**
**Decision:** The mock stores user content, sidecar metadata, and version history under separate sibling roots inside `.bb-data/{fullId}/`:
```
content/{key}                     file body (byte-identical to what was written)
meta/{key}.json                   sidecar metadata
versions/{key}/{versionId}        version body
versions/{key}/{versionId}.json   version metadata
versions/{key}/__deleted__        delete marker (sentinel)
```
**Rationale:** Keeps file content byte-identical (no wrapping format) while guaranteeing internal bookkeeping can never collide with user keys. An earlier design co-located metadata as `{path}.__meta__.json` next to each file and relied on marker substrings, which meant a user key like `data.__meta__.json` or a directory named `x.__versions__/` could be silently hidden or shadowed by `scan()`. Because user content now lives only under `content/`, `scan()` walks that one root and yields everything with no marker-based filtering — arbitrary keys are supported, matching S3 semantics.

**D-FB-3: deleteBatch chunks at 1,000**
**Decision:** `deleteBatch()` internally chunks into groups of 1,000 and issues separate `DeleteObjects` calls.
**Rationale:** S3 `DeleteObjects` API supports max 1,000 keys per request. Chunking is transparent to the caller. Batch methods handle pagination internally.

**D-FB-4: Presigned URL default expiry of 3600 seconds**
**Decision:** Both `getUrl` and `putUrl` default to 1 hour expiry.
**Rationale:** Matches the S3 SDK default. Long enough for typical browser upload/download flows, short enough to limit exposure.

**D-FB-5: scan returns AsyncIterable**
**Decision:** `scan()` returns `AsyncIterable<FileInfo>` with internal pagination.
**Rationale:** AsyncIterable is used for unbounded result sets. S3 `ListObjectsV2` paginates at 1,000 keys; the iterable handles continuation tokens transparently.

**D-FB-6: Versioning is opt-in with runtime API support**
**Decision:** `versioned: true` enables S3 object versioning and unlocks version-aware methods (`listVersions`, `restoreVersion`, optional `versionId` on `get`/`delete`/`getUrl`/`getFileHandle`). Without the flag, the API surface is unchanged.
**Rationale:** Versioning adds storage cost and complexity. Making it opt-in keeps the default simple. When enabled, the runtime API exposes the full version lifecycle — listing, retrieving specific versions, permanent deletion of individual versions, and restoring old versions. `restoreVersion` is implemented as a CopyObject from the old version (S3 has no native restore), which creates a new version that becomes current.
**Update:** The **default flipped to ON** — see D-FB-10. The runtime API described here is unchanged; only the default value of `versioned` and its typing gate changed.

**D-FB-7: Mock versioning uses filesystem directories**
**Decision:** Versioned mock stores each version in `versions/{key}/v{n}` with monotonic IDs. Delete markers are `versions/{key}/__deleted__` sentinel files.
**Rationale:** Simple, inspectable, and matches the S3 semantics closely enough for local development. Monotonic IDs (`v1`, `v2`, ...) are deterministic and easy to reason about in tests, unlike S3's opaque version IDs. Version history lives under the segregated `versions/` root (see D-FB-2), so it never appears in `scan()` or collides with a user key.

**D-FB-8: Bucket name validated at synth — error, never truncate/hash**
**Decision:** The derived bucket name (`scope.fullId`) is validated against S3's naming rules (`bucket-name.ts`) before the bucket is constructed. An invalid name throws a `ValidationFailed` error with an actionable message. The same validator runs in the mock constructor so local dev (`bb dev`) fails identically — parity. `FileBucket.fromExisting(...)` skips validation since the name is externally owned.
**Rationale:** S3 bucket names are globally unique and immutable. Truncating to fit 63 chars risks collisions, and a name that shifts between deploys (e.g. after a hash input changes) would orphan or replace the customer's data — a far worse outcome than a fast, fixable synth error. Erroring puts the fix in the developer's hands (shorten a scope id once; the name is then stable forever) and matches the manual-shortening pattern already used in `bb-agent`. This deliberately differs from DynamoDB-backed BBs (KVStore/DistributedTable) which `substring(0, 255)` — DynamoDB's 255 limit is generous and table names are internal, disposable, and not globally unique, so silent truncation is acceptable there.

**D-FB-9: TLS enforced unconditionally (enforceSSL)**
**Decision:** Every provisioned bucket (the data bucket and the opt-in access-log bucket) sets `enforceSSL: true`, so CDK attaches a bucket policy denying any request where `aws:SecureTransport` is `false`. Not configurable.
**Rationale:** All FileBucket traffic — SDK calls and presigned URLs alike — is already HTTPS, so enforcing TLS closes the in-transit exposure gap with zero functional cost. There is no legitimate reason a FileBucket consumer needs plaintext S3 access, so this is a hard default rather than an option. Covered by the `enforces SSL` CDK test.

**D-FB-10: Versioning default ON — supersedes D-FB-6's opt-in default**
**Decision:** `versioned` now defaults to `true`; consumers opt out with the literal `versioned: false`. The version-aware runtime API and its option typings (`GetOptionsFor` et al.) remain unchanged in shape, but the conditional types now select the non-versioned (optionless) form only for the literal `versioned: false` — a non-literal `boolean` or an absent value resolves to the versioned-aware form, matching the new runtime default.
**Rationale:** Accidental overwrites and deletes are unrecoverable without versioning; defaulting it on makes the safe choice the default and matches the "secure by default" posture of D-FB-9. This is a **behavior/breaking change** for existing consumers (buckets that were non-versioned by default now enable versioning, which adds storage cost for prior versions), so it ships with a `minor` changeset bump under the pre-1.0 (0.x) convention that a minor signals a breaking change. The literal-`false` typing gate is a deliberate consequence of `extends { versioned: false }`: TypeScript cannot narrow a widened `boolean` to the `false` branch, so the versioned-aware typings are the safe fallback.

**D-FB-11: Opt-in server access logging with a dedicated locked-down log bucket**
**Decision:** `accessLogging: true` provisions a second, dedicated S3 bucket (all public access blocked, S3-managed encryption, `enforceSSL`) that receives the main bucket's server access logs under the `access-logs/` prefix. Logs expire via a lifecycle rule after `logRetentionDays` (default `DEFAULT_ACCESS_LOG_RETENTION_DAYS = 90`). `logRetentionDays` is validated at synth: when access logging is enabled, a non-positive or non-integer value throws — a degenerate `Duration.days(0)`/negative lifecycle would otherwise only surface at deploy. The value is inert (and therefore not validated) when `accessLogging` is off.
**Rationale:** Access logging is off by default because it has a real cost (extra bucket, log storage) and most consumers don't need an audit trail; making it opt-in keeps the default lean. The log bucket is kept **separate** from the data bucket so log delivery can't loop back onto the bucket being logged. Validating `logRetentionDays` at synth follows the same fail-fast principle as D-FB-8 (bucket name) and the CORS guard (D-FB-12): misconfiguration fails loud at synth, not minutes into a deploy.
**Update (superseded by D-FB-13):** The per-block `logRetentionDays` option was **removed**. Access-log retention is no longer configured per-block; it now derives from the framework-wide `scope.defaults.logRetention` (`RetentionDays.ONE_WEEK` in sandbox / `ONE_YEAR` in production; `RetentionDays.INFINITE` omits the expiry rule so logs are kept indefinitely). The `accessLogging` toggle itself likewise falls back to `scope.defaults.accessLogging` when not set per-block. The dedicated locked-down log bucket and its separation from the data bucket (the substance of this decision) are unchanged — only the *source* of the retention/enable posture moved from a per-block number to the stack `BlocksDefaults`. The synth-time validation that formerly guarded `logRetentionDays` no longer applies (there is no per-block retention input); the equivalent guard now lives on `noncurrentVersionExpirationDays` — see D-FB-14.

**D-FB-12: Wildcard-origin CORS + mutating method rejected at synth**
**Decision:** A CORS rule whose `allowedOrigins` includes `'*'` and whose `allowedMethods` includes a mutating method (`PUT`/`POST`/`DELETE`, the `MUTATING_CORS_METHODS` set) throws a synth-time `Error`. Wildcard + safe methods (`GET`/`HEAD`) is allowed; explicit origins + mutating methods is allowed.
**Rationale:** A wildcard origin on a state-changing method lets any website issue authenticated cross-origin writes/deletes against the bucket — a CSRF-shaped exposure. Rather than silently deploying it, FileBucket fails loud at synth with an actionable message pointing the developer at explicit origins. A hard error (not a warning) was chosen deliberately: this PR supersedes the prior behavior where such a rule deployed unchallenged, and the user opted for the strict gate over a soft warning.

**D-FB-13: Posture knobs route through the framework `BlocksDefaults` — supersedes the per-block `logRetentionDays` and the `sandboxMode`-context removal read**
**Decision:** `removalPolicy`, `accessLogging`, and access-log retention are resolved from the stack-wide `BlocksDefaults` model (exposed as `scope.defaults`) rather than from per-block day-numbers or a `sandboxMode` CDK context read. Each posture knob follows the framework's `options?.field ?? scope.defaults.field` contract (the same pattern `bb-kv-store` uses for `removalPolicy`/`deletionProtection`, and documented on the `Scope.defaults` getter in `@aws-blocks/core/cdk`):
- `removalPolicy` — an explicit per-block `'destroy'|'retain'` still wins; when omitted it falls back to `scope.defaults.removalPolicy` (`DESTROY` in the sandbox preset, `RETAIN` in production). This replaces the previous `sandboxMode`-derived removal.
- `accessLogging` — falls back to `scope.defaults.accessLogging` when not set per-block, so a production-postured stack can opt every FileBucket into logging without a per-block flag.
- **access-log retention** — derives from `scope.defaults.logRetention` (a `RetentionDays` enum: `ONE_WEEK` sandbox / `ONE_YEAR` production). `RetentionDays` is a numeric enum whose member value *is* the day count, so it maps directly to `Duration.days(...)`; the one non-day member `INFINITE` omits the lifecycle expiry rule (logs kept forever) rather than expiring at a spurious 9999 days.
**Rationale:** Addresses review comment (C): posture should come from the one stack-level model every block already consumes, not from a grab-bag of per-block numbers and a legacy `sandboxMode` context flag. Centralizing on `BlocksDefaults` means a stack picks `BlocksPresets.sandbox`/`.production` once and every FileBucket inherits a coherent removal + logging + retention posture, while per-block overrides remain available for the knobs that still accept them (`removalPolicy`, `accessLogging`). This also removes the last consumer of the `sandboxMode` context read from this package.

**D-FB-14: Noncurrent-version expiration bounded by default (90 days)**
**Decision:** When versioning is enabled (the default — D-FB-10), the main bucket gets a lifecycle rule (`ExpireNoncurrentVersions`) that permanently expires **noncurrent** object versions after `noncurrentVersionExpirationDays` (default `DEFAULT_NONCURRENT_VERSION_EXPIRATION_DAYS = 90`). The value's FORMAT is validated at synth whenever the option is provided, regardless of `versioned`: a non-positive or non-integer value throws (a degenerate `Duration.days(0)`/negative would otherwise only surface at deploy — same fail-fast principle as D-FB-8/D-FB-12). The rule itself is only APPLIED when versioning is on. There is no "disable" sentinel; to drop the rule entirely, disable versioning (`versioned: false`), which removes it along with versioning. The rule is inert on the mock and browser runtimes (no AWS resource).
**Rationale:** Addresses review comment (A): defaulting versioning ON (D-FB-10) makes overwrites/deletes recoverable but lets prior versions accrue storage cost without bound. Capping noncurrent versions at 90 days by default keeps the safe-by-default posture affordable — the common case (recover from a recent bad write) is well within 90 days, while stale versions no longer pile up indefinitely. It pairs with, and offsets the cost concern raised by, the versioning-default-on change rather than reopening that decision.

## Infrastructure (CDK)

Creates a single S3 bucket (plus a dedicated log bucket when `accessLogging` is enabled):

- **Bucket name:** Derived from `scope.fullId` (the bucket id joined to its parent scope ids with `-`). Validated at synth against S3's naming rules — see D-FB-6.
- **Block public access:** All four settings enabled (BLOCK_ALL)
- **Encryption:** S3-managed keys (SSE-S3)
- **TLS:** Enforced unconditionally (`enforceSSL: true`) — a bucket policy denies any request where `aws:SecureTransport` is `false`. Not configurable. See D-FB-9.
- **Versioning:** Enabled by default (secure default); opt out via `options.versioned: false`. See D-FB-10. When on, a lifecycle rule expires noncurrent versions after `options.noncurrentVersionExpirationDays` (default 90, validated as a positive integer at synth) to bound version-storage cost. See D-FB-14.
- **Server access logging:** Enabled per-block via `options.accessLogging`, falling back to `scope.defaults.accessLogging` when omitted; when on, provisions a separate, locked-down log bucket whose logs expire after the stack posture's `scope.defaults.logRetention` (`ONE_WEEK` sandbox / `ONE_YEAR` production; `INFINITE` = no expiry). See D-FB-11 and D-FB-13.
- **CORS:** Configured from `options.corsRules` if provided. A wildcard origin (`'*'`) combined with a mutating method (PUT/POST/DELETE) is rejected at synth. See D-FB-12.
- **Lifecycle rules:** Configured from `options.lifecycleRules` if provided (merged with the noncurrent-version expiration rule above)
- **Removal policy:** Resolved from `options.removalPolicy` (`'destroy'|'retain'`) when set, else the stack posture default `scope.defaults.removalPolicy` (DESTROY sandbox / RETAIN production) — replacing the former `sandboxMode` context read. See D-FB-13.
- **Auto-delete objects:** Enabled when removal policy is DESTROY
- **Permissions:** `grantReadWrite` to the parent scope's handler automatically

## Mock Implementation

- Files stored on the local filesystem at `.bb-data/{scope.fullId}/` via `getMockDataDir()` from core.
- Internal data is segregated into sibling roots so it can never collide with user keys (see D-FB-2):
  - `content/{key}` — file body, byte-identical to what was written.
  - `meta/{key}.json` — sidecar metadata.
  - `versions/{key}/{versionId}` (+ `.json` sidecars, `__deleted__` marker) — version history.
- Path mapping for both the mock and the dev file-server is centralized in `paths.ts` so they stay in lockstep.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- Presigned URLs are served by the dev file-server at `/.bb-file-bucket/{scope.fullId}/{path}?token=...`. The path segments are URL-encoded; the server decodes them and validates an HMAC token scoped to method, path, and expiry. The HMAC secret (`LOCAL_FILE_SECRET` in `tokens.ts`) is a **per-process random value** — the token-minting mock and the validating dev file-server share the same in-process module instance, so tokens are unforgeable without being a hardcoded, source-visible literal.
- Downloads are served with `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment`. The stored body and its `Content-Type` are caller-controlled, so serving them inline would make the dev file-server a stored-XSS vector (an uploaded `text/html`/SVG payload executing in the app origin). Forcing a download + disabling MIME sniffing keeps local dev no weaker than S3-behind-CloudFront.
- `scan()` recursively walks only the `content/` root and yields every file it finds — no marker-based filtering — so user keys are unrestricted.
- The dev file-server's PUT handler delegates to the registered `FileBucket` instance (via a process-global registry) so uploads get versioning, key validation, and metadata. There is no direct-write fallback; an unregistered bucket fails loud with a 500.
- Key length validated against S3's 1,024-byte limit (warns, does not reject).
- Versioning fully supported: each `put` writes to `versions/{key}/v{n}`, delete without `versionId` places a `__deleted__` sentinel, `listVersions` reads the versions directory, `restoreVersion` copies an old version via `put`.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No lifecycle rules | Objects never expire or transition locally | No mitigation — lifecycle rules are a background S3 process |
| No CORS enforcement | Browser requests succeed regardless of origin locally | No mitigation — CORS is enforced by the browser + S3, not the mock |
| No storage classes | Transition rules have no effect locally | No mitigation — storage classes are a cost optimization |
| No multipart upload | Large files use simple write locally | No mitigation — mock uses `fs.writeFile` regardless of size |
| Presigned URLs are localhost-only | URLs only work against the local dev server | No mitigation — expected behavior for local development |
| No IAM enforcement | Permission errors only surface in AWS | No mitigation — IAM is handled by CDK grants automatically |
| Filesystem path limits | Some OS path length limits differ from S3 key limits (1,024 bytes) | Mock validates key length and warns when it exceeds 1,024 bytes |
| Path-traversal keys rejected locally | The mock maps keys onto the real filesystem, so it rejects keys that escape the bucket's content root (e.g. `../escape.txt`). S3 has no filesystem and treats `..` as a literal key segment, so it accepts such keys. A pathological key containing `..` that "works" on S3 will throw `ValidationFailed` locally. | Intentional — the guard prevents a local key from clobbering files outside `.bb-data`. Avoid `..` segments in keys (also S3 best practice). Covered by `src/path-containment.test.ts`. |
| Non-atomic `put()` | On a versioned bucket, `put()` performs several separate `writeFileSync` calls (version body, version metadata, current body, current metadata, delete-marker cleanup). A crash or process kill mid-`put()` can leave torn state — a body with no metadata sidecar, or a version body with no `.json`. Real S3 `PutObject` is atomic per object. | No mitigation today — the filesystem layout has no transaction boundary. Acceptable for a dev mock (re-running `put()` heals it). See Open Question 4 (storage engine). |
| Monotonic version IDs | Mock uses `v1`, `v2`, ... vs S3's opaque IDs | No impact — customer code should treat version IDs as opaque strings |
| Content-Type signed into presigned PUT URLs | When `putUrl`/`createUploadHandle` are given a `contentType`, the AWS SDK signs `content-type` as a required header, so real S3 returns `403 SignatureDoesNotMatch` if the uploaded request's `Content-Type` differs from (or omits) the signed value. The dev file-server enforces the same check (`src/file-server.ts`) so an upload that would fail in prod also fails locally with 403, rather than silently succeeding. Uploads via `createUploadHandle().upload()` always send the signed header, so the typed-handle path round-trips in both environments. Covered by `src/file-server.test.ts`. |
| Adjacent slashes in keys collapsed | The mock maps keys onto the filesystem via `path.join`, which collapses `//` to `/` (e.g. a key built from a URL-shaped value like `uploads/https://issuer:sub/f.txt`). A later `scan({ prefix })` whose prefix still contains `//` won't match the stored single-slash path, so the file appears "missing" locally. S3 treats keys as opaque byte strings and preserves `//`, so the same prefix matches in production. | Avoid embedding raw URL-shaped values (e.g. an OIDC `userId` of `${iss}:${sub}`) directly in keys — `encodeURIComponent()` the segment first. See the FileBucket README best-practices note. |
