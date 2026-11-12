---
"aws-blocks-swift": patch
---

fix(swift): ask the server for no bearer tokens on the OIDC code exchange

`OIDCClient` signs in with a session cookie, so its code exchange now sends `tokens: false`, and a
backend with bearer auth enabled no longer mints access and refresh tokens the client doesn't use.
