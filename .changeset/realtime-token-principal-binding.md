---
"@aws-blocks/bb-realtime": minor
"@aws-blocks/blocks": minor
---

feat(bb-realtime): bind channel handles to the signed-in user, re-check subscriptions on ping, and add `revokeAccess()`

- **`getChannel(namespace, channel, { principal })`** takes the signed-in user's id (at most 256 characters) and signs it into the handle's connect and channel tokens. The server accepts a channel token only on a connection opened with a connect token for the same user, on every subscribe and resubscribe. A handle without `principal` works as before for any holder. Pass the session's user id (`user.userSub`) for every channel that belongs to a user. The client keeps one socket per endpoint and user.
- **Subscriptions are re-checked on every keep-alive ping.** The subscription record keeps the token's expiry, issue time, id and principal. A subscription ends, and the client is sent an error frame with a `code` (`token_expired`, `principal_mismatch` or `access_revoked`), when its token has expired, its principal no longer matches the connection's, or access was revoked. A channel subscribed with `refresh` renews an expired token in place, without `onDisconnect`; other ended subscriptions report `onDisconnect('error')`. Previously a subscription stayed live for as long as the connection kept pinging.
- **`rt.revokeAccess(principal)`** (new) refuses every handle minted for that user before the call, on connect and subscribe at once and on open subscriptions at the connection's next ping (within about 9 minutes). It stores a short-lived record in the existing connections table; no new resource is added. Handles minted after the call work.
- **Breaking: token format.** Tokens now carry `iat` and `jti` (and `sub` with a principal), and tokens without them are refused. Handles issued before the upgrade stop working; clients that pass `refresh` recover on their next reconnect, others must call your API method again.
- A channel path with an empty, `.` or `..` segment sent over the WebSocket is now rejected with `Invalid channel`, as `getChannel()` already rejects such names.
- The README and DESIGN document that API Gateway throttles WebSocket traffic per stage and that there is no per-connection limit.
