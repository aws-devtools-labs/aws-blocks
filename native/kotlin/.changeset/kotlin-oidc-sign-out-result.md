---
"aws-blocks-kotlin": minor
---

`OidcClient.signOut()` now returns the identity provider's logout URL (`String?`), which an app
can open to end the provider's own session. It asks the backend for JSON (`?format=json`) and
throws `OidcSignOutException` when the backend answers with a failure status, where it used to
ignore the response and report signed out. Whether or not the backend accepts it, `authState` is set to signed out first, so a failure
throws only after the user is signed out locally. A 503 named `SignOutIncompleteException` means
the cookie was cleared but the backend's session was not removed. Sign-out removes only this block's cookie: the one the backend clears, and, when the backend
names it in the descriptor (`sessionCookieName`), that cookie on a failed sign-out too. Other
`Auth` blocks sharing the cookie jar stay signed in.
