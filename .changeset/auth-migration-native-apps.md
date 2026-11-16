---
"@aws-blocks/bb-auth": patch
---

docs(bb-auth): add a "Native apps (Dart, Swift, Kotlin)" section to the migration guide

A native app exports both `auth.createApi()` (the sign-in state machine) and `auth.createOidcApi()` (whose `getClient()` returns its OIDC client), renders its federated sign-in buttons from the typed `providers` of that client and calls `signIn(provider)` on it (not the `signIn:<id>` actions' browser URLs), uses the state machine for everything else, keeps its `relayTo` in `redirects.allowedRelayOrigins`, and calls `getAuthState()` on launch. A block with providers also serves `GET /aws-blocks/auth/session` to restore a federated session. The codemod's `getClient()` TODOs now point native apps at that section, and it leaves a TODO on an `AuthOIDC` block's `createApi()` export saying native apps also need `createOidcApi()`.
