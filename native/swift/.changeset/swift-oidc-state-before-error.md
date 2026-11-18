---
"aws-blocks-swift": patch
---

fix(swift): check the relayed state before reporting an identity provider error

`OIDCClient.signIn` now checks that the relay carries the state its sign-in was given, and that the
state's envelope carries this sign-in's csrf, before it reads `error` from the callback. A callback
with an `error` but a missing or different state, or another sign-in's csrf, throws
`OIDCError.stateMismatch` instead of `callbackError` with the callback's text, so only the backend's
relay for this sign-in can report a provider error.
