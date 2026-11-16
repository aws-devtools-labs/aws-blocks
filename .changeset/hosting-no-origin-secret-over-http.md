---
'@aws-blocks/hosting': patch
'@aws-blocks/core': patch
'@aws-blocks/blocks': patch
---

Security hardening for the stacked front door (`{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }`): its CloudFront edge no longer sends the router's `x-blocks-origin-verify` secret over a plain-HTTP hop to an internet-facing ALB router, where it would cross the internet unencrypted. Outside a sandbox deploy, that setup now fails synth with `OriginSecretOverPlainHttpError`. To fix it, give the router a `certificate` and `features.router.domain` (the edge → router hop becomes HTTPS :443), or set `internal: true` (the edge reaches the router through a CloudFront VPC origin on the AWS network). A sandbox deploy (the `sandboxMode` context the sandbox scripts pass) still synthesizes, and warns (`@aws-blocks/hosting:OriginSecretOverPlainHttp`).

Compatibility: an app that deploys the stacked door to production with an internet-facing router and no router certificate no longer synthesizes until it makes one of those changes. Stacked doors with a router certificate and domain, or with `internal: true`, and every other front door, are unchanged.

The `@aws-blocks/hosting` README also gains a table of where TLS ends on each front door (viewer hop, origin hop, and the secret header each door's origin requires).
