---
"aws-blocks-swift": patch
---

fix(swift): sign in at the routes the OIDC client descriptor names

`OIDCClient.fromJSON`, and a client decoded from an `oidc/client` descriptor, now keep the
descriptor's `callbackPath` and `authorizeParamsBasePath`, exposed as the client's `callbackPath`
and `authorizeParamsBasePath`. `signIn` requests authorize-params under that path and sends that
callback as the identity provider's `redirect_uri`, so an `Auth` block with a custom
`redirects.callbackPath` (such as `/aws-blocks/auth/sso/return`) signs in at its own routes. Both
were rebuilt from `exchangePath` before, which sent the wrong `redirect_uri` for such a block. A
descriptor without them still derives them from `exchangePath`. The provider id in the
authorize-params path is now percent-encoded the way the server encodes it.

`exchange` now refuses a provider the client wasn't built with, throwing `OIDCError.unknownProvider`
before any request, as `signIn` already did. Raw routes are requested at the client URL cut before
its first `aws-blocks` path segment; a URL with no such segment now drops its trailing `/`.
