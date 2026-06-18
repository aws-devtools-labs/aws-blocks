# FileBucket — Design

Design document for FileBucket. For usage, see [README.md](./README.md).

**Package:** `@aws-blocks/bb-file-bucket`
**Type:** Primitive (new infrastructure)
**AWS Service:** Amazon S3

## API Surface

```typescript
class FileBucket extends Scope {
	constructor(scope: ScopeParent, id: string, options?: FileBucketOptions);
	put(path: string, body: Buffer | string, options?: PutOptions): Promise<void>;
	get(path: string, options?: VersionedGetOptions): Promise<FileContent | null>;
	delete(path: string, options?: VersionedDeleteOptions): Promise<void>;
	deleteBatch(paths: string[]): Promise<void>;
	getUrl(path: string, options?: VersionedGetUrlOptions): Promise<string>;
	putUrl(path: string, options?: PutUrlOptions): Promise<string>;
	getFileHandle(path: string, options?: VersionedGetUrlOptions): Promise<FileDownloadClient>;
	createUploadHandle(path: string, options?: PutUrlOptions): Promise<FileUploadClient>;
	scan(options?: ScanOptions): AsyncIterable<FileInfo>;
	listVersions(path: string): Promise<FileVersionInfo[]>;
	restoreVersion(path: string, versionId: string): Promise<void>;
	static fromExisting(bucketName: string): ExternalBucketRef;
}

interface FileBucketOptions {
	versioned?: boolean;
	corsRules?: CorsRule[];
	lifecycleRules?: LifecycleRule[];
	bucket?: ExternalBucketRef;
	/** Optional logger for internal BB diagnostics. Defaults to error-level logging. */
	logger?: ChildLogger;
}

interface PutOptions {
	contentType?: string;
	metadata?: Record<string, string>;
	cacheControl?: string;
}

interface GetUrlOptions {
	expiresIn?: number;
}

interface PutUrlOptions {
	expiresIn?: number;
	contentType?: string;
}

interface ScanOptions {
	prefix?: string;
}

interface FileContent {
	body: Buffer;
	contentType: string;
	metadata: Record<string, string>;
	size: number;
}

interface FileInfo {
	path: string;
	size: number;
	lastModified: Date;
}

interface CorsRule {
	allowedOrigins: string[];
	allowedMethods: ('GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD')[];
	allowedHeaders?: string[];
	exposedHeaders?: string[];
	maxAge?: number;
}

interface LifecycleRule {
	prefix?: string;
	expirationDays?: number;
	transitionToIaDays?: number;
}

interface FileVersionInfo {
	versionId: string;
	lastModified: Date;
	size: number;
	isCurrent: boolean;
}

interface VersionedGetOptions {
	versionId?: string;
}

interface VersionedDeleteOptions {
	versionId?: string;
}

interface VersionedGetUrlOptions {
	expiresIn?: number;
	versionId?: string;
}
```

## Error Constants

```typescript
export const FileBucketErrors = {
	FileNotFound: 'NoSuchKey',
	FileTooLarge: 'EntityTooLarge',
} as const;
```

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

## Infrastructure (CDK)

Creates a single S3 bucket:

- **Bucket name:** Derived from `scope.fullId` (the bucket id joined to its parent scope ids with `-`). Validated at synth against S3's naming rules — see D-FB-6.
- **Block public access:** All four settings enabled (BLOCK_ALL)
- **Encryption:** S3-managed keys (SSE-S3)
- **Versioning:** Disabled by default, enabled via `options.versioned`
- **CORS:** Configured from `options.corsRules` if provided
- **Lifecycle rules:** Configured from `options.lifecycleRules` if provided
- **Removal policy:** DESTROY (sandbox), configurable for production
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
- Presigned URLs are served by the dev file-server at `/.bb-file-bucket/{scope.fullId}/{path}?token=...`. The path segments are URL-encoded; the server decodes them and validates an HMAC token scoped to method, path, and expiry.
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
