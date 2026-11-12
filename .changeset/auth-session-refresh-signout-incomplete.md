---
'@aws-blocks/bb-auth': patch
'@aws-blocks/auth-common': minor
'@aws-blocks/blocks': patch
---

`Auth` refreshes a session consistently when requests overlap, and reports a sign-out that could not invalidate the server-side session.

- **Session refresh.** Several requests can refresh one session at once (parallel calls when its access token expires, possibly on different Lambda instances), and `signOut()` can delete it mid-refresh. Both refresh writes are now conditional on the session row the request read. A refresh that completes after `signOut()` no longer restores the session: nothing is written and the cookie is cleared. A request whose own refresh is rejected, or whose write loses to a concurrent refresh, is served the session that refresh wrote, instead of deleting or overwriting it.
- **Sign-out.** `signOut()` clears the session cookie first, so the device is signed out whatever happens next. If the session row can't then be deleted (a transient session-store failure), or the session secret can't be resolved to identify it, it reports the new `AuthErrors.SignOutIncomplete` (`SignOutIncompleteException`, 503) instead of success, because a copy of the cookie keeps authenticating until the session ends on its own: `auth.signOut(ctx)` rejects with it, `setAuthState({ action: 'signOut' })` returns a signed-out state with `errorName: 'SignOutIncompleteException'`, and `POST /aws-blocks/auth/signout` answers `503 { error, name }` to an API client (a browser form still lands on `postSignOutPath`). The browser redirect client's `signOut()` rejects with that `ApiError`. A failed session read no longer stops the delete; it only skips `onSignOut` and the upstream sign-out. The store error is logged server-side, never sent.
- `@aws-blocks/auth-common` adds `SignOutIncomplete` to `AuthErrors`.
