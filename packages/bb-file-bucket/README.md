# FileBucket

File storage backed by Amazon S3.

**When to use:** You need to store, retrieve, or serve binary files — user uploads, generated reports, images, videos, or static assets.

**When NOT to use:** If you need structured key-value data with conditional writes, use `KVStore`. If you need queryable records with indexes, use `DistributedTable`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

> Production settings (access logging, KMS encryption, Object Lock, scaling & cost): [PRODUCTION.md](./PRODUCTION.md)

## API

```typescript
const bucket = new FileBucket(scope, id, options?)
```

| Method | Returns | Description |
|--------|---------|-------------|
| `put(path, body, options?)` | `Promise<void>` | Upload a file. Overwrites any existing file at the path. |
| `get(path, options?)` | `Promise<FileContent \| null>` | Download a file. Returns `null` if absent. Pass `{ versionId }` on versioned buckets. It always reads the whole body: there is no metadata-only (HEAD) read, so `get()` is the only call that returns `contentType` and `metadata`. `scan()` returns `size` and `lastModified` without the body. |
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
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | Server-side encryption at rest. **Default: `'aws-managed'` (SSE-S3).** `'customer-managed'` creates a dedicated KMS key for this bucket (rotation on, removed with the bucket); `FileBucket.fromKmsKey(arn)` uses a key you already own. Both use SSE-KMS with S3 Bucket Keys. Any other value (e.g. a typo from untyped JavaScript or config) fails the synth with an error listing the valid values, rather than falling back to SSE-S3. See [Encryption with KMS](./PRODUCTION.md#encryption-with-kms). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Ignored by the mock and browser runtimes. |
| `objectLock` | `{ mode: 'governance' \| 'compliance'; retentionDays: number }` | Enable S3 Object Lock with a default retention for every new object version. **Default: off.** Requires versioning and a retained bucket (`removalPolicy: 'retain'` in a sandbox); both are checked at synth. Can be added to a deployed bucket, but can't be turned off once on. Presigned uploads (`putUrl`, `createUploadHandle`) are not supported on these buckets — upload with `put()`. See [Object Lock](./PRODUCTION.md#object-lock). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Validated, but not enforced, by the mock. |
| `allowedContentTypes` | `string[]` | Content types the bucket accepts on upload. **Default: any.** Entries are exact media types (`'application/pdf'`) or `type/*` wildcards (`'image/*'`), without parameters; matching ignores case and parameters. A wildcard does not match `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`, `application/xml`, `text/xsl`, `text/javascript`, `text/ecmascript`, `application/javascript`, `application/ecmascript` and `application/x-javascript`, and any subtype ending in `+xml`; list one exactly to accept it. Checked by `put()`, `putUrl()` and `createUploadHandle()` against the effective content type (`application/octet-stream` when the caller passes none — list it to accept those uploads). An unlisted type throws `ValidationFailed`. Must be a non-empty array of `type/subtype` or `type/*` strings (checked at synth). See [Upload constraints](#upload-constraints). |
| `maxUploadBytes` | `number` | Largest upload, in bytes. **Default: no limit.** When set, `putUrl()` / `createUploadHandle()` require `contentLength` and reject one above the limit, and `put()` rejects a larger body (`ValidationFailed`). Must be a positive integer (checked at synth). See [Upload constraints](#upload-constraints). |
| `bucket` | `ExternalBucketRef` | Wrap an existing S3 bucket instead of creating one. |
| `logger` | `ChildLogger` | Optional logger for internal operations. When omitted, a default error-level logger is created. |
| `removalPolicy` | `'destroy' \| 'retain'` | CDK removal behavior for the underlying S3 bucket. When omitted, it falls back to the stack posture default (`BlocksDefaults.removalPolicy` — `DESTROY` in sandbox, `RETAIN` in production); pass `'destroy'` or `'retain'` to set it explicitly per-block. `'destroy'` also enables `autoDeleteObjects` so the bucket can be emptied on teardown. Ignored by the mock and browser runtimes. |

All FileBucket-provisioned buckets **enforce TLS unconditionally** (`enforceSSL: true`) — CDK attaches a bucket policy denying any request where `aws:SecureTransport` is `false`, closing the in-transit exposure gap. This is not configurable.

The S3 bucket name is derived from the scope chain: the FileBucket id joined to its parent scope ids with `-`. If that name fits S3's 63-character limit, it is used as-is. If it is longer, it is shortened to the start of the name plus `-` and an 8-character hash. The shortened name is the same on every deploy and different from the names of other buckets. A name that breaks any other S3 naming rule (for example, one with uppercase letters) still fails `cdk synth` with a `ValidationFailed` error. To read the resolved name, call `getSdkIdentifiers(bucket).bucketName` (from `@aws-blocks/blocks`).

### PutOptions

| Option | Type | Description |
|--------|------|-------------|
| `contentType` | `string` | MIME type (e.g., `image/png`). Default: `application/octet-stream`. Must be in `allowedContentTypes` when the bucket sets it. |
| `metadata` | `Record<string, string>` | Custom metadata key-value pairs, set when the object is written. It can't be edited in place: each `put()` replaces it, so a `put()` without `metadata` leaves none. See [Changing Metadata](#changing-metadata). S3 stores the keys in lowercase, so use lowercase keys. |
| `cacheControl` | `string` | Cache-Control header value. |

### Presigned URL options

`getUrl`, `putUrl`, `getFileHandle`, and `createUploadHandle` accept `expiresIn` in seconds. It must be an integer from `1` to `604800` (seven days); the default is `3600`.

`putUrl` and `createUploadHandle` also accept:

| Option | Type | Description |
|--------|------|-------------|
| `contentType` | `string` | Content type of the upload. **Default: `application/octet-stream`.** Always signed into the URL: the upload must send exactly this `Content-Type` header, or S3 rejects it with `403 SignatureDoesNotMatch`. `createUploadHandle().upload()` sends it for you, whatever the uploaded file's own type; to store a browser `File`'s type, pass `contentType: file.type`. |
| `contentLength` | `number` | Exact size of the upload in bytes. When set, it is signed into the URL and S3 only accepts a body of exactly this size (browsers set `Content-Length` from the body). Required when the bucket sets `maxUploadBytes`. |

`getUrl` and `getFileHandle` also accept:

| Option | Type | Description |
|--------|------|-------------|
| `attachment` | `boolean \| string` | Make the browser download the file instead of displaying it. **Default: off** (the file is displayed inline when the browser can render it). `true` signs `Content-Disposition: attachment` into the URL; a filename (e.g. `'report.pdf'`) also suggests that name. Control characters, directional formatting characters and zero-width characters are removed from the filename, and `/` and `\` are replaced with `_`; a filename that is empty, `.` or `..` afterwards throws `ValidationFailed`. See [Serving user uploads](#serving-user-uploads). |

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

Invalid input — a key or `scan()` prefix that breaks the [key rules](#object-keys), an out-of-range `expiresIn`, a content type or size the bucket does not accept, or an invalid `attachment` — throws an error named `ValidationFailed` (match it with `isBlocksError(e, 'ValidationFailed')`). It is an `ApiError` with status `400`, so an API method that lets it propagate answers the client with HTTP 400. Its message is fixed text and never includes the key or other input.

`FileBucketErrors` are thrown by other operations and matched with `isBlocksError`:

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| `FileBucketErrors.FileNotFound` | `NoSuchKey` | Surfaced by presigned-URL 404s etc. **Not** thrown by `get()`, which returns `null`. |
| `FileBucketErrors.FileTooLarge` | `EntityTooLarge` | File exceeds size limits. |
| `FileBucketErrors.VersionNotFound` | `NoSuchVersion` | Thrown by `restoreVersion()` when the target `versionId` cannot be resolved. |
| `FileBucketErrors.PresignedUploadUnsupported` | `PresignedUploadUnsupported` | Thrown by `putUrl()` and `createUploadHandle()` on a bucket with `objectLock` — see [Object Lock](./PRODUCTION.md#object-lock). |

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

## Access control and per-user isolation

FileBucket has no per-object permissions of its own. Every API method reads and writes the bucket with the app's shared execution role, so **any key a method accepts from the client is a key every signed-in user can reach**. Enforce ownership in the API method:

- Gate each method with your auth block (`await auth.requireAuth(context)`).
- Build keys on the server under a per-user prefix derived from the authenticated identity (`uploads/${encodeURIComponent(user.userId)}/…`). Never pass a client-supplied full key, or a client-supplied `scan()` prefix, straight to `put`, `get`, `delete`, `getUrl`, `putUrl`, `scan` or the handle methods.
- Accept only a file *name* from the client and wrap it in `encodeURIComponent()`, so it stays a single path segment and can't add `/` to reach another prefix. FileBucket rejects `.`/`..` segments and other unsafe keys with `ValidationFailed`; see [Object keys](#object-keys).
- For a resource shared between users (a document, a team folder), check that the caller may access it — for example by looking up an ownership record — before building its key.

The examples below assume an auth block such as `AuthBasic` and a helper that builds the caller's keys:

```typescript
const auth = new AuthBasic(scope, 'auth');
const bucket = new FileBucket(scope, 'uploads');

/** The caller's key for `name`, under a prefix only they can reach. */
function userKey(userId: string, name: string): string {
  return `uploads/${encodeURIComponent(userId)}/${encodeURIComponent(name)}`;
}
```

## Upload constraints

Presigned uploads always sign a `Content-Type` — the `contentType` you pass, or `application/octet-stream` when you pass none — so the uploader can't send a different one. To restrict what a bucket accepts:

```typescript
const avatars = new FileBucket(scope, 'avatars', {
  allowedContentTypes: ['image/png', 'image/jpeg', 'image/webp'],
  maxUploadBytes: 5 * 1024 * 1024, // 5 MiB
});

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getAvatarUploadSlot(contentType: string, size: number) {
    const user = await auth.requireAuth(context);
    // Throws ValidationFailed (HTTP 400) for a type that isn't listed or a size over 5 MiB.
    return avatars.createUploadHandle(`avatars/${encodeURIComponent(user.userId)}`, {
      contentType,
      contentLength: size,
      expiresIn: 300,
    });
  },
}));

