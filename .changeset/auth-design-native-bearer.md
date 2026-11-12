---
"@aws-blocks/bb-auth": patch
---

docs(bb-auth): correct what `DESIGN.md` says about bearer tokens and the native SDKs

The native SDKs (Dart, Swift, Kotlin) sign in through the relay and use the session cookie. Bearer tokens from the native SDKs aren't supported yet, and identities federated through the Cognito hosted UI never get tokens from `/exchange`. The native compatibility note now points at the SDKs' `OidcClient.forAuth` factories in place of `getClient()`.
