---
"@aws-blocks/bb-auth": patch
---

docs(bb-auth): add a "Native apps (Dart, Swift, Kotlin)" section to the migration guide

A native app that called `getClient()` builds its OIDC client with `OidcClient.forAuth(...)` instead, signs in with a provider id rather than opening a `signIn:<id>` action's browser URL, keeps its `relayTo` in `redirects.allowedRelayOrigins`, and restores the session on launch through `GET /aws-blocks/auth/session`. The codemod's `getClient()` TODOs now point native apps at that section.
