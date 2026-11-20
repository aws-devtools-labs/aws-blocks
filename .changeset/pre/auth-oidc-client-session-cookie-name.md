---
"@aws-cdk-blocks/bb-auth": patch
"aws-cdk-blocks": patch
---

feat(bb-auth): name the session cookie in the `oidc/client` descriptor

`createOidcApi().getClient()` now also sends `sessionCookieName`, the name of the session cookie this block's `/exchange` sets (`auth_<fullId>`). A native client that signs out locally after a failed sign-out can remove only that block's cookie, so a second `Auth` block's session survives. The field is optional in `OidcClientDescriptor`, so clients that don't read it are unaffected.
