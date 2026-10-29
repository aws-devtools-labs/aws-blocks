# FileBucket

File storage backed by Amazon S3.

**When to use:** You need to store, retrieve, or serve binary files — user uploads, generated reports, images, videos, or static assets.

**When NOT to use:** If you need structured key-value data with conditional writes, use `KVStore`. If you need queryable records with indexes, use `DistributedTable`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

## API

```typescript
const bucket = new FileBucket(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `put(path, body, options?)` | `Promise<void>` | Upload a file. Overwrites any existing file at the path. |
| `get(path, options?)` | `Promise<FileContent \| null>` | Download a file. Returns `null` if absent. Pass `{ versionId }` on versioned buckets. |
| `delete(path, options?)` | `Promise<void>` | Delete a file. No-op if absent. Pass `{ versionId }` on versioned buckets to permanently delete a version. |
| `deleteBatch(paths)` | `Promise<void>` | Delete multiple files. Chunks internally at 1,000 keys. |
| `getUrl(path, options?)` | `Promise<string>` | Generate a presigned download URL. Accepts `versionId` on versioned buckets. |
| `putUrl(path, options?)` | `Promise<string>` | Generate a presigned upload URL. |
| `getFileHandle(path, options?)` | `Promise<FileDownloadClient>` | Get a download handle for browser-side use. Accepts `versionId` on versioned buckets. |
| `createUploadHandle(path, options?)` | `Promise<FileUploadClient>` | Get an upload handle for browser-side use. |
| `scan(options?)` | `AsyncIterable<FileInfo>` | List files. Use `prefix` to scope. |
| `listVersions(path)` | `Promise<FileVersionInfo[]>` | List all versions of a file (versioned buckets only). Newest first. |
| `restoreVersion(path, versionId)` | `Promise<void>` | Restore a previous version as the current version. |
| `FileBucket.fromExisting(bucketName)` | `ExternalBucketRef` | Wrap a pre-existing S3 bucket. |

### Options

| Option | Type | Description |
|--------|------|-------------|
| `versioned` | `boolean` | Enable S3 object versioning. **Default: `true`.** Pass `versioned: false` to opt out. Note: the version-aware method typings (`versionId` on `get`/`delete`/`getUrl`/`getFileHandle`) are selected only by the literal `versioned: false`; a non-literal `boolean` or an absent value resolves to the versioned-aware typings. |
| `noncurrentVersionExpirationDays` | `number` | Days after which **noncurrent** (superseded) object versions are permanently expired, bounding the storage cost that versioning would otherwise let grow unbounded. Only applies when versioning is enabled (the default). **Default: `90`.** Must be a positive integer — a non-positive or non-integer value throws at synth. There is no disable sentinel; to drop the rule entirely, disable versioning (`versioned: false`). Ignored by the mock and browser runtimes. |
| `corsRules` | `CorsRule[]` | CORS rules for browser-based access. **Default: none — browsers block every cross-origin `fetch()` to the deployed bucket.** Required whenever browser code fetches a presigned URL directly (`download()` / `upload()` on a file handle, or `fetch()` on a `getUrl()` / `putUrl()` URL) against a deployed sandbox or production stack. Not inherited from the stack's `defaults.allowedOrigins` or the Hosting domain. Ignored when `bucket` wraps an existing bucket. See [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors), and [CorsRule](#corsrule) for the wildcard-origin synth guard. |
| `lifecycleRules` | `LifecycleRule[]` | Lifecycle rules for automatic expiration or storage class transitions. |
| `accessLogging` | `boolean` | Enable S3 server access logging. **Default: falls back to the stack posture (`BlocksDefaults.storageAccessLogging`, then `BlocksDefaults.accessLogging`)** when omitted — so a stack can opt every FileBucket into logging without a per-block flag. When enabled, a dedicated, locked-down log bucket is provisioned (all public access blocked, S3-managed encryption, SSL enforced) and the main bucket delivers its access logs there under the `access-logs/` prefix. Access logs expire automatically after the stack posture's `logRetention` (`ONE_WEEK` in sandbox / `ONE_YEAR` in production; `RetentionDays.INFINITE` keeps them indefinitely). Ignored by the mock and browser runtimes. |
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | Server-side encryption at rest. **Default: `'aws-managed'` (SSE-S3).** `'customer-managed'` creates a dedicated KMS key for this bucket (rotation on, removed with the bucket); `FileBucket.fromKmsKey(arn)` uses a key you already own. Both use SSE-KMS with S3 Bucket Keys. See [Encryption with KMS](#encryption-with-kms). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Ignored by the mock and browser runtimes. |
| `objectLock` | `{ mode: 'governance' \| 'compliance'; retentionDays: number }` | Enable S3 Object Lock with a default retention for every new object version. **Default: off.** Requires versioning and a retained bucket (`removalPolicy: 'retain'` in a sandbox); both are checked at synth. Can only be set when the bucket is first created. Presigned uploads (`putUrl`, `createUploadHandle`) are not supported on these buckets — upload with `put()`. See [Object Lock](#object-lock). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Validated, but not enforced, by the mock. |
| `bucket` | `ExternalBucketRef` | Wrap an existing S3 bucket instead of creating one. |
| `logger` | `ChildLogger` | Optional logger for internal operations. When omitted, a default error-level logger is created. |
| `removalPolicy` | `'destroy' \| 'retain'` | CDK removal behavior for the underlying S3 bucket. When omitted, it falls back to the stack posture default (`BlocksDefaults.removalPolicy` — `DESTROY` in sandbox, `RETAIN` in production); pass `'destroy'` or `'retain'` to set it explicitly per-block. `'destroy'` also enables `autoDeleteObjects` so the bucket can be emptied on teardown. Ignored by the mock and browser runtimes. |

All FileBucket-provisioned buckets **enforce TLS unconditionally** (`enforceSSL: true`) — CDK attaches a bucket policy denying any request where `aws:SecureTransport` is `false`, closing the in-transit exposure gap. This is not configurable.

The S3 bucket name is derived from the scope chain: the FileBucket id joined to its parent scope ids with `-`. If that name fits S3's 63-character limit, it is used as-is. If it is longer, it is shortened to the start of the name plus `-` and an 8-character hash. The shortened name is the same on every deploy and different from the names of other buckets. A name that breaks any other S3 naming rule (for example, one with uppercase letters) still fails `cdk synth` with a `ValidationFailed` error. To read the resolved name, call `getSdkIdentifiers(bucket).bucketName` (from `@aws-blocks/blocks`).

### PutOptions

| Option | Type | Description |
|--------|------|-------------|
| `contentType` | `string` | MIME type (e.g., `image/png`). Default: `application/octet-stream`. |
| `metadata` | `Record<string, string>` | Custom metadata key-value pairs. |
| `cacheControl` | `string` | Cache-Control header value. |

### CorsRule

CORS configuration for browser-based access. Supplied via the `corsRules` option.

| Field | Type | Description |
|-------|------|-------------|
| `allowedOrigins` | `string[]` | Origins permitted to make cross-origin requests (e.g., `['https://app.example.com']`). |
| `allowedMethods` | `('GET' \| 'PUT' \| 'POST' \| 'DELETE' \| 'HEAD')[]` | HTTP methods permitted for cross-origin requests. |
| `allowedHeaders` | `string[]` | Optional. Request headers permitted in the actual request. |
| `exposedHeaders` | `string[]` | Optional. Response headers exposed to the browser. |
| `maxAge` | `number` | Optional. Seconds the browser may cache the preflight response. |

> **Wildcard origins and mutating methods:** a CORS rule that combines a wildcard origin (`'*'`) with a mutating method (`PUT`, `POST`, or `DELETE`) **throws at synth** — it would let any site issue state-changing cross-origin requests. Specify explicit origins (e.g. `['https://app.example.com']`) for mutating methods. A wildcard origin with only safe methods (`GET`/`HEAD`) is allowed.

### LifecycleRule

Lifecycle configuration for automatic expiration or storage-class transitions. Supplied via the `lifecycleRules` option.

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | Optional. Prefix filter — the rule applies only to keys starting with this prefix. Omit to apply to all objects. |
| `expirationDays` | `number` | Optional. Days after creation to expire (delete) objects. |
| `transitionToIaDays` | `number` | Optional. Days after creation to transition objects to Infrequent Access storage. |

### FileVersionInfo

Returned by `listVersions()` — one entry per object version, newest first.

| Field | Type | Description |
|-------|------|-------------|
| `versionId` | `string` | The version identifier. |
| `lastModified` | `Date` | When this version was created. |
| `size` | `number` | Size in bytes. |
| `isCurrent` | `boolean` | Whether this is the current (latest) version. |

### Error Handling

`get()` returns `null` for a missing file — it does **not** throw `FileNotFound`. Check for null:

```typescript
const file = await bucket.get('missing.txt');
if (!file) {
  // file does not exist
}
```

`FileBucketErrors` are thrown by other operations and matched with `isBlocksError`:

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `FileBucketErrors.FileNotFound` | `NoSuchKey` | Surfaced by presigned-URL 404s etc. **Not** thrown by `get()`, which returns `null`. |
| `FileBucketErrors.FileTooLarge` | `EntityTooLarge` | File exceeds size limits. |
| `FileBucketErrors.VersionNotFound` | `NoSuchVersion` | Thrown by `restoreVersion()` when the target `versionId` cannot be resolved. |
| `FileBucketErrors.PresignedUploadUnsupported` | `PresignedUploadUnsupported` | Thrown by `putUrl()` and `createUploadHandle()` on a bucket with `objectLock` — see [Object Lock](#object-lock). |

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { FileBucketErrors } from '@aws-blocks/bb-file-bucket';

try {
  await bucket.restoreVersion('report.pdf', 'non-existent-version');
} catch (e: unknown) {
  if (isBlocksError(e, FileBucketErrors.VersionNotFound)) {
    // that version does not exist
  }
  throw e;
}
```

