---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

`AuthCognito` now refreshes sessions consistently when requests overlap, and ends a session only when a refresh can't succeed by being retried.

- A token refresh that completes after `signOut()` no longer restores the session. Refreshed tokens are written only if the session still holds the record that request read. Otherwise nothing is written and the response clears the session cookie.
- When several requests refresh the same session at once, a request whose own refresh is rejected or loses the write is served the session another request already refreshed. It no longer deletes or overwrites that session.
- A failed refresh ends the session (record deleted, cookie cleared) only when retrying can't fix it: `NotAuthorizedException` (refresh token expired or revoked, user disabled), `UserNotFoundException`, or a pool config that rules the refresh out (`ResourceNotFoundException`, `UnsupportedOperationException`, `InvalidUserPoolConfigurationException`). On throttling, network or other service errors, that request is unauthenticated but the session is kept, so the next request retries. Previously any refresh error ended the session.
- In the local mock, a request that reads an expired session which a concurrent `fetchAuthSession({ forceRefresh: true })` has just replaced is now served the newer session, as in the AWS runtime. Previously it answered as signed out.
- An access token now counts as expired from the instant the clock reaches its `exp` claim, in both the AWS runtime and the local mock. Previously it was still accepted at exactly `exp`.

The internal `SessionStore` gains `replaceSession()` and `deleteSessionIfUnchanged()`, both conditional on the record the caller read. `updateSession()` no longer recreates a session that is deleted while it runs.
