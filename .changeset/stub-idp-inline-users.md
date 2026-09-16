---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/blocks": patch
---

feat(auth-oidc): let `stubIdp()` declare test users inline

`stubIdp()` gains an optional `users?: StubUser[]`. Previously the stub IdP's
identity directory could only be seeded from a `users.json` file in the mock
data dir (with a single default user otherwise), so declaring test users meant
committing/gitignoring a data file. Inline `users` are now the authoritative
directory for the login screen and the `users` handed to `onAuthorize`, taking
precedence over `users.json` and the built-in default. Omitting it is unchanged
(file → default fallback), so existing apps and the AWS runtime are unaffected.
