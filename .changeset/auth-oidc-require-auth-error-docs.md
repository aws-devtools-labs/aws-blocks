---
'@aws-blocks/bb-auth-oidc': patch
---

Correct the `requireAuth()` docs: it reports a missing or expired session, including one whose refresh failed, as `NotAuthenticated` and never throws `TokenExpired`. The `AuthOIDCErrors` example now checks `NotAuthenticated`, and the README says that `TokenExpired` comes only from the bearer-token refresh route `POST /aws-blocks/auth/refresh`.
