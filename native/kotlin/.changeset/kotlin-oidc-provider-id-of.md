---
"aws-blocks-kotlin": minor
---

Add `OidcClient.providerIdOf(actionName)`, which returns the provider id of an `Auth` block's
`signIn:<id>` action, or `null` for any other action. The README's new "Using Auth" section shows
the flow it serves: render the actions `getAuthState()` reports, submit plain ones through
`setAuthState`, and run a `signIn:<id>` or federated `signOut` action with a `url` through the OIDC
client.
