---
"aws-blocks-swift": patch
---

fix(swift): store a correct token expiry and send the provider on OIDC refresh

When a backend returns bearer tokens, `OIDCClient` now stores their expiry as now plus `expiresIn`
seconds, in epoch milliseconds, on both the code exchange and refresh. It stored the raw seconds on
exchange and `0` on refresh, so a token always read as expired. Refresh still reads `expiresAt` when
a response has no `expiresIn`. The client also stores the provider it signed in with and sends it on
refresh, which a backend with two or more providers requires, and keeps the rotated refresh token.