## Examples

### Basic Put/Get

```typescript
const bucket = new FileBucket(scope, 'uploads');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async uploadFile(name: string, content: string) {
    await bucket.put(name, content, { contentType: 'text/plain' });
  },
  async getFile(name: string) {
    const file = await bucket.get(name);
    if (!file) return null;
    return { contentType: file.contentType, size: file.size };
  },
}));
```

### Presigned Upload URL

```typescript
const bucket = new FileBucket(scope, 'media');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getUploadUrl(path: string) {
    const url = await bucket.putUrl(path, {
      expiresIn: 600,
      contentType: 'image/jpeg',
    });
    return { uploadUrl: url };
  },
}));
```

### Browser Uploads and Downloads (CORS)

Presigned URLs and file handles are fetched by the browser **directly from S3**, which is a different origin from your frontend. The deployed bucket must therefore allow your frontend's origin through `corsRules`. FileBucket configures **no CORS by default**, and — unlike the API endpoint — it does **not** pick up the stack's `defaults.allowedOrigins` or the Hosting domain. Without a matching rule, every browser upload or download against a deployed sandbox or production stack fails with:

```text
Access to fetch at 'https://<bucket>.s3.<region>.amazonaws.com/...' from origin 'http://localhost:3000'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

For `upload()` / `PUT`, the browser fails at the preflight instead, and the message continues with `Response to preflight request doesn't pass access control check:` before the same text.

