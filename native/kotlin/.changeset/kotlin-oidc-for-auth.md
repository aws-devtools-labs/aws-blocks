---
"aws-blocks-kotlin": minor
---

Add `OidcClient.forAuth(blocksClient, providers, relayTo)`, which builds the OIDC sign-in client
for an AWS Blocks `Auth` block from its fixed `/aws-blocks/auth/*` routes. `Auth` has no
`getClient()` method to fetch a descriptor from, so apps that move from `AuthOIDC` to `Auth`
construct the client with this instead. Pass `callbackPath` and `signOutPath` if the backend
changes `redirects.callbackPath` or `redirects.signOutPath`; the other routes are found in the
directory of `callbackPath`, as the backend serves them. Both must be paths under
`/aws-blocks/auth/`, which the backend also requires, or `forAuth` throws. `relayTo` may be left
empty on the desktop (JVM), which relays to a loopback address of its own; elsewhere `signIn`
then throws, naming the missing setting. The client is an `OidcClient<AnyProvider>`, since its
providers are the ids you pass rather than names a spec declared, so it signs in by id:
`oidc.signIn("google")`, with `com.aws.blocks.kotlin.oidc.signIn` imported.

The OIDC routes are resolved against the server URL cut at its first path segment that is exactly
`aws-blocks`. A host or a segment that only begins with `aws-blocks` (`aws-blocks.example.com`,
`/aws-blocks-staging/`) no longer cuts the URL short.
