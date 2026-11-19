---
'@aws-cdk-blocks/hosting': minor
'@aws-cdk-blocks/core': minor
'aws-cdk-blocks': minor
'@aws-cdk-blocks/auth-common': minor
'@aws-cdk-blocks/bb-auth': minor
---

Front doors that would carry sign-in, session cookies or the router's origin-verify secret over plain HTTP now synthesize only in a sandbox deploy (the `sandboxMode` context the sandbox scripts pass). A production synth fails; a sandbox synth warns as before.

- **The ALB door without a certificate.** `{ kind: 'alb' }` with no `certificate` and `features.domain`, serving an app with an API, fails synth with `PlainHttpFrontDoorError`. So does a `{ kind: 'custom', door }` whose URL is `http://` with an API; serve it over HTTPS (return an `https://` url). To fix the ALB door, give it a `certificate` and `features.domain` (an HTTPS listener; port 80 redirects to 443), or use the CloudFront or stacked door. A sandbox deploy warns (`@aws-cdk-blocks/hosting:PlainHttpFrontDoor`). The `'none'` door is unchanged: it warns in every stage.
- **The stacked door's edge → router hop.** `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` requires an encrypted edge → router hop for the router's `x-blocks-origin-verify` header. With an internet-facing router and no router certificate, synth fails with `OriginSecretOverPlainHttpError`. To fix it, give the router a `certificate` and `features.router.domain` (the edge → router hop becomes HTTPS :443), or set `internal: true` (the edge reaches the router through a CloudFront VPC origin on the AWS network). A sandbox deploy warns (`@aws-cdk-blocks/hosting:OriginSecretOverPlainHttp`).
- **Sessions over plain HTTP.** `Auth` issues a session over a plain-HTTP front door only in a sandbox deploy, where its same-origin cookie omits `Secure` as before. Outside a sandbox it refuses: the cookie helpers in `@aws-cdk-blocks/auth-common/cookies` (`resolveCookieSecurity`, `buildCookieSecurityAttrs`) throw the new `AuthErrors.InsecureTransport` (`InsecureTransportException`, HTTP 500 from `Auth`), and no `Set-Cookie` line is written. `Auth` checks this before it stores a session, so a refused sign-in writes nothing and revokes the engine's tokens. Clearing cookies (`Max-Age=0`) are still written, so sign-out and `deleteUser` keep working; `CookieSecurityInput` gains an optional `clearing` flag for them. Deployed compute whose config doesn't name a sandbox counts as production. Cross-domain cookies, HTTPS doors and local development are unchanged.

Compatibility: these are behaviour changes for production apps on a plain-HTTP door. An app that deploys to production behind `{ kind: 'alb' }` without a certificate (with an API), or behind the stacked door with an internet-facing router and no router certificate, no longer synthesizes until it makes one of the changes above; that also covers `Auth` behind such a door, whose sign-in used to set a cookie without `Secure`. Every other front door is unchanged.

The `@aws-cdk-blocks/hosting` README also gains a table of where TLS ends on each front door (viewer hop, origin hop, and the secret header each door's origin requires), and a table of the plain-HTTP shapes that are sandbox-only.
