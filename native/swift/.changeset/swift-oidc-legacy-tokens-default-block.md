---
"aws-blocks-swift": patch
---

fix(swift): move the unscoped 0.x OIDC tokens only into the default `Auth` block's client

A 0.x version stored OIDC tokens under unscoped keys, for the `Auth` block's default routes. Before,
the first `OIDCClient` on a `BlocksClient` to touch the token store took them, so a client for a
second block (such as one on `/aws-blocks/auth/sso/*`) could take the default block's session. Now
only a client whose `exchangePath` is `/aws-blocks/auth/exchange` takes them; a client for any other
block leaves them in place.
