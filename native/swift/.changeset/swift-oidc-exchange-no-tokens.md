---
"aws-blocks-swift": minor
---

fix(swift)!: ask the server for no bearer tokens on the OIDC code exchange

**Breaking (pre-1.0):** `OIDCClient` signs in with a session cookie, so its code exchange now sends
`tokens: false`, and a backend with bearer auth enabled no longer mints access and refresh tokens
for it. After a sign-in, `getAccessToken()` returns `nil`: before, a directly federated sign-in on a
backend with `allowBearerAuth` gave it a token, which an app could send as a bearer token. Requests
through the generated client carry the session cookie instead, and `restore()` reads it on launch.
`refresh()` and `onAuthFailure()` have no refresh token to use, so they send nothing and leave the
signed-in state alone.
