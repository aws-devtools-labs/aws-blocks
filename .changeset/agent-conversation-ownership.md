---
"@aws-blocks/bb-agent": minor
"@aws-blocks/blocks": minor
---

fix(bb-agent): check conversation ownership in `stream()`, `resume()`, `getConversation()` and `getPendingInterrupts()`, and scope `getChannel()` to the caller

`stream()` and `resume()` accepted any `conversationId` alongside a `userId` and never checked that the conversation belonged to that user. A caller who knew another user's conversation ID could add turns to it, or approve (and `trust`) that user's pending tool call, which then ran with the agent's IAM role. The same ID also let a caller read the conversation's history, and listen to or push chunks onto its live Realtime channel (the default `channelId` is the conversation ID).

- **`stream()` and `resume()`** now throw `AgentErrors.ConversationNotFound` unless `options.conversationId` was created by `createConversationId(userId)` for the same `options.userId`. The check runs before anything is persisted or dispatched, and reads the conversation record with a strongly consistent read, so a `stream()` right after `createConversationId()` is not rejected on AWS.
- **A turn without a `conversationId`** no longer runs in a conversation's session on AWS. Its AgentCore session id was the caller-chosen `channelId`, and the AgentCore entry used that as the conversation, so `stream({ channelId: <another user's conversation id> })` skipped the ownership check. It now gets its own session and, as in the local mock, no persisted conversation. **Breaking (AWS only):** a deployed agent that relied on reusing a `channelId` without a `conversationId` to keep memory across turns loses it; pass a `conversationId` instead (`createConversationId()` for persistence agents, a server-chosen key for `inferenceOnly` agents).
- **`getPendingInterrupts(conversationId, { userId })`** now requires an options object with the caller's `userId` and returns `[]` for a conversation that user doesn't own. **Breaking:** `getPendingInterrupts(id)` becomes `getPendingInterrupts(id, { userId })`.
- **`getConversation(id, { userId, limit? })`** now requires the caller's `userId` in its existing options object and returns `[]` for a conversation that user doesn't own. **Breaking:** `getConversation(id)` / `getConversation(id, { limit })` become `getConversation(id, { userId })` / `getConversation(id, { userId, limit })`.
- **`getChannel(channelId, { userId })`** now requires an options object with the caller's `userId`. With persistence enabled, a turn's chunks are published on a channel scoped to the user who started it, so a caller can't listen to, or push chunks onto, another user's channel, whatever `channelId` they pass. **Breaking:** `getChannel(channelId)` becomes `getChannel(channelId, { userId })`, with the same `userId` you pass to `stream()`/`resume()`. `inferenceOnly` agents don't use the value but must still pass `{ userId }` (any string); their channels are not user-scoped.
- There is no backward-compatible form: the old calls carry no `userId`, so they could only keep returning another user's data or change behaviour. With persistence enabled, `getConversation()`, `getPendingInterrupts()` and `getChannel()` throw `AgentErrors.InvalidUsage` naming the new signature when the options object or its `userId` is missing, instead of returning data. Build the options from the session's `userId`; don't spread a caller-supplied object into them.

Agents with `inferenceOnly: true` keep no conversation records, so these checks don't apply to them: a `conversationId` passed to one is a shared session key, so don't let callers choose it.

The channel key changes with persistence enabled, so reload chat sessions that were open across the upgrade (including turns that were running while the deploy rolled out); a subscription made before it no longer receives chunks.

If you pass a `conversationId` that was never created with `createConversationId()`, `stream()` now rejects it; create the conversation first. Pass a `userId` taken from the authenticated session, never from a request parameter. The README's Authorization section and End-to-End example (which now includes the `getPendingInterrupts` and `resume` handlers) show this.
