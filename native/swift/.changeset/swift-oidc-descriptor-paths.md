---
"aws-blocks-swift": patch
---

`OIDCClient(...)` takes the `callbackPath` and `authorizeParamsBasePath` to sign in through

A client built with `init` rebuilt both paths from `exchangePath` by replacing `/exchange`, so the IdP's `redirect_uri` was right only when the backend's callback ended in `/callback`. For an `Auth` block with `redirects.callbackPath: '/aws-blocks/auth/partner/return'` it sent `<base>/callback`, which isn't served or registered with the IdP. `init` now takes optional `authorizeParamsBasePath` and `callbackPath` arguments, the paths a client hydrated from the `oidc/client` descriptor already reads from it, and falls back to the derived ones when they're omitted, so existing calls are unchanged.
