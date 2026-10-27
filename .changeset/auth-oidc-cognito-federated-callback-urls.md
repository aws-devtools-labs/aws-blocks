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

New `cognitoFederated()` options `additionalCallbackUrls` and `additionalLogoutUrls` register URLs that can't be derived at synth — browser PKCE SPA redirect pages, native-app custom schemes, custom-domain names other than the primary one, or a sandbox dev server on another port. Entries from every `cognitoFederated()` provider are merged and de-duplicated. Synth fails with a descriptive error for an entry Cognito would reject at deploy: a plain-`http://` URL whose host isn't `localhost`, or a URL with a `#` fragment.

`@aws-blocks/core/cdk` exports two read-only helpers for Building Blocks: `getRegisteredConfigValue(scope, key)` reads a value registered with `registerConfig`, and `getSharedGatewayUrl(scope)` returns the shared REST API's base URL. Both read at call time, so call them from a `cdk.Lazy` producer when the value is registered or built after the Building Block is constructed.
