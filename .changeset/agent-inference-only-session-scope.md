---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

feat(bb-agent): add `sessionScope: 'user'` to isolate `inferenceOnly` sessions per user

An `inferenceOnly` agent keeps no conversation records, so it can't check that a `conversationId` belongs to the caller: by default the id is a shared session key, and anyone who passes it continues that session and receives its channel. The new `sessionScope` option lets such an agent isolate sessions per user instead:

- `sessionScope: 'user'` keys the session by the `userId` together with the `conversationId`, and scopes the Realtime channel to the `userId`. A caller who passes another user's `conversationId` gets a separate, empty session and never receives the other user's chunks. On AWS, the two users also run in different AgentCore runtime sessions.
- With `'user'`, `stream()`, `resume()` and `getChannel()` require a non-empty string `options.userId` (take it from the authenticated session) and throw `AgentErrors.InvalidUsage` without one. A runtime invocation that arrives without a `userId` is refused rather than run as `'anonymous'`.
- The default stays `'shared'`, so existing agents behave as before. Switching an existing agent to `'user'` starts new sessions: sessions stored under the bare `conversationId` are not resumed.
- The option is ignored when persistence is enabled; those agents already check conversation ownership.
