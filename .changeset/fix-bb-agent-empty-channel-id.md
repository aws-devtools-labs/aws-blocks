---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): reject empty channelId in stream()

An empty `channelId` produced an invalid Realtime channel path, causing the client subscription to silently receive no chunks. Now throws `ValidationFailedException` immediately.
