---
"@aws-blocks/bb-realtime": minor
"@aws-blocks/blocks": minor
"@aws-blocks/bb-agent": patch
"@aws-blocks/create-blocks-app": patch
---

feat(bb-realtime): add `getChannel(namespace, channel, { scope: 'exact' })` and validate channel names

A channel handle's token authorizes its channel and every `/`-separated sub-channel under it, so a handle for `tenants/acme` also opens `tenants/acme/billing`. This was not documented, so a naming scheme that nests one principal's channels under another's could hand out more access than intended.

- **`getChannel()` takes an optional `{ scope }`.** `'subtree'` is the default and keeps today's behaviour. `{ scope: 'exact' }` mints a token that authorizes the channel only; a subscribe to any sub-channel with it is rejected. `GetChannelOptions` is exported from `@aws-blocks/bb-realtime` and `@aws-blocks/blocks`.
- **Tokens stay compatible.** The default token is byte-for-byte the format issued before, so tokens from an older deployment keep validating with the same scope. An exact token carries its channel under a new `exact` key instead of `channel`, so a deployment from before this release refuses it (the handle stops working) rather than granting it sub-channel access, for example on a warm container during an update or after a rollback. Native clients pass tokens through unchanged.
- **Channel names are validated.** `publish()`, `subscribe()` and `getChannel()` now throw `RealtimeErrors.ValidationFailed` for a channel name that is empty, starts or ends with `/`, contains an empty segment (`a//b`), or has a `.` or `..` segment, and for a channel that isn't a string or a number (`undefined`, `null`, an object). `/` between non-empty segments is still allowed, and a number is validated as its string form. If your app builds channel names from user input, check that the result can't be empty or contain these segments.
- **bb-agent `stream()` and `resume()`** throw `AgentErrors.InvalidUsage` before dispatching a turn when the `channelId` and `userId` don't form a valid channel name (for example a `channelId` of `a//b` or a `userId` of `..`), instead of returning a stream whose chunks all fail to publish.
- **The `default` and `react` create-blocks-app templates** pass `encodeURIComponent(user.username)` as the channel name, so a username can't add `/` segments.
- **Server-side `subscribe()`** now uses an exact token for its own WebSocket subscription; it only ever subscribes to that one channel, so nothing changes for callers.

The README's new "Sub-channels and access" section explains how a channel name maps to access, with the per-tenant pitfall as the example. Use `{ scope: 'exact' }` whenever a sub-channel of a handle's channel can belong to someone else.
