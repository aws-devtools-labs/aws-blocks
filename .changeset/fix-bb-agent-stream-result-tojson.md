---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): add toJSON() to AgentStreamResult

`AgentStreamResult` now serializes to `{ channelId, channel: null }` when returned from API methods. Previously `channel` serialized to an empty object `{}`; it is now explicitly `null` to signal it is server-side only.
