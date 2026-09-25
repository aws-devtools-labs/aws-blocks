---
"aws-blocks-swift": patch
---

feat(swift): send user-agent token on outbound runtime requests

Every outbound request from the Swift runtime now carries the
`blocksUserAgentToken` (`aws-blocks-swift/<version>`) so the backend can
attribute which native client and version made a call:

- `BlocksClient` sets the custom `x-blocks-user-agent` header on the JSON-RPC
  hop, which the Blocks server reads.
- A shared `BlocksRuntimeSession` sets the standard `User-Agent` on the
  direct-to-AWS paths (presigned S3 upload/download, WebSocket upgrade), leaving
  the process-wide `URLSession.shared` untouched.

Public API change (source-compatible): `FileUploadHandle.init` and
`FileDownloadHandle.init` change their `session` parameter from
`URLSession = .shared` to `URLSession? = nil`. Existing call sites compile
unchanged; a caller that still passes an explicit session is unaffected.

Behavior change: when no session is supplied, both handles now default to the
shared `BlocksRuntimeSession` (an ephemeral, cookie-disabled configuration
carrying the user-agent) instead of `URLSession.shared`. Presigned S3 transfers
are stateless and need no cookies, so this only adds the header and stops these
transfers from sharing the app's cookie/cache stores; a caller that relied on
the old `URLSession.shared` default should pass it explicitly.

The token rides on the session configuration (set once where the client is
created, not per request), so a caller who passes their own `URLSession` to
`BlocksClient`, `FileUploadHandle`, or `FileDownloadHandle` is responsible for
that session and opts out of attribution on those paths.
