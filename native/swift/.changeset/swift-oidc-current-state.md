---
"aws-blocks-swift": minor
---

feat(swift): add `OIDCClient.authState`

`OIDCClient` now has `public private(set) var authState: OIDCAuthState`, the state most recently
emitted to `authStateChanges()` subscribers, or `.loading` before the first one. It is
actor-isolated like the client's other state, so read it with `await client.authState`. An app
can check the state once, such as on launch after `restore()`, without subscribing to a stream.
This matches Kotlin's `authState.value`.
