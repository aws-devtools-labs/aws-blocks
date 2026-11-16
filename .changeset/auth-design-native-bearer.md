---
"@aws-blocks/bb-auth": patch
---

docs(bb-auth): correct what `DESIGN.md` says about bearer tokens and the native SDKs

The native SDKs (Dart, Swift, Kotlin) sign in through the relay and use the session cookie, and identities federated through the Cognito hosted UI never get tokens from `/exchange`. The native compatibility note now lists the exchange body's `tokens` flag, the JSON sign-out and the session route the SDKs' OIDC clients use. The README's bearer note now says that a hand-written native or CLI client can send bearer tokens, while the AWS Blocks native SDKs use the session cookie.
