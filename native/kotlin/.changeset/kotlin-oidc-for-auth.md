---
"aws-blocks-kotlin": minor
---

Add `OidcClient.forAuth(blocksClient, providers, relayTo)`, which builds the OIDC sign-in client
for an AWS Blocks `Auth` block from its fixed `/aws-blocks/auth/*` routes. `Auth` has no
`getClient()` method to fetch a descriptor from, so apps that move from `AuthOIDC` to `Auth`
construct the client with this instead. Pass `basePath` if the backend changes
`redirects.callbackPath`.
