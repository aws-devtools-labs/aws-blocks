---
"@aws-blocks/create-blocks-app": patch
---

test(auth-oidc): new OIDC template with a stub-IdP sign-in e2e

Adds an `auth-oidc` template that signs in through an OpenID Connect provider.
Locally it uses the in-process `stubIdp` (real RS256 tokens, no credentials), so
the shipped e2e drives the full authorize → callback → session flow over HTTP
and asserts a `requireAuth`-gated call then succeeds. This takes the daily canary
to 14/20 Building Blocks (AuthOIDC, after DistributedDatabase reached 13).
