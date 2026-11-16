---
"aws-blocks-swift": patch
---

fix(swift): require a readable state envelope on OIDC sign-in and redact session values from debug logs

`OIDCClient.signIn` now ends with `OIDCError.stateMismatch` when the returned `state` cannot be read as
the Auth block's `payload.signature` envelope or its payload has no `csrf` value, as the Kotlin
runtime does.

Debug logging no longer includes credential values: a realtime channel logs the channel name
instead of the subscribe message with its token, and the size of each inbound WebSocket message
instead of its body; file uploads and downloads log the presigned URL's scheme, host and path without
its query string.

`OIDCUser` now documents that its `userId`, `username` and `groups` are for display only: after
`restore()` they are decoded on the device from the stored access token without verifying its
signature, so authorization decisions belong on the server.
