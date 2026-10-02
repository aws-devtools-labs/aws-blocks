---
"@aws-blocks/bb-agent": minor
---

fix(bb-agent): `/client` now exports the discriminated-union `ChatMessage` (BREAKING shape change — flagged for maintainer review)

`@aws-blocks/bb-agent/client` previously shipped its own **flat** `ChatMessage`
(`metadata?: Record<string, any>`), which shadowed the discriminated union
`createChat` uses. `/client` now re-exports that union (and `ApprovalMetadata`)
from the canonical definition, so the two surfaces agree and the behaviour the
README documents is real at the `/client` entry point.

**Breaking (type-level) for `/client` consumers of `ChatMessage`:**

- `metadata` is no longer `Record<string, any>`. On a `user`/`assistant`
  message it is `Record<string, JSONValue> | undefined`; on an `approval`
  message, narrowing on `role === 'approval'` types it as `ApprovalMetadata`.
- Code that only reads `id` / `role` / `content` is unaffected. Code that read
  an arbitrary `metadata.<key>` as `any` on an approval message must now narrow
  by `role` first (`if (m.role === 'approval') m.metadata?.approved`). This is
  the no-cast DX the union was introduced for.

**Runtime behaviour change on the deprecated `useChat` hook:**

- `useChat.loadConversation` now projects history through the same metadata
  narrow `createChat.loadConversation` uses: non-object metadata (null, a
  string, an array) on a `user`/`assistant` row now projects to `undefined`
  rather than passing straight through, and an `approval` row's metadata is
  projected into the typed `ApprovalMetadata`. A consumer that relied on a
  non-object `metadata` value surviving on a user/assistant message should read
  the new behaviour here.

Also tightens `UseChatOptions.api.getConversation`'s return `metadata` to
`unknown` (from `Record<string, any>`), aligning the deprecated hook's adapter
shape with `createChat`'s `ChatConversationApi`. This widens what an adapter may
return, so it is not breaking for existing adapters.
