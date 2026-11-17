---
"aws-blocks-swift": patch
---

fix(swift): stop loading cookies stored in the earlier format and redact session values from debug logs

Cookies stored in the earlier `host|name` format are deleted, so anyone signed in with them is
signed out once and needs to sign in again after upgrading. Those items do not record the cookie's
`Secure` or `Path`, so they are removed instead of being sent.

Debug logging no longer includes credential values: a realtime channel logs the channel name
instead of the subscribe message with its token, and the size of each inbound WebSocket message
instead of its body; file uploads and downloads log the presigned URL's scheme, host and path without
its query string.
