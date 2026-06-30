---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): treat empty channelId as unset in stream()

An empty `channelId` now falls back to `conversationId` or a random UUID, preventing all streams from sharing the same channel. Empty strings are treated as unset rather than used literally.
