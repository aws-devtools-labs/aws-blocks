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

**D-FB-7: Mock versioning uses filesystem directories**
**Decision:** Versioned mock stores each version in `versions/{key}/v{n}` with monotonic IDs. Delete markers are `versions/{key}/__deleted__` sentinel files.
**Rationale:** Simple, inspectable, and matches the S3 semantics closely enough for local development. Monotonic IDs (`v1`, `v2`, ...) are deterministic and easy to reason about in tests, unlike S3's opaque version IDs. Version history lives under the segregated `versions/` root (see D-FB-2), so it never appears in `scan()` or collides with a user key.

**D-FB-8: Bucket name validated at synth — error, never truncate/hash**
**Decision:** The derived bucket name (`scope.fullId`) is validated against S3's naming rules (`bucket-name.ts`) before the bucket is constructed. An invalid name throws a `ValidationFailed` error with an actionable message. The same validator runs in the mock constructor so local dev (`bb dev`) fails identically — parity. `FileBucket.fromExisting(...)` skips validation since the name is externally owned.
**Rationale:** S3 bucket names are globally unique and immutable. Truncating to fit 63 chars risks collisions, and a name that shifts between deploys (e.g. after a hash input changes) would orphan or replace the customer's data — a far worse outcome than a fast, fixable synth error. Erroring puts the fix in the developer's hands (shorten a scope id once; the name is then stable forever) and matches the manual-shortening pattern already used in `bb-agent`. This deliberately differs from DynamoDB-backed BBs (KVStore/DistributedTable) which `substring(0, 255)` — DynamoDB's 255 limit is generous and table names are internal, disposable, and not globally unique, so silent truncation is acceptable there.

**D-FB-9: Versioning stays opt-in (default off)**
**Decision:** `versioned` remains `false` by default despite the security-review recovery finding (R6/R8). Versioning is enabled explicitly via `options.versioned: true`; the recommended recovery posture is to enable it alongside a noncurrent-version lifecycle rule.
**Rationale:** Flipping the default to `true` is behavior- and cost-changing (every overwrite is retained → ongoing storage cost) and it changes mock runtime behavior (the versioned put/get/delete/delete-marker path activates). It also creates a type/runtime mismatch: the version-aware option types (`GetOptionsFor`/`DeleteOptionsFor`/`GetUrlOptionsFor` in `types.ts`) key off the `O extends { versioned: true }` literal, so a caller who omits the flag would get non-versioned option types while the bucket is versioned at runtime — a silent disagreement. Per the framework's minimal-breaking-change stance, we keep the safe, cheap default and close the finding through documentation and the one-line opt-in rather than a default flip. If the security posture later requires versioning-on-by-default, it should ship as its own minor/major with a `versioned: false` opt-out and a migration note, not bundled with the R6/R8 hardening.

