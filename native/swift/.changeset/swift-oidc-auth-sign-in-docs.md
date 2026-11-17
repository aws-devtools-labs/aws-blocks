---
"aws-blocks-swift": patch
---

docs(swift): document the `Auth` sign-in flow

The README has a new "Using `Auth`" section with the whole flow: exporting `createOidcApi()`,
reading the state on launch, rendering one federated sign-in button per provider in the client's
`providers` and signing in through `oidc.signIn(provider:)`, running every other action through
`setAuthState`, signing a federated user out through the OIDC client and opening the logout URL,
disabling unavailable actions, hiding passkey actions, and preferring a Universal Link for `relayTo`.