// Frontend
const slot = await api.getAvatarUploadSlot(file.type, file.size);
await slot.upload(file);
```

- `allowedContentTypes` entries are exact media types or `type/*` wildcards. Matching ignores case and parameters (`text/plain; charset=utf-8` matches `text/plain`). The default `application/octet-stream` is only accepted when listed.
- A wildcard matches every subtype of its type except the types a browser can display as a page or run as a script: `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`, `application/xml`, `text/xsl`, `text/javascript`, `text/ecmascript`, `application/javascript`, `application/ecmascript` and `application/x-javascript`, and any subtype ending in `+xml` (`application/atom+xml`, …). These can run script when displayed inline (see [Serving user uploads](#serving-user-uploads)), so `image/*` does not accept `image/svg+xml` and `text/*` does not accept `text/html`. To accept one, list it exactly (`allowedContentTypes: ['image/*', 'image/svg+xml']`), and serve its downloads with `attachment`.
- A `contentType` must be a single media type — `type/subtype` with optional `; name=value` parameters, ASCII only. A comma-separated list, control characters or an empty value throws `ValidationFailed`, with or without `allowedContentTypes`.
- The content type is signed, stored and returned in canonical form: each parameter as `; name=value`, with one space after `;` and none around `=` (`text/plain;charset=utf-8` becomes `text/plain; charset=utf-8`). A quoted parameter value is written without quotes when its content is a token (`charset="utf-8"` becomes `charset=utf-8`), and otherwise stays quoted with only `"` and `\` escaped (`name="a b"` is unchanged). An upload to a `putUrl()` URL must send that canonical value; `createUploadHandle().upload()` and the native clients send it for you.
- With `maxUploadBytes`, `putUrl()` and `createUploadHandle()` require `contentLength` and sign it, so S3 only accepts a body of exactly that size. `put()` checks the body size directly.
- An upload to a URL or handle signed with `contentLength` must send exactly that many bytes with a `Content-Length` header. Browsers and `fetch` set it from the body. With the native Kotlin client, pass the same `contentLength` to `uploadFrom(source, contentLength)`: without it the stream is sent with no `Content-Length` and the upload is rejected. The native Swift `uploadFrom(fileURL:)` sends the file's size, so the file must be exactly `contentLength` bytes.
- The checks run in the API method, before a URL is signed, identically in local dev and on AWS — including for a bucket wrapped with `FileBucket.fromExisting`. The local dev server also rejects an upload whose `Content-Type` or size differs from the signed values with `403`, as S3 does.

## Serving user uploads

A presigned download URL serves the file with its stored content type, and the browser displays it inline when it can render it. **A file displayed inline can run as a page:** an uploaded HTML or SVG file executes script in the origin that serves it. For user-uploaded content, either restrict uploads to safe types with `allowedContentTypes` (for example `image/*`, which does not accept `image/svg+xml` unless you list it exactly — see [Upload constraints](#upload-constraints)), or make downloads attachments:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getDownloadLink(name: string) {
    const user = await auth.requireAuth(context);
    // Content-Disposition: attachment; filename="<name>" — the browser saves the file instead of rendering it.
    return bucket.getUrl(userKey(user.userId, name), { attachment: name, expiresIn: 300 });
  },
}));
```

Never serve uploaded files inline from your application's own origin (for example by proxying them through an API route). If they must render inline, serve them from a separate origin.

## Examples

The examples use the `auth` block, `bucket` and `userKey()` helper from [Access control and per-user isolation](#access-control-and-per-user-isolation).

### Basic Put/Get

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async uploadFile(name: string, content: string) {
    const user = await auth.requireAuth(context);
    await bucket.put(userKey(user.userId, name), content, { contentType: 'text/plain' });
  },
  async getFile(name: string) {
    const user = await auth.requireAuth(context);
    const file = await bucket.get(userKey(user.userId, name));
    if (!file) return null;
    return { contentType: file.contentType, size: file.size };
  },
}));
```

### Changing Metadata

Object metadata is fixed when the object is written: S3 can only change metadata by rewriting the object, and FileBucket doesn't expose S3's server-side copy (`CopyObject`), so there is no call that edits it. Every `put()` replaces the object's metadata with what it passes, and a `put()` without `metadata` leaves the object with none. To change metadata, `put()` the same body again with the complete new set:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async markReviewed(name: string) {
    const user = await auth.requireAuth(context);
    // Derive the key from the caller — never act on a client-supplied full key.
    const path = userKey(user.userId, name);
    const file = await bucket.get(path);
    if (!file) return null;
    await bucket.put(path, file.body, {
      contentType: file.contentType,
      metadata: { ...file.metadata, status: 'reviewed' },
    });
    return { status: 'reviewed' };
  },
}));
```

- The rewrite downloads and re-uploads the whole object, so it costs a GET and a PUT and takes longer for a large file.
- `get()` doesn't return `cacheControl`. If you set one, pass it again.
- Versioning is on by default (see [Versioned Bucket](#versioned-bucket)), so each rewrite stores another full copy of the object as a noncurrent version. It's kept, and billed, for `noncurrentVersionExpirationDays` (default 90). Until then the previous metadata stays on the previous version, and `restoreVersion()` brings it back with that version.
- The rewrite isn't atomic. Anything written to the object between the `get()` and the `put()` (a new body or other metadata) is overwritten with what was read, and FileBucket has no conditional write to guard against it. Avoid rewriting objects that other code may be updating at the same time.
- Uploads through presigned URLs (`putUrl()`, `createUploadHandle()`) carry no custom metadata. Set it afterwards with a rewrite like the one above.
- S3 stores metadata keys in lowercase, so `get()` on AWS returns `{ owner: … }` for a key written as `Owner`. The local mock keeps the case you wrote (see [Mock vs AWS Behavior Differences](./DESIGN.md#mock-vs-aws-behavior-differences)). Use lowercase keys so both return the same thing.

### Presigned Upload URL

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async getUploadUrl(name: string) {
    const user = await auth.requireAuth(context);
    const url = await bucket.putUrl(userKey(user.userId, name), {
      expiresIn: 600,
      contentType: 'image/jpeg', // signed: the upload must send `Content-Type: image/jpeg`
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
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listMyFiles() {
    const user = await auth.requireAuth(context);
    const files: FileInfo[] = [];
    // The prefix is built from the caller's identity, so the listing only covers their files.
    for await (const file of bucket.scan({ prefix: `uploads/${encodeURIComponent(user.userId)}/` })) {
      files.push(file);
    }
    return files;
  },
}));
```

A `scan()` prefix follows the [key rules](#object-keys), except that it may be empty or end with `/`.

### Batch Delete

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async deleteFiles(names: string[]) {
    const user = await auth.requireAuth(context);
    await bucket.deleteBatch(names.map(name => userKey(user.userId, name)));
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
const docs = new FileBucket(scope, 'docs', { versioned: true });

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async upload(name: string, content: string) {
    const user = await auth.requireAuth(context);
    await docs.put(userKey(user.userId, name), content);
  },
  async getVersion(name: string, versionId?: string) {
    const user = await auth.requireAuth(context);
    const file = await docs.get(userKey(user.userId, name), versionId ? { versionId } : undefined);
    return file ? { body: file.body.toString(), contentType: file.contentType } : null;
  },
  async listVersions(name: string) {
    const user = await auth.requireAuth(context);
    return await docs.listVersions(userKey(user.userId, name));
  },
  async restore(name: string, versionId: string) {
    const user = await auth.requireAuth(context);
    await docs.restoreVersion(userKey(user.userId, name), versionId);
  },
}));
```

On a versioned bucket, `delete(path)` creates a delete marker without removing
stored data versions; `get()` returns `null` and `scan()` omits the file.
`delete(path, { versionId })` permanently removes that specific data version.
On S3, deleting the current data version exposes the next entry in the version
history, which may be another data version or a delete marker.

The local mock reconciles its current body and metadata with the next stored
data version when the newest data version is permanently deleted, or removes
the current copies when none remain. This creates no replacement version and
does not remove an active delete-marker flag; `get()` and `scan()` still honor
that flag.

**Local limitation:** the mock keeps only an active delete-marker flag, not
delete markers ordered within the version history. A subsequent `put()` removes
the flag. Consequently, `put(old)` → `delete()` → `put(replacement)` → permanent
deletion of the replacement can expose `old` locally, whereas S3 would make the
earlier delete marker current and treat the key as deleted. This case is not
fixed by current-copy reconciliation. See
[Mock vs AWS Behavior Differences](./DESIGN.md#mock-vs-aws-behavior-differences)
and use a sandbox when testing deletion history across re-uploads.

## Object keys

Keys are validated identically in local dev and on AWS. A key that breaks any of these rules throws `ValidationFailed` (HTTP 400):

- not empty, and at most 1,024 bytes once UTF-8 encoded (S3's key limit);
- no leading `/`;
- no empty segment (`a//b`) or trailing `/`;
- no `.` or `..` segment, including one spelled with `%2e`, `%2f` or `%5c` in either case (`a/%2e%2e/b`, `a/..%2f../b`, `a/%2e%2e%2fb`) — other `%` sequences, such as `100%done.txt`, are allowed;
- no backslash (`\`);
- no control characters (U+0000–U+001F, U+007F–U+009F), line or paragraph separators (U+2028, U+2029), or bidirectional formatting characters (U+202A–U+202E, U+2066–U+2069).

## Best Practices

- Use path prefixes to organize files (e.g., `uploads/{userId}/`, `reports/`). If a segment can contain URL-shaped or special characters (e.g. an OIDC `userId` of `${iss}:${sub}` like `https://issuer:sub`), wrap it in `encodeURIComponent()` first — an un-encoded `//` is an empty path segment, which FileBucket rejects (`ValidationFailed`) on both the local mock and AWS so a key can't mean one object locally and another in production.
- Derive keys from the authenticated user on the server, never from a client-supplied key or prefix (see [Access control and per-user isolation](#access-control-and-per-user-isolation))
- Set `contentType` on `put()` to ensure correct MIME handling on download
- For user uploads, set `allowedContentTypes` / `maxUploadBytes`, and serve downloads with `attachment` (see [Upload constraints](#upload-constraints) and [Serving user uploads](#serving-user-uploads))
- Use presigned URLs (`getUrl` / `putUrl`) for direct browser upload/download — and set `corsRules` for your frontend's origins, or the browser blocks them once deployed (see [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors))
- Prefer `scan({ prefix })` over unscoped `scan()` to limit enumeration cost
- For browser uploads/downloads returned from API methods, prefer `createUploadHandle`/`getFileHandle` over raw presigned URLs — they encode the fetch protocol into typed methods so the client can't misuse them
- Use `deleteBatch()` instead of looping `delete()` for bulk operations
- Versioning is **on by default**; noncurrent (superseded) versions are automatically expired after **90 days** (`noncurrentVersionExpirationDays`, default `90`) so version history doesn't grow storage cost unbounded. Tune the window per-block, or disable versioning (`versioned: false`) to drop the expiration rule along with versioning.

## Local Development

Mock data persists to disk at `.bb-data/{fullId}/` across dev server restarts. Internal data is segregated into sibling roots so it never collides with your keys: file bodies live under `content/`, metadata under `meta/`, and version history under `versions/`. Wipe with `rm -rf .bb-data`. Presigned URLs are served by the dev server at `/.bb-file-bucket/{fullId}/{path}?token=...`. Version-aware operations are available locally, with the historical delete-marker limitation described under [Versioned Bucket](#versioned-bucket). Lifecycle rules and `corsRules` have no effect locally — the dev file-server accepts browser requests from any origin, so a missing or wrong `corsRules` only shows up after deploy (see [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors)).

The dev server enforces what an upload URL signs, as S3 does: an upload whose `Content-Type` (or, when `contentLength` was signed, size) differs from the signed value fails with `403 SignatureDoesNotMatch`. Local downloads are always served with `X-Content-Type-Options: nosniff` and a `Content-Disposition` — the one signed with `attachment`, or plain `attachment` otherwise — so files never display inline in local dev even though they can on AWS (see [Serving user uploads](#serving-user-uploads)).

When a local download URL specifies a `versionId`, only that version is served. An unknown or permanently deleted version returns HTTP 404; it never falls back to the current file. URLs without `versionId` select the current file.


