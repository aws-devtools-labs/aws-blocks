---
"aws-blocks-swift": minor
---

feat(swift): add `OIDCClient.forAuth` for the `Auth` block's federated sign-in

`OIDCClient.forAuth(client: blocks.client, providers: ["google"], relayTo: "myapp://auth")`
returns a client for the `Auth` block on the app's own `BlocksClient`, so it shares the app's
`URLSession`, cookies and token store. Its routes are derived as the server derives them: the base
is `callbackPath` up to its last `/`, and authorize-params, exchange and refresh sit under it. Pass
`callbackPath:` and `signOutPath:` when the backend sets `redirects.callbackPath` or
`redirects.signOutPath`. Both must start with `/aws-blocks/auth/`. A client built this way signs in
with `signIn(provider:launcher:)`, which uses the `relayTo` it was built with and throws
`OIDCConfigurationError` when there is none.

Raw routes are requested at the client URL cut before its first `aws-blocks` path segment, which
keeps an API Gateway stage prefix. A URL with no such segment now drops its trailing `/`.

`OIDCClient.exchange` now refuses a provider the client wasn't built with, throwing
`OIDCError.unknownProvider` before any request, as `signIn` already did.
