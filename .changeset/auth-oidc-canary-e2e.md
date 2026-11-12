---
"@aws-blocks/create-blocks-app": patch
---

New `auth-oidc` template: sign-in through an OpenID Connect provider with `Auth`'s `store: 'builtin'`, so your backend verifies each sign-in and no Cognito user pool is created. Locally and on sandboxes it signs in through `stubIdp()`, and production uses a `type: 'oidc'` entry you point at your own provider.

Its e2e drives the full authorize → callback → session flow over HTTP and checks that a `requireAuth`-gated call then succeeds.
