---
"@aws-blocks/bb-auth": patch
---

docs(bb-auth): the native SDKs authenticate with the session cookie, not bearer tokens

`DESIGN.md` and the README say how the native SDKs (Dart, Swift, Kotlin) authenticate: they sign in through the relay and keep the session cookie `/exchange` sets. Their OIDC clients send `tokens: false`, so `/exchange` returns no tokens to them, even with `allowBearerAuth`. `Authorization: Bearer` is for a hand-written native or CLI client. Identities federated through the Cognito hosted UI never get tokens from `/exchange`. `DESIGN.md`'s route table lists the session route, the JSON and `503` sign-out answers, the `redirects.callbackPath` and `redirects.signOutPath` the routes are mounted on, and marks the stub IdP routes as local and sandbox only.
