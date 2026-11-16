---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

fix(bb-agent): scope `inferenceOnly` sessions to the user by default

`sessionScope` now defaults to `'user'`. An `inferenceOnly` agent keys each session by the `userId` together with the `conversationId` and scopes its Realtime channel to the `userId`, so a caller who passes another user's `conversationId` gets a separate, empty session and never receives the other user's chunks. `'shared'` stays available as an explicit opt-in.

**Breaking for `inferenceOnly` agents:**

- `stream()`, `resume()` and `getChannel()` on an `inferenceOnly` agent now require `options.userId` and throw `AgentErrors.InvalidUsage` without it. Pass the authenticated user's id, as for a persistent agent.
- Sessions stored under the bare `conversationId` are not resumed once an agent moves to `'user'`.
- With `sessionScope: 'shared'`, `resume()` now throws `AgentErrors.InvalidUsage`: a session with no owner can't tell who may approve its pending tool calls.

To keep the previous behaviour, set `sessionScope: 'shared'` on the agent, but only if callers can't choose the `conversationId` or `channelId` (for example, the server generates them and keeps them to itself). With `'shared'`, anyone who passes the same `conversationId` continues that session, and anyone who passes the same `channelId` receives its chunks.

Also:

- The channel handles the agent returns (`getChannel()`, `stream()`'s `channel`) now carry a token that authorizes only that channel (Realtime's `scope: 'exact'`), not the sub-channels under it.
- The error `resume()` throws without a `conversationId` on an `inferenceOnly` agent no longer says such agents can't be resumed. It says to pass the same `conversationId` to `stream()` and `resume()`.
