---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

fix(bb-agent): scope `inferenceOnly` sessions to the user by default

An `inferenceOnly` agent keeps no conversation records, so it can't check that a `conversationId` belongs to the caller. It now keys each session by the `userId` together with the `conversationId` and scopes its Realtime channel to the `userId`, so a caller who passes another user's `conversationId` gets a separate, empty session and never receives the other user's chunks. On AWS, the two users also run in different AgentCore runtime sessions. The new `sessionScope` option controls this: `'user'` is the default, and `'shared'` is an explicit opt-out. The option is ignored when persistence is enabled; those agents already check conversation ownership.

**Breaking for `inferenceOnly` agents:**

- `stream()`, `resume()` and `getChannel()` on an `inferenceOnly` agent now require a non-empty string `options.userId` and throw `AgentErrors.InvalidUsage` without one. Pass the authenticated user's id, as for a persistent agent. A runtime invocation that arrives without a `userId` is refused rather than run as `'anonymous'`.
- Sessions previously keyed by the bare `conversationId` are no longer resumed.

To key sessions by the `conversationId` alone, as before, set `sessionScope: 'shared'` on the agent, but only if callers can't choose the `conversationId` or `channelId` (for example, the server generates them and keeps them to itself). With `'shared'`, anyone who passes the same `conversationId` continues that session, and anyone who passes the same `channelId` receives its chunks. Because such a session has no owner who could approve a pending tool call:

- `resume()` throws `AgentErrors.InvalidUsage`.
- The constructor throws `AgentErrors.InvalidModelConfig` when a tool sets `needsApproval` or `interrupt`. An agent with approval steps needs the default `'user'` scope (or persistence).

Also:

- The channel handles the agent returns (`getChannel()`, `stream()`'s `channel`) now carry a token that authorizes only that channel (Realtime's `scope: 'exact'`), not the sub-channels under it.
- The error `resume()` throws without a `conversationId` on an `inferenceOnly` agent no longer says such agents can't be resumed. It says to pass the same `conversationId` to `stream()` and `resume()`.
