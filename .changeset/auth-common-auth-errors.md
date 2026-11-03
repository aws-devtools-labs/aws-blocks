---
'@aws-blocks/auth-common': minor
'@aws-blocks/blocks': minor
---

Add `AuthErrors`, the shared vocabulary of auth error names, with the `AuthErrorName` type and the `isAuthError()` / `isAuthErrorName()` guards. Match an auth failure by name with `isAuthError(e, AuthErrors.NotAuthenticated)` — it works the same on the server and in the browser, and an unknown or misspelled name is a compile error. `Auth` throws these names, as `AuthCognito` and `AuthOIDC` did. A sign-in provider that cannot sign anyone in (a configuration that is unusable at runtime, an unreachable provider, or a Cognito-federated provider under `npm run dev`) fails with `ProviderUnavailableException` (`AuthErrors.ProviderUnavailable`); the name reaches native clients as is.

The `BlocksAuth` `requireAuth` documentation now states the 401 error name correctly: `NotAuthenticatedException` (the removed `AuthBasic` threw `SessionExpiredException`).
