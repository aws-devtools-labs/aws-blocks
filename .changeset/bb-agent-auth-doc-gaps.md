---
"@aws-blocks/bb-agent": patch
"@aws-blocks/bb-auth-basic": patch
---

docs(bb-agent,bb-auth-basic): document conversation naming and same-origin cookies under Hosting

Two documentation gaps a builder had to infer from source:

- **bb-agent — conversation records and naming.** The README now documents the
  `Conversation` shape returned by `listConversations()` and states that
  `createConversationId()` sets `name` to the conversation's UUID, that the
  agent does not derive a human-readable title (the first user message does not
  become one), and that there is no public API to set or rename `name`. Builders
  who want a readable title should keep that mapping in their own data layer and
  treat `conversationId` as the stable key.

- **bb-auth-basic — same-origin cookies under the Hosting block.** The "Cookies
  and sessions" section now states plainly that serving the frontend through the
  Hosting block puts the static site and the API behind one CloudFront origin,
  so the deployed app is same-origin and the `SameSite=Lax` default works with
  `crossDomain` left at `false` — `crossDomain: true` is only for genuinely
  different registrable domains in production.

Documentation only — no runtime or API change.
