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
| `versioned` | `boolean` | Enable S3 object versioning. Default: `false`. |
| `corsRules` | `CorsRule[]` | CORS rules for browser-based access. |
| `lifecycleRules` | `LifecycleRule[]` | Lifecycle rules for automatic expiration or storage class transitions. |
| `bucket` | `ExternalBucketRef` | Wrap an existing S3 bucket instead of creating one. |
| `logger` | `ChildLogger` | Optional logger for internal operations. When omitted, a default error-level logger is created. |
| `removalPolicy` | `'destroy' \| 'retain'` | CDK removal behavior for the underlying S3 bucket. When omitted, CDK's default (RETAIN) applies; pass `'destroy'` for sandbox / ephemeral stacks. Ignored by the mock and browser runtimes. |

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

```typescript
import { isBlocksError } from '@aws-blocks/core';
import { FileBucketErrors } from '@aws-blocks/bb-file-bucket';

try {
  await bucket.restoreVersion('report.pdf', 'non-existent-version');
} catch (e: unknown) {
  if (isBlocksError(e, FileBucketErrors.FileNotFound)) {
    // source version does not exist
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

### Versioned Bucket

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

## Best Practices

- Use path prefixes to organize files (e.g., `uploads/{userId}/`, `reports/`). If a segment can contain URL-shaped or special characters (e.g. an OIDC `userId` of `${iss}:${sub}` like `https://issuer:sub`), wrap it in `encodeURIComponent()` first — the local mock normalizes `//` in keys via the filesystem, so an un-encoded `//` makes `scan({ prefix })` miss the file locally even though it works against S3.
- Set `contentType` on `put()` to ensure correct MIME handling on download
- Use presigned URLs (`getUrl` / `putUrl`) for direct browser upload/download
- Prefer `scan({ prefix })` over unscoped `scan()` to limit enumeration cost
- For browser uploads/downloads returned from API methods, prefer `createUploadHandle`/`getFileHandle` over raw presigned URLs — they encode the fetch protocol into typed methods so the client can't misuse them
- Use `deleteBatch()` instead of looping `delete()` for bulk operations

## Scaling & Cost (AWS)

- **Billing:** Per-request plus storage — no provisioned throughput
- **Latency:** First-byte latency typically 100–200 ms
- **Throughput:** Scales automatically, 5,500 GET and 3,500 PUT requests/second per prefix
- **Object size limit:** 5 TB per object
- **Cost:** ~$0.005 per 1,000 PUT requests, ~$0.0004 per 1,000 GET requests, ~$0.023/GB/month storage
- **Durability:** 99.999999999% (11 nines) across 3+ AZs

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Internal data is segregated into sibling roots so it never collides with your keys: file bodies live under `content/`, metadata under `meta/`, and version history under `versions/`. Wipe with `rm -rf .bb-data`. Presigned URLs are served by the dev server at `/.bb-file-bucket/{fullId}/{path}?token=...`. Versioning is fully supported locally. Lifecycle rules and CORS have no effect locally.



