---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": patch
---

`AuthOIDC` sign-out now reports when the server-side session could not be invalidated. Previously, if deleting the session row failed (for example a transient session-store error), sign-out logged a warning and reported success, and the refresh token was not revoked at the IdP.

Sign-out now reads the session row before deleting it, always clears the session cookies, and still revokes the refresh token at the IdP when it can. If the row delete fails, it reports the new `AuthOIDCErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503) instead of success:

- `POST /aws-blocks/auth/signout` returns `503` with `{ "error", "name" }` instead of `204`.
- `auth.signOut(ctx)` rejects with that error; `setAuthState({ action: 'signOut' })` returns a signed-out state with `errorName: 'SignOutIncompleteException'`.
- The browser client's `signOut()` now checks the response status: on a failed sign-out it rejects with an `ApiError` carrying the server's `status` and `name`, and does not notify listeners or reload the page.

The error message is generic; the underlying store error is logged server-side only. A failed session read no longer skips the delete. The umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-oidc` docs it mirrors have changed.
