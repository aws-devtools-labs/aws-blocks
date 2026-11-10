---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": patch
---

`AuthOIDC` sign-out now reports when the server-side session could not be invalidated. Previously, if deleting the session row failed (for example a transient session-store error), sign-out logged a warning and reported success, and the refresh token was not revoked at the IdP.

Sign-out now clears the session cookies first, then reads the session row before deleting it, and still revokes the refresh token at the IdP when it can. If the row delete fails, or the cookie-signing secret cannot be resolved to identify the session (for example a transient SSM error), it reports the new `AuthOIDCErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503) instead of success:

- `POST /aws-blocks/auth/signout` returns `503` with `{ "error", "name" }` instead of `204`.
- `auth.signOut(ctx)` rejects with that error; `setAuthState({ action: 'signOut' })` returns a signed-out state with `errorName: 'SignOutIncompleteException'`.
- The browser client's `signOut()` now checks the response status: on a failed sign-out it rejects with an `ApiError` carrying the server's `status` and `name`, and does not broadcast to other tabs or reload the page. For `SignOutIncompleteException`, whose response already cleared the cookie, it first clears its last-known user and notifies `onAuthStateChange` listeners with `null`; other failures leave the signed-in state alone.

How long a leftover session keeps authenticating depends on the upstream revocation: until its current access token expires when the IdP revoked the refresh token, otherwise for as long as the refresh token keeps working, at most until the session cookie expires 30 days after sign-in. The README's session-management section lists when revocation is skipped.

The error message is generic; the underlying store error is logged server-side only. A failed session read no longer skips the delete. The umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-oidc` docs it mirrors have changed.
