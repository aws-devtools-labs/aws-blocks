# FileBucket

File storage backed by Amazon S3.

**When to use:** You need to store, retrieve, or serve binary files — user uploads, generated reports, images, videos, or static assets.

**When NOT to use:** If you need structured key-value data with conditional writes, or queryable records with indexes, use `KVStore`.

> Design & mock parity details: [DESIGN.md](./DESIGN.md)

> Production settings (access logging, KMS encryption, Object Lock, scaling & cost): [PRODUCTION.md](./PRODUCTION.md)

## Quick start

```typescript
const auth = new Auth(scope, 'auth');
const bucket = new FileBucket(scope, 'uploads');

/** The caller's key for `name`, under a prefix only they can reach. */
function userKey(userId: string, name: string): string {
  return `uploads/${encodeURIComponent(userId)}/${encodeURIComponent(name)}`;
}

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

`Auth` is the auth block from `@aws-cdk-blocks/bb-auth`. Keys are built on the server under a per-user prefix: see [Access control and per-user isolation](#access-control-and-per-user-isolation).

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
| `getUrl(path, options?)` | `Promise<string>` | Generate a presigned download URL. Accepts `versionId` on versioned buckets. Use it when the caller needs the URL itself (`<img src>`, `<a href>`); for a browser `fetch`, return a handle. |
| `putUrl(path, options?)` | `Promise<string>` | Generate a presigned upload URL. The caller must send the signed `Content-Type` itself; for a browser upload, return a handle. |
| `getFileHandle(path, options?)` | `Promise<FileDownloadClient>` | Get a download handle to return from an API method; the browser calls `download()` on it. Accepts `versionId` on versioned buckets. |
| `createUploadHandle(path, options?)` | `Promise<FileUploadClient>` | Get an upload handle to return from an API method; the browser calls `upload()` on it. |
| `scan(options?)` | `AsyncIterable<FileInfo>` | List files. Use `prefix` to scope. |
| `listVersions(path)` | `Promise<FileVersionInfo[]>` | List all versions of a file (versioned buckets only). Newest first. |
| `restoreVersion(path, versionId)` | `Promise<void>` | Restore a previous version as the current version. |
| `FileBucket.fromExisting(bucketName)` | `ExternalBucketRef` | Wrap a pre-existing S3 bucket. Pass to `options.bucket`. |
| `FileBucket.fromKmsKey(keyArn)` | `ExternalKmsKeyRef` | Reference an existing customer-managed KMS key. Pass to `options.encryption`. |

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `versioned` | `boolean` | `true` | Enable S3 object versioning. Only the literal `versioned: false` removes `versionId` from the option types of `get`/`delete`/`getUrl`/`getFileHandle`; a non-literal `boolean` or an absent value keeps it. |
| `noncurrentVersionExpirationDays` | `number` | `90` | Days after which noncurrent (superseded) object versions are permanently expired. Only applies when versioning is enabled. Must be a positive integer — a non-positive or non-integer value throws at synth. To drop the rule, disable versioning (`versioned: false`). Ignored by the mock and browser runtimes. |
| `corsRules` | `CorsRule[]` | none | CORS rules for browser-based access. Without a rule, browsers block every cross-origin `fetch()` to the deployed bucket, including `download()` / `upload()` on a file handle. Not inherited from the stack's `defaults.allowedOrigins` or the Hosting domain. Ignored when `bucket` wraps an existing bucket. See [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors), and [CorsRule](#corsrule) for the wildcard-origin synth guard. |
| `lifecycleRules` | `LifecycleRule[]` | none | Lifecycle rules for automatic expiration or storage class transitions. See [LifecycleRule](#lifecyclerule). |
| `accessLogging` | `boolean` | stack posture (`BlocksDefaults.storageAccessLogging`, then `BlocksDefaults.accessLogging`) | Enable S3 server access logging to a dedicated log bucket. See [PRODUCTION.md](./PRODUCTION.md). Ignored by the mock and browser runtimes. |
| `encryption` | `'aws-managed' \| 'customer-managed' \| ExternalKmsKeyRef` | `'aws-managed'` | Server-side encryption at rest. `'aws-managed'` is SSE-S3. `'customer-managed'` creates a dedicated KMS key for this bucket (rotation on, removed with the bucket); `FileBucket.fromKmsKey(arn)` uses a key you already own. Both use SSE-KMS with S3 Bucket Keys. Any other value fails the synth with an error listing the valid values. See [Encryption with KMS](./PRODUCTION.md#encryption-with-kms). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Ignored by the mock and browser runtimes. |
| `objectLock` | `{ mode: 'governance' \| 'compliance'; retentionDays: number }` | off | Enable S3 Object Lock with a default retention for every new object version. Requires versioning and a retained bucket (`removalPolicy: 'retain'` in a sandbox); both are checked at synth. Can't be turned off once on. Presigned uploads (`putUrl`, `createUploadHandle`) throw `PresignedUploadUnsupported` — upload with `put()`. See [Object Lock](./PRODUCTION.md#object-lock). Ignored, with a synth warning, when `bucket` wraps an existing bucket. Validated, but not enforced, by the mock. |
| `allowedContentTypes` | `string[]` | any | Content types the bucket accepts on upload: exact media types (`'application/pdf'`) or `type/*` wildcards (`'image/*'`), without parameters. A wildcard does not match the types a browser can run, such as `text/html` and `image/svg+xml`. Checked by `put()`, `putUrl()` and `createUploadHandle()`; an unlisted type throws `ValidationFailed`. Must be a non-empty array of `type/subtype` or `type/*` strings (checked at synth). See [Upload constraints](#upload-constraints) for the matching rules. |
| `maxUploadBytes` | `number` | no limit | Largest upload, in bytes. When set, `putUrl()` / `createUploadHandle()` require `contentLength` and reject one above the limit, and `put()` rejects a larger body (`ValidationFailed`). Must be a positive integer (checked at synth). See [Upload constraints](#upload-constraints). |
| `bucket` | `ExternalBucketRef` | — | Wrap an existing S3 bucket instead of creating one. See [Wrapping an Existing Bucket](#wrapping-an-existing-bucket). |
| `logger` | `ChildLogger` | error-level logger | Logger for internal operations. |
| `removalPolicy` | `'destroy' \| 'retain'` | stack posture (`BlocksDefaults.removalPolicy` — `DESTROY` in sandbox, `RETAIN` in production) | CDK removal behavior for the underlying S3 bucket. `'destroy'` also enables `autoDeleteObjects` so the bucket can be emptied on teardown. Ignored by the mock and browser runtimes. |

All FileBucket-provisioned buckets reject requests that do not use TLS (`enforceSSL: true`). This is not configurable.

The S3 bucket name is derived from the scope chain: the FileBucket id joined to its parent scope ids with `-`. A name longer than S3's 63-character limit is shortened to the start of the name plus `-` and an 8-character hash; the shortened name is the same on every deploy. A name that breaks any other S3 naming rule (for example, one with uppercase letters) fails `cdk synth` with a `ValidationFailed` error. To read the resolved name, call `getSdkIdentifiers(bucket).bucketName` (from `aws-cdk-blocks`).

### PutOptions

| Option | Type | Description |
|--------|------|-------------|
| `contentType` | `string` | MIME type (e.g., `image/png`). Default: `application/octet-stream`. Must be in `allowedContentTypes` when the bucket sets it. |
| `metadata` | `Record<string, string>` | Custom metadata key-value pairs, set when the object is written. It can't be edited in place: each `put()` replaces it, so a `put()` without `metadata` leaves none. See [Changing Metadata](#changing-metadata). S3 stores the keys in lowercase and the local mock keeps the case you wrote, so use lowercase keys. |
| `cacheControl` | `string` | Cache-Control header value. |

### Presigned URL options

`getUrl`, `putUrl`, `getFileHandle`, and `createUploadHandle` accept `expiresIn` in seconds. It must be an integer from `1` to `604800` (seven days); the default is `3600`.

`putUrl` and `createUploadHandle` also accept:

| Option | Type | Description |
|--------|------|-------------|
| `contentType` | `string` | Content type of the upload. Default: `application/octet-stream`. Always signed into the URL: the upload must send exactly this `Content-Type` header, or S3 rejects it with `403 SignatureDoesNotMatch`. `createUploadHandle().upload()` sends it for you, whatever the uploaded file's own type; to store a browser `File`'s type, pass `contentType: file.type`. |
| `contentLength` | `number` | Exact size of the upload in bytes. When set, it is signed into the URL and S3 only accepts a body of exactly this size (browsers set `Content-Length` from the body). Required when the bucket sets `maxUploadBytes`. |

`getUrl` and `getFileHandle` also accept:

| Option | Type | Description |
|--------|------|-------------|
| `attachment` | `boolean \| string` | Make the browser download the file instead of displaying it. Default: off (the file is displayed inline when the browser can render it). `true` signs `Content-Disposition: attachment` into the URL; a filename (e.g. `'report.pdf'`) also suggests that name. Control characters, directional formatting characters and zero-width characters are removed from the filename, and `/` and `\` are replaced with `_`; a filename that is empty, `.` or `..` afterwards throws `ValidationFailed`. See [Serving user uploads](#serving-user-uploads). |

### CorsRule

| Field | Type | Description |
|-------|------|-------------|
| `allowedOrigins` | `string[]` | Origins permitted to make cross-origin requests (e.g., `['https://app.example.com']`). |
| `allowedMethods` | `('GET' \| 'PUT' \| 'POST' \| 'DELETE' \| 'HEAD')[]` | HTTP methods permitted for cross-origin requests. |
| `allowedHeaders` | `string[]` | Optional. Request headers permitted in the actual request. |
| `exposedHeaders` | `string[]` | Optional. Response headers exposed to the browser. |
| `maxAge` | `number` | Optional. Seconds the browser may cache the preflight response. |

> **Wildcard origins and mutating methods:** a CORS rule that combines a wildcard origin (`'*'`) with a mutating method (`PUT`, `POST`, or `DELETE`) **throws at synth** — it would let any site issue state-changing cross-origin requests. Specify explicit origins (e.g. `['https://app.example.com']`) for mutating methods. A wildcard origin with only safe methods (`GET`/`HEAD`) is allowed.

### LifecycleRule

| Field | Type | Description |
|-------|------|-------------|
| `prefix` | `string` | Optional. Prefix filter — the rule applies only to keys starting with this prefix. Omit to apply to all objects. |
| `expirationDays` | `number` | Optional. Days after creation to expire (delete) objects. |
| `transitionToIaDays` | `number` | Optional. Days after creation to transition objects to Infrequent Access storage. |

### FileContent

Returned by `get()`.

| Field | Type | Description |
|-------|------|-------------|
| `body` | `Buffer` | The file body. |
| `contentType` | `string` | MIME type of the file. |
| `metadata` | `Record<string, string>` | Custom metadata key-value pairs. |
| `size` | `number` | Size in bytes. |

### FileInfo

Yielded by `scan()`.

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | The object key. |
| `size` | `number` | Size in bytes. |
| `lastModified` | `Date` | Last modification timestamp. |

### FileVersionInfo

| Field | Type | Description |
|-------|------|-------------|
| `versionId` | `string` | The version identifier. |
| `lastModified` | `Date` | When this version was created. |
| `size` | `number` | Size in bytes. |
| `isCurrent` | `boolean` | Whether this is the current (latest) version. |

### FileDownloadClient and FileUploadClient

Returned by `getFileHandle()` and `createUploadHandle()`. A handle returned from an API method arrives in the browser client with the same methods.

| Type | Method | Returns | Description |
|------|--------|---------|-------------|
| `FileDownloadClient` | `download()` | `Promise<Blob>` | Fetch the file from the presigned URL. Throws an `Error` (`Download failed: <status>`) when the response is not OK. |
| `FileDownloadClient` | `getUrl()` | `string` | The presigned URL. |
| `FileUploadClient` | `upload(body)` | `Promise<void>` | `PUT` a `Blob`, `File` or `ArrayBuffer` to the presigned URL with the signed `Content-Type`. Throws an `Error` (`Upload failed: <status>`) when the response is not OK. |
| `FileUploadClient` | `getUrl()` | `string` | The presigned URL. |

## Errors

Match an error by name with `isBlocksError`:

```typescript
import { FileBucketErrors, isBlocksError } from 'aws-cdk-blocks';
```

| Constant | `error.name` | Thrown when |
|----------|--------------|-------------|
| None; match it with `isBlocksError(e, 'ValidationFailed')` | `ValidationFailed` | Any method: a key or `scan()` prefix breaks the [key rules](#object-keys). The URL and handle methods: `expiresIn` is out of range, or `attachment` is invalid. `put()`, `putUrl()`, `createUploadHandle()`: the content type or size is malformed or one the bucket does not accept. |
| `FileBucketErrors.VersionNotFound` | `NoSuchVersion` | Thrown by `restoreVersion()` when the target `versionId` cannot be resolved. |
| `FileBucketErrors.PresignedUploadUnsupported` | `PresignedUploadUnsupported` | Thrown by `putUrl()` and `createUploadHandle()` on a bucket with `objectLock` — see [Object Lock](./PRODUCTION.md#object-lock). |
| `FileBucketErrors.FileNotFound` | `NoSuchKey` | No FileBucket method throws it: `get()` returns `null` for a missing file. It is the error code of the HTTP 404 that a presigned download URL returns for a missing or deleted file, on AWS and locally. |
| `FileBucketErrors.FileTooLarge` | `EntityTooLarge` | No FileBucket method throws it: an upload over `maxUploadBytes` throws `ValidationFailed`. |

`ValidationFailed` is an `ApiError` with status `400`, so an API method that lets it propagate answers the client with HTTP 400. Its message is fixed text and never includes the key or other input.

## Object keys

Keys are validated identically in local dev and on AWS. A key that breaks any of these rules throws `ValidationFailed` (HTTP 400):

- not empty, and at most 1,024 bytes once UTF-8 encoded (S3's key limit);
- no leading `/`;
- no empty segment (`a//b`) or trailing `/`;
- no `.` or `..` segment, including one spelled with `%2e`, `%2f` or `%5c` in either case (`a/%2e%2e/b`, `a/..%2f../b`, `a/%2e%2e%2fb`) — other `%` sequences, such as `100%done.txt`, are allowed;
- no backslash (`\`);
- no control characters (U+0000–U+001F, U+007F–U+009F), line or paragraph separators (U+2028, U+2029), or bidirectional formatting characters (U+202A–U+202E, U+2066–U+2069).

A `scan()` prefix follows the same rules, except that it may be empty or end with `/`.

## Access control and per-user isolation

FileBucket has no per-object permissions of its own. Every API method reads and writes the bucket with the app's shared execution role, so **any key a method accepts from the client is a key every signed-in user can reach**. Enforce ownership in the API method:

- Gate each method with your auth block (`await auth.requireAuth(context)`).
- Build keys on the server under a per-user prefix derived from the authenticated identity (`uploads/${encodeURIComponent(user.userId)}/…`). Never pass a client-supplied full key, or a client-supplied `scan()` prefix, straight to `put`, `get`, `delete`, `getUrl`, `putUrl`, `scan` or the handle methods.
- Accept only a file *name* from the client and wrap it in `encodeURIComponent()`, so it stays a single path segment and can't add `/` to reach another prefix. FileBucket rejects `.`/`..` segments and other unsafe keys with `ValidationFailed`; see [Object keys](#object-keys).
- Wrap the `userId` segment in `encodeURIComponent()` too: an OIDC `userId` of `${iss}:${sub}` (like `https://issuer:sub`) contains `//`, an empty path segment that throws `ValidationFailed`.
- For a resource shared between users (a document, a team folder), check that the caller may access it — for example by looking up an ownership record — before building its key.

The snippets below use the `auth` block, `bucket` and `userKey()` helper from [Quick start](#quick-start).

## Upload constraints

To restrict what a bucket accepts:

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
- An upload to a URL or handle signed with `contentLength` must send exactly that many bytes with a `Content-Length` header. Browsers and `fetch` set it from the body. With the native Kotlin client, pass the same `contentLength` to `uploadFrom(source, contentLength)`: without it the stream is sent with no `Content-Length` and the upload is rejected. The native Swift `uploadFrom(fileURL:)` sends the file's size, so the file must be exactly `contentLength` bytes.
- The checks run in the API method, before a URL is signed, identically in local dev and on AWS — including for a bucket wrapped with `FileBucket.fromExisting`. The local dev server also rejects an upload whose `Content-Type` or size differs from the signed values with `403`, as S3 does.

## Serving user uploads

A presigned download URL serves the file with its stored content type, and the browser displays it inline when it can render it. **A file displayed inline can run as a page:** an uploaded HTML or SVG file executes script in the origin that serves it. For user-uploaded content, either restrict uploads to safe types with `allowedContentTypes` (for example `image/*`; see [Upload constraints](#upload-constraints)), or make downloads attachments:

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

## Browser Uploads and Downloads (CORS)

Presigned URLs and file handles are fetched by the browser **directly from S3**, which is a different origin from your frontend. Without a `corsRules` entry that allows your frontend's origin, every browser upload or download against a deployed sandbox or production stack fails with:

```text
Access to fetch at 'https://<bucket>.s3.<region>.amazonaws.com/...' from origin 'http://localhost:3000'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

For `upload()` / `PUT`, the browser fails at the preflight instead, and the message continues with `Response to preflight request doesn't pass access control check:` before the same text.

`npm run dev` does not surface this: the local dev file-server accepts any origin, so the error first appears after you deploy.

List every origin your frontend is served from:

- the local dev frontend (`http://localhost:3000`), when it talks to a deployed sandbox;
- your deployed app's origin. With Hosting, that is the stack's `HostingUrl` output: your custom domain if you configured one, otherwise the generated `https://<id>.cloudfront.net` domain.

The generated domain only exists after the first deploy: deploy once, copy `HostingUrl` into `corsRules`, then deploy again.

```typescript
const bucket = new FileBucket(scope, 'uploads', {
  corsRules: [{
    allowedOrigins: ['http://localhost:3000', 'https://app.example.com'],
    allowedMethods: ['GET', 'PUT'],
    allowedHeaders: ['Content-Type'],
  }],
});
```

`cdk-blocks/index.ts` is shared by sandbox and production deploys, so this rule also allows `http://localhost:3000` on the production bucket. Only a sandbox needs it; presigned URLs authenticate through their query-string signature, not ambient browser credentials.

- `GET` covers `download()` and `fetch()` on a `getUrl()` URL; `PUT` covers `upload()` and a `putUrl()` URL.
- `allowedHeaders` must list every header the browser sends, such as the `Content-Type` that `upload()` sends. S3 rejects the preflight of a `PUT` with a header that is not allowed.
- `allowedOrigins` entries are S3 origin strings (scheme + host + port, no trailing slash), optionally with a single `*` wildcard such as `https://*.example.com` — not the regex patterns used by `defaults.allowedOrigins`.
- Use exact origins for `PUT`, `POST`, and `DELETE`. The synth check (see [CorsRule](#corsrule)) catches only a bare `'*'` origin; a partial wildcard such as `https://*` is not caught, so avoid it for mutating methods.
- Plain navigations to a `getUrl()` URL (`<img src>`, `<a href>`) are not CORS requests and work without a rule; `fetch()`, `download()`, and `upload()` do need one.
- `exposedHeaders` (for example `ETag` or `x-amz-version-id`) is only needed when custom `fetch()` code reads response headers; the built-in handles don't. Every `PUT` preflights, so a `maxAge` (for example `3000`) saves a round trip per upload.
- CORS is bucket configuration: redeploy after changing `corsRules`.

## Changing Metadata

Object metadata can't be edited in place, and FileBucket doesn't expose S3's server-side copy (`CopyObject`). To change metadata, `get()` the object and `put()` the same body again with the complete new set:

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async markReviewed(name: string) {
    const user = await auth.requireAuth(context);
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

- `get()` doesn't return `cacheControl`. If you set one, pass it again.
- On a versioned bucket (the default), each rewrite stores another full copy of the object as a noncurrent version. It's kept, and billed, for `noncurrentVersionExpirationDays`. Until then the previous metadata stays on the previous version, and `restoreVersion()` brings it back with that version.
- The rewrite isn't atomic. Anything written to the object between the `get()` and the `put()` (a new body or other metadata) is overwritten with what was read, and FileBucket has no conditional write to guard against it. Avoid rewriting objects that other code may be updating at the same time.
- Uploads through presigned URLs (`putUrl()`, `createUploadHandle()`) carry no custom metadata. Set it afterwards with a rewrite like the one above.

## Wrapping an Existing Bucket

```typescript
const bucket = new FileBucket(scope, 'legacy', {
  bucket: FileBucket.fromExisting('my-existing-bucket'),
});
```

> **A wrapped bucket does not receive FileBucket's secure defaults.** None of these are applied: `enforceSSL`, versioning / noncurrent-version expiration, server access logging, `blockPublicAccess`, encryption, `corsRules`, the wildcard-CORS guard. You own that bucket's security posture; configure these on the bucket itself (or via its own CDK construct) before wrapping it.

## Versioned Bucket

Versioning is on by default, so `listVersions`, `restoreVersion` and the optional `versionId` on `get`/`delete`/`getUrl`/`getFileHandle` need no option:

```typescript
const docs = new FileBucket(scope, 'docs');

export const api = new ApiNamespace(scope, 'api', (context) => ({
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

**Local limitation:** the mock keeps only an active delete-marker flag, not
delete markers ordered within the version history. A subsequent `put()` removes
the flag. Consequently, `put(old)` → `delete()` → `put(replacement)` → permanent
deletion of the replacement can expose `old` locally, whereas S3 would make the
earlier delete marker current and treat the key as deleted. See
[Mock vs AWS Behavior Differences](./DESIGN.md#mock-vs-aws-behavior-differences)
and use a sandbox when testing deletion history across re-uploads.

## Examples

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

### Listing Files with Scan

```typescript
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async listMyFiles() {
    const user = await auth.requireAuth(context);
    const files: FileInfo[] = [];
    for await (const file of bucket.scan({ prefix: `uploads/${encodeURIComponent(user.userId)}/` })) {
      files.push(file);
    }
    return files;
  },
}));
```

## Scaling and cost (AWS)

- **Billing:** per request plus storage; no provisioned throughput. Prices and throughput limits are in [PRODUCTION.md](./PRODUCTION.md).
- **Upload size:** FileBucket has no multipart upload: `put()` and a presigned upload each send one `PutObject` request, so S3's size limit for a single `PutObject` request applies. `put()` and `get()` hold the whole body in memory as a `Buffer`.

## Local development

- Mock data is stored under `.cdk-blocks/local/data/{fullId}/`.
- Presigned URLs are served by the dev server at `/.bb-file-bucket/{fullId}/{path}?token=...`.
- Version-aware operations are available locally, with the historical delete-marker limitation described under [Versioned Bucket](#versioned-bucket).
- Lifecycle rules and `corsRules` have no effect locally (see [Browser Uploads and Downloads (CORS)](#browser-uploads-and-downloads-cors)).

Local downloads are always served with `X-Content-Type-Options: nosniff` and a `Content-Disposition` — the one signed with `attachment`, or plain `attachment` otherwise — so files never display inline in local dev even though they can on AWS (see [Serving user uploads](#serving-user-uploads)).

When a local download URL specifies a `versionId`, only that version is served. An unknown or permanently deleted version returns HTTP 404; it never falls back to the current file. URLs without `versionId` select the current file.
