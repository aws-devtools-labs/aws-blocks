---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth`'s signed-in user (`AuthenticatedUser`) has an optional `claims` field: the provider's verified claims for users of a `store: 'builtin'` block (an OIDC, OAuth 2.0 or stub IdP provider verified by your backend), as `AuthOIDC`'s user carried. `claims` is absent for user-pool users. `claims` is server-side only: `getAuthState()` and the sign-in routes never send it to the browser.
