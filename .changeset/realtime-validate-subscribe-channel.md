---
"@aws-blocks/bb-realtime": patch
---

The WebSocket handler (deployed and local dev) now checks the channel in `subscribe` and `unsubscribe` messages before using it. It must be a channel path of the form `getChannel()` returns (`<instance>/<namespace>/<channel>`, at most 1024 bytes); otherwise a subscribe gets `{ type: 'error', message: 'Invalid channel' }` and an unsubscribe is ignored. A subscribe also requires a channel token: the connect token only authorizes opening the connection, as documented. A subscribe without a token (or with a token that isn't a string) now gets `{ type: 'error', channel, message: 'Unauthorized: missing token' }` from the deployed handler too, as it already did in local dev. Channel handles returned by `getChannel()` are unaffected.
