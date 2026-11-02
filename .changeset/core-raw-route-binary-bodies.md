---
"@aws-blocks/core": patch
---

Fix `RawRoute` corrupting binary request bodies and add binary responses. `ctx.request.body` now yields the exact bytes the client sent under `npm run dev` and on AWS, instead of a UTF-8 re-encoding with invalid sequences replaced by U+FFFD. `text()` and `json()` decode those bytes, so a multi-byte character split across dev-server request chunks is no longer corrupted either. `ctx.response.send()` with a `Buffer`, `Uint8Array` or `ArrayBuffer` sends the raw bytes rather than their JSON serialization; on Lambda they are returned base64-encoded with `isBase64Encoded: true`.

The backend REST API now sets `binaryMediaTypes: ['*/*']`, so API Gateway passes binary payloads to the Lambda instead of converting them to text. Every request body, JSON-RPC included, now reaches the Lambda base64-encoded, which adds a third to its size against Lambda's 6 MB payload limit: the largest request body drops from about 6 MB to about 4.5 MB.