`npm run dev` does not surface this: the local dev file-server accepts any origin, so the error first appears after you deploy.

List every origin your frontend is served from — the local dev frontend (`http://localhost:3000`, when it talks to a deployed sandbox) and your deployed app's origin. With Hosting, that is the stack's `HostingUrl` output: your custom domain if you configured one, otherwise the generated `https://<id>.cloudfront.net` domain, which only exists after the first deploy (deploy once, copy `HostingUrl` into `corsRules`, then redeploy):

```typescript
const bucket = new FileBucket(scope, 'uploads', {
  corsRules: [{
    allowedOrigins: ['http://localhost:3000', 'https://app.example.com'],
    allowedMethods: ['GET', 'PUT'],
    allowedHeaders: ['Content-Type'],
  }],
});
```

`aws-blocks/index.ts` is shared by sandbox and production deploys, so this rule also allows `http://localhost:3000` on the production bucket. Only a sandbox needs it; leaving it in production is low-risk because presigned URLs authenticate through their query-string signature, not ambient browser credentials.

- `GET` covers `download()` and `fetch()` on a `getUrl()` URL; `PUT` covers `upload()` and a `putUrl()` URL.
- `allowedHeaders` must list every header the browser sends. A cross-origin `PUT` always triggers a CORS preflight, and S3 rejects the preflight if a request header — such as the `Content-Type` that `upload()` sends — is not allowed.
- `allowedOrigins` entries are S3 origin strings (scheme + host + port, no trailing slash), optionally with a single `*` wildcard such as `https://*.example.com` — not the regex patterns used by `defaults.allowedOrigins`.
- Use exact origins for `PUT`, `POST`, and `DELETE`. A bare `'*'` origin with a mutating method throws at synth (see [CorsRule](#corsrule)); a partial wildcard such as `https://*` is not caught, so avoid it for mutating methods.
- Plain navigations to a `getUrl()` URL (`<img src>`, `<a href>`) are not CORS requests and work without a rule; `fetch()`, `download()`, and `upload()` do need one.
- `exposedHeaders` (for example `ETag` or `x-amz-version-id`) is only needed when custom `fetch()` code reads response headers; the built-in handles don't. Every `PUT` preflights, so a `maxAge` (for example `3000`) saves a round trip per upload.
- CORS is bucket configuration: redeploy after changing `corsRules`.
- `corsRules` is ignored when `bucket` wraps an existing bucket (see [Wrapping an Existing Bucket](#wrapping-an-existing-bucket)) — configure CORS on that bucket itself.

### Listing Files with Scan

```typescript
const bucket = new FileBucket(scope, 'reports');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listReports(yearMonth: string) {
    const files: FileInfo[] = [];
    for await (const file of bucket.scan({ prefix: `reports/${yearMonth}/` })) {
      files.push(file);
    }
    return files;
  },
}));
```

### Batch Delete

```typescript
const bucket = new FileBucket(scope, 'tmp');

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async cleanupTemp(paths: string[]) {
    await bucket.deleteBatch(paths);
  },
}));
```

### Wrapping an Existing Bucket

```typescript
const bucket = new FileBucket(scope, 'legacy', {
  bucket: FileBucket.fromExisting('my-existing-bucket'),
});
```

> **A wrapped bucket does not receive FileBucket's secure defaults.** When you supply `bucket`, FileBucket binds to the existing bucket as-is and returns early — none of the secure defaults it normally applies are applied: not `enforceSSL`, versioning / noncurrent-version expiration, server access logging, `blockPublicAccess`, encryption, nor `corsRules` or the wildcard-CORS guard. You own that bucket's security posture; configure these on the bucket itself (or via its own CDK construct) before wrapping it.

### Versioned Bucket

Versioning is **on by default**, so the version-aware methods (`listVersions`, `restoreVersion`, and optional `versionId` on `get`/`delete`/`getUrl`/`getFileHandle`) are available without any option. Pass `versioned: false` to opt out (which also removes the `versionId` option typings). The example below passes `versioned: true` explicitly for clarity:

```typescript
const bucket = new FileBucket(scope, 'docs', { versioned: true });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async upload(name: string, content: string) {
    await bucket.put(name, content);
  },
  async getVersion(name: string, versionId?: string) {
    return await bucket.get(name, versionId ? { versionId } : undefined);
  },
  async listVersions(name: string) {
    return await bucket.listVersions(name);
  },
  async restore(name: string, versionId: string) {
    await bucket.restoreVersion(name, versionId);
  },
}));
```

### Access Logging

Opt in to S3 server access logging. A dedicated, locked-down log bucket is provisioned and access logs expire automatically after the stack posture's `logRetention` (`ONE_WEEK` in sandbox, `ONE_YEAR` in production):

```typescript
// Logs delivered to a separate locked-down bucket.
// Retention follows the stack posture's logRetention default — not a per-block option.
const bucket = new FileBucket(scope, 'uploads', {
  accessLogging: true,
});
```

To turn S3 access logging on for every FileBucket without enabling API Gateway access logging, set `storageAccessLogging` on the stack defaults:

```typescript
await BlocksStack.create(app, stackName, {
  // ...
  defaults: { ...BlocksPresets.production, storageAccessLogging: true },
});
```

### Encryption with KMS

Objects are encrypted with S3-managed keys (SSE-S3) by default. To control the key yourself, use a customer-managed KMS key:

```typescript
// A dedicated key for this bucket (yearly rotation, removed with the bucket).
const invoices = new FileBucket(scope, 'invoices', { encryption: 'customer-managed' });

// Or share a key you already own across buckets and tables.
const key = FileBucket.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
const exports = new FileBucket(scope, 'exports', { encryption: key });
```

The runtime role is granted `kms:Decrypt` / `kms:GenerateDataKey*` on the key, so `put`/`get` and presigned URLs keep working. For a key you bring yourself, its key policy must delegate to IAM in the account (the default key policy does). KMS adds a monthly key charge; S3 Bucket Keys keep per-request KMS charges low.

### Object Lock

Protect files from being overwritten or permanently deleted for a fixed period (write-once-read-many):

```typescript
const auditLog = new FileBucket(scope, 'audit-log', {
  objectLock: { mode: 'governance', retentionDays: 365 },
});
```

Every new version is locked for `retentionDays`. `delete(path)` still hides the file (S3 adds a delete marker), but permanently deleting a locked version with `delete(path, { versionId })` fails until the lock expires. In `'compliance'` mode nobody, including the account root user, can remove a locked version early; `'governance'` mode allows principals with `s3:BypassGovernanceRetention` to do so.

**Upload through the backend.** S3 requires a signed `Content-MD5` or checksum header on every upload to an Object Lock bucket. A presigned URL is created before the file is known, so it can't carry one, and S3 rejects the upload. On these buckets `putUrl()` and `createUploadHandle()` throw `FileBucketErrors.PresignedUploadUnsupported` (locally and on AWS) rather than return a URL that fails. `put()` works, because the SDK adds the checksum. Downloads (`getUrl()`, `getFileHandle()`) are unaffected.

Object Lock can only be turned on when the bucket is first deployed, and can't be turned off. Locked objects also block teardown, so the bucket must be retained — pass `removalPolicy: 'retain'` when using Object Lock in a sandbox.

## Best Practices

- Use path prefixes to organize files (e.g., `uploads/{userId}/`, `reports/`). If a segment can contain URL-shaped or special characters (e.g. an OIDC `userId` of `${iss}:${sub}` like `https://issuer:sub`), wrap it in `encodeURIComponent()` first — an un-encoded `//` is an empty path segment, which FileBucket rejects (`ValidationFailed`) on both the local mock and AWS so a key can't mean one object locally and another in production.
- Set `contentType` on `put()` to ensure correct MIME handling on download
- Use presigned URLs (`getUrl` / `putUrl`) for direct browser upload/download — and set `corsRules` for your frontend's origins, or the browser blocks them once deployed (see [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors))
- Prefer `scan({ prefix })` over unscoped `scan()` to limit enumeration cost
- For browser uploads/downloads returned from API methods, prefer `createUploadHandle`/`getFileHandle` over raw presigned URLs — they encode the fetch protocol into typed methods so the client can't misuse them
- Use `deleteBatch()` instead of looping `delete()` for bulk operations
- Versioning is **on by default**; noncurrent (superseded) versions are automatically expired after **90 days** (`noncurrentVersionExpirationDays`, default `90`) so version history doesn't grow storage cost unbounded. Tune the window per-block, or disable versioning (`versioned: false`) to drop the expiration rule along with versioning.

## Scaling & Cost (AWS)

- **Billing:** Per-request plus storage — no provisioned throughput
- **Latency:** First-byte latency typically 100–200 ms
- **Throughput:** Scales automatically, 5,500 GET and 3,500 PUT requests/second per prefix
- **Object size limit:** 5 TB per object
- **Cost:** ~$0.005 per 1,000 PUT requests, ~$0.0004 per 1,000 GET requests, ~$0.023/GB/month storage
- **Durability:** 99.999999999% (11 nines) across 3+ AZs

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Internal data is segregated into sibling roots so it never collides with your keys: file bodies live under `content/`, metadata under `meta/`, and version history under `versions/`. Wipe with `rm -rf .bb-data`. Presigned URLs are served by the dev server at `/.bb-file-bucket/{fullId}/{path}?token=...`. Versioning is fully supported locally. Lifecycle rules and `corsRules` have no effect locally — the dev file-server accepts browser requests from any origin, so a missing or wrong `corsRules` only shows up after deploy (see [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors)).

When a local download URL specifies a `versionId`, only that version is served. An unknown or permanently deleted version returns HTTP 404; it never falls back to the current file. URLs without `versionId` continue to select the current file.



