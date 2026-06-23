---
"@aws-blocks/core": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/bb-auth-cognito": patch
---

fix(auth): propagate the structured error name through `setAuthState()`

The recommended client auth path is `createApi()` → `setAuthState()`. When an
action failed, `setAuthState()` caught the thrown `ApiError` and returned an
`AuthState` carrying only `error: e.message`, discarding the structured
`e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
field for an error name, a hand-rolled client could not branch on error type
(e.g. "try sign-in, fall back to sign-up for a brand-new user") without
brittle string-matching the human-facing message.

`AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
`bb-auth-cognito` `setAuthState` implementations populate it from the thrown
`ApiError.name` (skipping the generic `'ApiError'` default). A new
`hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
branch on the returned state — `isBlocksError` only matches thrown `Error`
instances, so it cannot be used on the plain `AuthState` object. Rule of
thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.
