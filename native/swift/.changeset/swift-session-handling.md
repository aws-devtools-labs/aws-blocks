---
"aws-blocks-swift": patch
---

fix(swift): redact session values from debug logs

Debug logging no longer includes credential values: a realtime channel logs the channel name
instead of the subscribe message with its token, and the size of each inbound WebSocket message
instead of its body; file uploads and downloads log the presigned URL's scheme, host and path without
its query string.
