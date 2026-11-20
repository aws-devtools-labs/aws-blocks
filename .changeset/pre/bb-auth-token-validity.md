---
"@aws-cdk-blocks/bb-auth": minor
---

feat(bb-auth): explicit token lifetimes and refresh-token rotation on the app clients, and a 30-day default session

`Auth` now sets `AccessTokenValidity`, `IdTokenValidity` and `RefreshTokenValidity` on both app clients (1 hour, 1 hour, and the session lifetime) and turns on refresh-token rotation with a 10-second grace period. The default `session.ttlSeconds` drops from 400 days to 30 days. Each is an option under `session`: `ttlSeconds`, `accessTokenValiditySeconds`, `idTokenValiditySeconds`, `refreshTokenValiditySeconds` and `refreshTokenRotation`.

Cognito refuses `REFRESH_TOKEN_AUTH` on a client with rotation on, so the clients no longer list `ALLOW_REFRESH_TOKEN_AUTH` and the block refreshes with `GetTokensFromRefreshToken`, which works for existing sessions. The client changes deploy as in-place updates. An app that refreshes against the same client with `REFRESH_TOKEN_AUTH` itself should switch to `GetTokensFromRefreshToken` or set `session.refreshTokenRotation: false`.
