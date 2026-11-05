---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

`AuthCognito` now refreshes sessions consistently when requests overlap, and ends a session only when Cognito rejects its refresh token.

- A token refresh that completes after `signOut()` no longer restores the session. Refreshed tokens are written only if the session still holds the record that request read. Otherwise nothing is written and the response clears the session cookie.
- When several requests refresh the same session at once, a request whose own refresh fails or loses the write is served the session another request already refreshed. It no longer deletes or overwrites that session.
- A failed refresh ends the session (record deleted, cookie cleared) only on `NotAuthorizedException` (refresh token expired or revoked, user disabled) or `UserNotFoundException`. On throttling, network or other service errors, that request is unauthenticated but the session is kept, so the next request retries. Previously any refresh error ended the session.
- An access token now counts as expired from the instant the clock reaches its `exp` claim, in both the AWS runtime and the local mock. Previously it was still accepted at exactly `exp`.

The internal `SessionStore` gains `replaceSession()` and `deleteSessionIfUnchanged()`, both conditional on the record the caller read. `updateSession()` no longer recreates a session that is deleted while it runs.
