---
"@aws-blocks/bb-agent": patch
---

fix(bb-agent): `/client` exports the discriminated-union `ChatMessage`, not a flat shadow

`@aws-blocks/bb-agent/client` (the `./client` export → `index.hooks.ts`) defined
its own flat `ChatMessage` (`metadata?: Record<string, any>`, `role` a plain
union) that **shadowed** the discriminated-union `ChatMessage` from `index.chat.ts`
added in #338. A `/client` consumer therefore got the flat type: narrowing on
`role === 'approval'` narrowed nothing and `metadata` was back to `any`, so the
type-safe `m.metadata?.approved` DX never reached customers and the shipped type
contradicted the README.

`/client` now re-exports the union `ChatMessage` (and `ApprovalMetadata`) from
`index.chat.js`. The deprecated `useChat` internals that built/consumed the flat
shape (approval-message construction, `loadConversation` projection) now apply the
same per-role handling as `createChat.loadConversation`, so an `approval` message
carries typed `ApprovalMetadata`. No runtime behavior change; this narrows a
previously-`any` client type (a type-only tightening on a deprecated hook).
