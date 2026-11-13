---
"aws-blocks-kotlin": minor
---

**Behaviour change (pre-1.0):** `OidcClient.signOut()` can now throw. Wrap calls that relied on it
always reporting signed out.

`OidcClient.signOut()` now returns the identity provider's logout URL (`String?`), which an app
can open to end the provider's own session. It asks the backend for JSON (`?format=json`) and
throws `OidcSignOutException` when the backend answers with a failure status, where it used to
ignore the response and report signed out. A 503 named `SignOutIncompleteException` (the cookie
was cleared but the backend's session was not removed) sets `authState` to signed out before it
throws; any other failure leaves `authState` unchanged. Sign-out removes only the cookie the
backend clears, so other `Auth` blocks sharing the cookie jar stay signed in.
