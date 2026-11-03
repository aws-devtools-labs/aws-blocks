---
"@aws-blocks/bb-realtime": patch
---

Fix server-side `subscribe()` on AWS opening a WebSocket that is never closed when the returned unsubscribe runs before the token secret resolves.
