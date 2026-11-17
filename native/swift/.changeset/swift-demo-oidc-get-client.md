---
"aws-blocks-swift": patch
---

docs(swift): sign the demo app in to federated providers through `getClient()`

The demo's account screen shows one sign-in button per provider of the OIDC client from its
backend's `createOidcApi().getClient()`, and signs in through `oidc.signIn(provider:)`. It doesn't
render the state's `signIn:<id>` actions. A federated user's `signOut` goes through `signOut()`,
opening the provider's logout URL. The demo fetches the client once and keeps it. Actions that carry
`unavailable` are disabled with the reason shown, and passkey actions are hidden.
