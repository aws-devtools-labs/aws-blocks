---
"@aws-blocks/bb-auth-oidc": minor
"@aws-blocks/core": minor
"@aws-blocks/blocks": minor
---

fix(bb-auth-oidc): `cognitoFederated()` registers the deployed app's callback and sign-out URLs on the Cognito app client

The Cognito app client used to register only an `https://localhost` placeholder, so Cognito's `/oauth2/authorize` answered `redirect_mismatch` for a deployed app before any identity provider was contacted. The app client now registers, resolved at synth:

- the app's public origin (`BLOCKS_PUBLIC_ORIGIN` — the CloudFront distribution, primary custom domain, HTTPS ALB or stacked door, or the managed `apiFrontDoor: 'cloudfront'` distribution) plus the callback path;
- the shared API Gateway URL (stage included) plus the callback path, used when no front door publishes a public origin;
- `http://localhost:3000` plus the callback path, in sandbox mode only.

Sign-out URLs list the same origins. Only an `https://` public origin is registered, since Cognito accepts `http://` only for `localhost`; a plain-`http://` one (an ALB door without a certificate) is left out and synth emits an `@aws-blocks/bb-auth-oidc:PlainHttpPublicOrigin` warning, because federated sign-in through that door needs HTTPS.

New `cognitoFederated()` options `additionalCallbackUrls` and `additionalLogoutUrls` register URLs that can't be derived at synth — browser PKCE SPA redirect pages, native-app custom schemes used as a direct sign-in redirect, custom-domain names other than the primary one, or a sandbox dev server on another port. Entries from every `cognitoFederated()` provider are merged and de-duplicated. Each entry is validated at synth, which fails with a descriptive error naming the URL and the option for an entry that isn't a well-formed redirect URL: surrounding whitespace or control characters, a backslash, userinfo (`@`) in the host, a missing, wildcard or non-ASCII host, a plain-`http://` URL whose host isn't `localhost`, a `javascript:`, `data:`, `file:` or `vbscript:` scheme, a `#` fragment, or a `code` / `state` query parameter. Native custom schemes such as `myapp://auth/callback` are accepted; the relay flow does not need one registered, since its `redirect_uri` is the backend's HTTPS callback.

`@aws-blocks/core/cdk` exports two read-only helpers for first-party Building Blocks (marked `@internal`, not a stability-guaranteed API): `getRegisteredConfigValue(scope, key)` reads a value registered with `registerConfig`, and `getSharedGatewayUrl(scope)` returns the shared REST API's base URL. Both read at call time, so call them from a `cdk.Lazy` producer when the value is registered or built after the Building Block is constructed.

**Upgrading:** the app client's callback and sign-out URLs are now managed by the Building Block. If you added URLs to the Cognito app client outside of CDK (for example, in the console as a workaround for #1001), those manual entries are replaced on the next deploy. Add any URLs you still need through `additionalCallbackUrls` / `additionalLogoutUrls` so they are kept.
