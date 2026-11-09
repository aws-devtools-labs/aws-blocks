---
"@aws-blocks/bb-realtime": minor
"@aws-blocks/blocks": minor
---

feat(bb-realtime): add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names

A channel handle's token authorizes its channel and every `/`-separated sub-channel under it, so a handle for `tenants/acme` also opens `tenants/acme/billing`. This was not documented, so a naming scheme that nests one principal's channels under another's could hand out more access than intended.

- **`getChannel()` takes an optional `{ scope }`.** `'subtree'` is the default and keeps today's behaviour. `{ scope: 'exact' }` mints a token that authorizes the channel only; a subscribe to any sub-channel with it is rejected. `GetChannelOptions` is exported from `@aws-blocks/bb-realtime` and `@aws-blocks/blocks`.
- **Tokens stay compatible.** The default token is byte-for-byte the format issued before, so tokens from an older deployment keep validating with the same scope. An exact token adds `"scope": "exact"` to its signed payload. Native clients pass tokens through unchanged.
- **Channel names are validated.** `publish()`, `subscribe()` and `getChannel()` now throw `RealtimeErrors.ValidationFailed` for a channel name that is empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment. `/` between non-empty segments is still allowed. If your app builds channel names from user input, check that the result can't be empty or contain these segments.
- **Server-side `subscribe()`** now uses an exact token for its own WebSocket subscription; it only ever subscribes to that one channel, so nothing changes for callers.

The README's new "Sub-channels and access" section explains how a channel name maps to access, with the per-tenant pitfall as the example. Use `{ scope: 'exact' }` whenever a sub-channel of a handle's channel can belong to someone else.
