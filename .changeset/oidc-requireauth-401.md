---
"@aws-blocks/bb-auth-oidc": patch
"@aws-blocks/blocks": patch
---

Make AuthOIDC `requireAuth()` throw `ApiError(401, NotAuthenticatedException)` so the documented `handle401()` 401-redirect pattern works for a signed-out protected call.

Previously `requireAuth()` threw a bare `Error` with no `status`. Over the JSON-RPC boundary `errorResponseFromCatch` serializes a non-`ApiError` as code `500`, so the client received an `ApiError` with `status === 500`. The README's `if (handle401(e, provider)) return;` helper only acts on `err instanceof ApiError && err.status === 401`, so it never matched and the app never redirected to sign-in — the error just surfaced. This aligns AuthOIDC with AuthCognito, whose `requireAuth()` already throws `ApiError(401, …)`. The error name is preserved, so existing `isBlocksError(e, AuthOIDCErrors.NotAuthenticated)` checks are unaffected.
