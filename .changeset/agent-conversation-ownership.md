---
"@aws-blocks/bb-agent": minor
---

fix(bb-agent): check conversation ownership in `stream()`, `resume()`, `getConversation()`, `getPendingInterrupts()`, and `getChannel()`

`stream()` and `resume()` accepted any `conversationId` alongside a `userId` and never checked that the conversation belonged to that user. A caller who knew another user's conversation ID could add turns to it, or approve (and `trust`) that user's pending tool call, which then ran with the agent's IAM role. The same ID also let a caller read the conversation's history, and listen to or push chunks onto its live Realtime channel (the default `channelId` is the conversation ID).

- **`stream()` and `resume()`** now throw `AgentErrors.ConversationNotFound` unless `options.conversationId` was created by `createConversationId(userId)` for the same `options.userId`. The check runs before anything is persisted or dispatched, and reads the conversation record with a strongly consistent read, so a `stream()` right after `createConversationId()` is not rejected on AWS. Agents with `inferenceOnly: true` are unaffected.
- **`getPendingInterrupts(conversationId, userId)`** now requires the caller's `userId` and returns `[]` for a conversation that user doesn't own. **Breaking:** add the `userId` argument at each call site.
- **`getConversation(id, userId, options?)`** now requires the caller's `userId` and returns `[]` for a conversation that user doesn't own. **Breaking:** `userId` is the new second argument, before `{ limit }`.
- **`getChannel(channelId, userId)`** now takes the caller's `userId`. With persistence enabled, a turn's chunks are published on a channel scoped to the user who started it, so a caller can't listen to, or push chunks onto, another user's channel, whatever `channelId` they pass. **Breaking:** pass the same `userId` you pass to `stream()`/`resume()`. It stays optional for `inferenceOnly` agents, whose channels are not user-scoped.
- Calling `getConversation()`, `getPendingInterrupts()` or `getChannel()` (with persistence) without a `userId` throws `AgentErrors.InvalidUsage` naming the new signature, instead of returning an empty result.

If you pass a `conversationId` that was never created with `createConversationId()`, `stream()` now rejects it; create the conversation first. Pass a `userId` taken from the authenticated session, never from a request parameter. The README's Authorization section and End-to-End example (which now includes the `getPendingInterrupts` and `resume` handlers) show this.
