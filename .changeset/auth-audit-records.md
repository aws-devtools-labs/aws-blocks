---
"@aws-blocks/bb-auth": minor
"@aws-blocks/blocks": patch
---

`Auth` can now write an audit record for each session lifecycle event. Set `audit: true` and every session issued, failed sign-in, sign-out and session revocation (after a password reset, `admin.revokeUserSessions` or `deleteUser`) writes one JSON log line, with the event name as the message and `AuthAuditRecord` fields: the block, provider, user `sub`, outcome, and a reason or error name. A metric filter such as `{ $.event = "auth.signin.failed" }` turns them into an alarm.

The option is off by default. `audit: true` writes through its own `info` logger whatever `logger` is set to, or pass a logger to send the records there. Records never contain a password, code, token, session id or error message, and a logger error never changes a sign-in or sign-out result.
