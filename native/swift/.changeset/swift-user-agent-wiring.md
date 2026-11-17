---
"aws-blocks-swift": patch
---

feat(swift): send user-agent token on outbound runtime requests

Every outbound runtime request now carries `blocksUserAgentToken`
(`aws-blocks-swift/<version>`) so the backend can attribute the client and
version: `BlocksClient` sets `x-blocks-user-agent` on the JSON-RPC hop, and a
shared `BlocksRuntimeSession` sets `User-Agent` on the direct-to-AWS paths
(presigned S3, WebSocket) without touching `URLSession.shared`.

`FileUploadHandle.init` and `FileDownloadHandle.init` change their `session`
parameter from `URLSession = .shared` to `URLSession? = nil`;
when omitted it now defaults to the ephemeral, cookie-free `BlocksRuntimeSession`
instead of `URLSession.shared`. A caller that passes its own session owns that
session and opts out of the token.