**D-FB-10: `enforceSSL` always on; server access logging opt-in**
**Decision:** The bucket always sets `enforceSSL: true` (a bucket policy denying non-TLS requests). Server access logging is opt-in via `options.accessLogging`; when enabled it provisions a dedicated, private log bucket (BLOCK_ALL, SSE-S3, `enforceSSL`, `ExpireAccessLogs` lifecycle keyed off `logRetentionDays`, default 90) and points the file bucket at it under the `access-logs/` prefix. The log bucket follows the file bucket's removal/auto-delete rules rather than an unconditional DESTROY.
**Rationale:** `enforceSSL` is effectively always safe — all SDK and presigned-URL traffic is already HTTPS — so it is a zero-risk, high-value default that closes the in-transit-encryption gap; it matches the hosting/inventory buckets which already enforce it. Access logging, by contrast, provisions a second bucket per FileBucket (extra resources + storage cost + a log-delivery bucket policy), so it mirrors the established `accessLogging?: boolean` opt-in precedent in `packages/hosting/src/constructs/storage_construct.ts` rather than defaulting on. The log bucket does not use `objectOwnership: BUCKET_OWNER_PREFERRED` (that was hosting's CloudFront-ACL need); S3 *server* access logging delivers via the log-delivery group and works with default ownership.

**D-FB-11: Dev file-server CORS is hardened; no default CORS on the deployed bucket**
**Decision:** The deployed S3 bucket emits CORS *only* from user-supplied `options.corsRules` — there is no implicit/default CORS. The local dev file-server (`file-server.ts`) reflects the request `Origin` (falling back to `*`) and allows `GET, PUT, OPTIONS`, but no longer sets `Access-Control-Allow-Credentials`.
**Rationale:** A security scan flagged "wildcard CORS for PUT" against FileBucket. The only wildcard in FileBucket's own code was the localhost-only dev file-server, which paired a reflected/`*` origin with `Access-Control-Allow-Credentials: true` — the classic permissive-CORS pattern. That credentials header is unnecessary: presigned-URL auth is carried in a query-string token, not a cookie. Removing it neutralizes the finding without breaking local cross-port dev (origin reflection is retained). The deployed bucket was never the source (it emits no default CORS), so no construct-level change is needed; users are instead directed to pass explicit-origin `corsRules` (never `['*']` with a mutating method) for production browser uploads.

## Infrastructure (CDK)

Creates a single S3 bucket:

- **Bucket name:** Derived from `scope.fullId` (the bucket id joined to its parent scope ids with `-`). Validated at synth against S3's naming rules — see D-FB-6.
- **Block public access:** All four settings enabled (BLOCK_ALL)
- **Encryption:** S3-managed keys (SSE-S3)
- **Transport encryption:** `enforceSSL: true` always — a bucket policy denies any request where `aws:SecureTransport` is false (see D-FB-10)
- **Versioning:** Disabled by default, enabled via `options.versioned` (see D-FB-9)
- **Server access logging:** Off by default; opt in with `options.accessLogging`, which provisions a dedicated private log bucket (BLOCK_ALL, SSE-S3, `enforceSSL`, log expiry) and wires the file bucket's `serverAccessLogsBucket`/`serverAccessLogsPrefix` (`access-logs/`). Retention is `options.logRetentionDays` (default 90). See D-FB-10
- **CORS:** Configured from `options.corsRules` if provided — no default CORS is emitted (see D-FB-11)
- **Lifecycle rules:** Configured from `options.lifecycleRules` if provided
- **Removal policy:** DESTROY (sandbox), configurable for production
- **Auto-delete objects:** Enabled when removal policy is DESTROY (the log bucket follows the same rule)
- **Permissions:** `grantReadWrite` to the parent scope's handler automatically

## Mock Implementation

- Files stored on the local filesystem at `.bb-data/{scope.fullId}/` via `getMockDataDir()` from core.
- Internal data is segregated into sibling roots so it can never collide with user keys (see D-FB-2):
  - `content/{key}` — file body, byte-identical to what was written.
  - `meta/{key}.json` — sidecar metadata.
  - `versions/{key}/{versionId}` (+ `.json` sidecars, `__deleted__` marker) — version history.
- Path mapping for both the mock and the dev file-server is centralized in `paths.ts` so they stay in lockstep.
- Data persists across dev server restarts. Customers can wipe with `rm -rf .bb-data`.
- Presigned URLs are served by the dev file-server at `/.bb-file-bucket/{scope.fullId}/{path}?token=...`. The path segments are URL-encoded; the server decodes them and validates an HMAC token scoped to method, path, and expiry.
- `scan()` recursively walks only the `content/` root and yields every file it finds — no marker-based filtering — so user keys are unrestricted.
- The dev file-server's PUT handler delegates to the registered `FileBucket` instance (via a process-global registry) so uploads get versioning, key validation, and metadata. There is no direct-write fallback; an unregistered bucket fails loud with a 500.
- Key length validated against S3's 1,024-byte limit (warns, does not reject).
- Versioning fully supported: each `put` writes to `versions/{key}/v{n}`, delete without `versionId` places a `__deleted__` sentinel, `listVersions` reads the versions directory, `restoreVersion` copies an old version via `put`.

### Mock vs AWS Behavior Differences

| Behavior Difference | Impact | Mitigation |
|------------|--------|------------|
| No lifecycle rules | Objects never expire or transition locally | No mitigation — lifecycle rules are a background S3 process |
| No CORS enforcement | Browser requests succeed regardless of origin locally | No mitigation — CORS is enforced by the browser + S3, not the mock. The dev file-server sets permissive dev-only CORS headers (no credentials) so local uploads/downloads work across ports |
| No server access logs | `accessLogging` provisions no log bucket locally; no access logs are written | No mitigation — server access logging is an S3-side feature. Infra-only option, ignored by the mock |
| No transport enforcement | `enforceSSL` has no effect locally (the dev file-server is plain HTTP on localhost) | No mitigation — TLS enforcement is an S3 bucket policy. Infra-only, ignored by the mock |
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
