---
"@aws-blocks/bb-agent": minor
---

fix(bb-agent): check conversation ownership in `stream()`, `resume()`, and `getPendingInterrupts()`

`stream()` and `resume()` accepted any `conversationId` alongside a `userId` and never checked that the conversation belonged to that user. A caller who knew another user's conversation ID could add turns to it, or approve (and `trust`) that user's pending tool call, which then ran with the agent's IAM role.

- **`stream()` and `resume()`** now throw `AgentErrors.ConversationNotFound` unless `options.conversationId` was created by `createConversationId(userId)` for the same `options.userId`. The check runs before anything is persisted or dispatched. Agents with `inferenceOnly: true` are unaffected.
- **`getPendingInterrupts(conversationId, userId)`** now requires the caller's `userId` and returns `[]` for a conversation that user doesn't own. **Breaking:** add the `userId` argument at each call site.

If you pass a `conversationId` that was never created with `createConversationId()`, `stream()` now rejects it; create the conversation first. Pass a `userId` taken from the authenticated session, never from a request parameter. The README's Authorization section and End-to-End example now show this.
