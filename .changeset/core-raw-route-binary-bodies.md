---
"@aws-blocks/core": minor
"@aws-blocks/hosting": patch
---

Fix `RawRoute` corrupting binary request bodies and add binary responses. On Lambda, `ctx.request.body` now yields the exact bytes the client sent, instead of a UTF-8 re-encoding with invalid sequences replaced by U+FFFD (the dev server and container computes already passed bytes through). `ctx.response.send()` with a `Buffer`, `Uint8Array` or `ArrayBuffer` sends the raw bytes rather than their JSON serialization, under `npm run dev`, on container computes and on Lambda, where they are returned base64-encoded with `isBase64Encoded: true`. A byte response without a `Content-Type` is sent as `application/octet-stream`; any other RawRoute response without one stays `application/json`.

The backend REST API now sets `binaryMediaTypes: ['*/*']`, so API Gateway passes binary payloads to the Lambda instead of converting them to text. This is API-wide:

- Every request body, JSON-RPC included, reaches the Lambda base64-encoded, which adds a third to its size against Lambda's 6 MB invocation limit: the largest request body drops from about 6 MB to about 4.5 MB. Move large files with `FileBucket`'s presigned URLs.
- An integration you add to the stack's `gateway` yourself also receives binary bodies: a Lambda proxy integration gets them base64-encoded with `isBase64Encoded: true`, and a non-proxy integration whose mapping template expects text needs `contentHandling: ContentHandling.CONVERT_TO_TEXT`.
