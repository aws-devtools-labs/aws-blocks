---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): add toJSON() to AgentStreamResult

`AgentStreamResult` now serializes cleanly to `{ channelId }` when returned from API methods. The `channel` (Promise) and `complete()` (function) no longer produce unusable values on the client.
