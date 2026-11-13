---
"aws-blocks-swift": minor
---

feat(swift): add `OIDCClient.providerIdOf` and document the `Auth` sign-in flow

`OIDCClient.providerIdOf("signIn:google")` returns `"google"`, and `nil` for any other action name.
A native app that renders the `Auth` block's `getAuthState()` actions uses it to run a federated
`signIn:<id>` action through `OIDCClient.forAuth(...).signIn(provider:launcher:)` instead of
opening the action's `url`. The README has a new "Using `Auth`" section with the whole flow:
reading the state on launch, running plain actions through `setAuthState`, federated sign-in and
sign-out through the OIDC client, opening the logout URL, disabling unavailable actions, hiding
passkey actions, and preferring a Universal Link for `relayTo`.
`getClient()` and typed providers stay documented for custom blocks that return an `oidc/client`.
