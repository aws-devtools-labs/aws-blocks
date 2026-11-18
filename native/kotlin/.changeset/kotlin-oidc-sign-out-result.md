---
"aws-blocks-kotlin": minor
---

**Behaviour change (pre-1.0):** `OidcClient.signOut()` now throws when the backend refuses the
sign-out, where it used to ignore the response and report signed out. Wrap calls that relied on it
always succeeding.

`OidcClient.signOut()` now returns the identity provider's logout URL (`String?`), which an app can
open to end the provider's own session. It asks the backend for JSON (`?format=json`). A refusal
the backend explains throws `ApiException` with its `status` and `name`; a 503 named
`SignOutIncompleteException` (`e.isBlocksError("SignOutIncompleteException")`) means the cookie was
cleared but the backend's session was not removed. A request that never completes, or a refusal
with no explanation (a gateway's own page), throws `TransportException`. Whenever the request is
made, `authState` is set to signed out first, so a failure throws only after the user is signed
out locally; a call cancelled before any response changes nothing. Sign-out removes only this
block's cookie: the one the backend clears, and, when the backend names it in the descriptor
(`sessionCookieName`), that cookie on a failed sign-out too. Other `Auth` blocks sharing the cookie
jar stay signed in.
