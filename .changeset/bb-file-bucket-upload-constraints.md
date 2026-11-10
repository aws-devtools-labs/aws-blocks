---
"@aws-blocks/bb-file-bucket": minor
"@aws-blocks/blocks": minor
---

feat(bb-file-bucket): signed upload constraints, opt-in download disposition, stricter key validation and 400 for invalid input

- **Presigned uploads always sign a `Content-Type`.** `putUrl()` and `createUploadHandle()` now sign the `contentType` you pass, or `application/octet-stream` when you pass none, so the upload must send exactly that header (S3 answers `403 SignatureDoesNotMatch` otherwise). `createUploadHandle().upload()` and its hydrated client handle always send it. **Breaking:** an upload to a `putUrl()` URL created without `contentType` must now send `Content-Type: application/octet-stream`; pass the `contentType` the client will send. `put()` without `contentType` now stores `application/octet-stream` on AWS too, matching local dev.
- **`contentType` must be a single media type.** `put()`, `putUrl()` and `createUploadHandle()` reject (400 `ValidationFailed`) a `contentType` that is not `type/subtype` with optional `; name=value` parameters — for example a comma-separated list, non-ASCII or control characters, or an empty value.
- **New `contentLength` option** on `putUrl()` / `createUploadHandle()` signs the exact upload size, so only a body of that size is accepted.
- **New bucket options `allowedContentTypes` and `maxUploadBytes`.** `allowedContentTypes` (exact media types or `type/*` wildcards) restricts the content types `put()`, `putUrl()` and `createUploadHandle()` accept. `maxUploadBytes` caps `put()` bodies and makes presigned uploads require a `contentLength` at or under it. Both are checked identically in local dev and on AWS, and their shape is validated at synth.
- **New `attachment` option** on `getUrl()` / `getFileHandle()`: `true` or a filename signs a `Content-Disposition: attachment` into the download URL, so the browser saves the file instead of displaying it. Default behavior is unchanged.
- **Stricter key validation.** Keys are also rejected when they contain a backslash, C1 control characters, U+2028/U+2029, or bidirectional formatting characters, or a segment that reads as `.` or `..` once `%2e` is decoded. `scan({ prefix })` now validates the prefix with the same rules (an empty prefix and a trailing `/` are allowed).
- **`ValidationFailed` is now an `ApiError` with status 400**, so API methods answer invalid keys, prefixes, expiry values and upload constraints with HTTP 400 instead of 500. The name and message format are unchanged, and messages never include the key.
- **`VersionNotFound` from `restoreVersion()` now has the fixed message `The requested version does not exist`**, without the key or version id.

The README adds sections on per-user isolation (derive keys from the authenticated user, never from a client-supplied key or prefix), upload constraints, serving user uploads, and the key rules; its examples now build keys from the caller's identity.
