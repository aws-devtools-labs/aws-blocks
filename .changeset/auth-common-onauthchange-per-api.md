---
"@aws-blocks/auth-common": patch
"@aws-blocks/core": patch
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

Auth broadcasts are tagged per API, so `onAuthChange` for one API no longer receives another API's user. With two auth blocks on one page, signing in to one no longer hands its user to the other's listener (typed as the other's user), in this window or in another tab, and the other block's store no longer refetches.

`submitAuthAction` tags its sign-in and sign-out messages with the RPC namespace of the API it ran on (a generated client now answers `Symbol.for('aws-blocks.apiNamespace')` with it), and `broadcastAuthChange(user, api)` takes an optional `api` to do the same. An untagged message still reaches every API's listeners: `broadcastAuthChange(user)` without an `api`, and a message from a tab running an older `@aws-blocks/auth-common`. An API that is not a generated client (a hand-written `AuthStateApi`) has no namespace: `submitAuthAction` on it sends untagged broadcasts, and its listeners and store receive every message, tagged or untagged. The message format (the `blocks-auth` channel and the `blocks-auth-change` window event, `{ type: 'auth-change', user }`) only gains the optional `api` field, so tabs running an older bundle keep working.
