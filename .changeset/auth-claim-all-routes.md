---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth): synth fails when a route of one `Auth` block collides with any other route

Synth claims every route each `Auth` block with providers mounts, by method and path: the callback, exchange and session routes, each provider's sign-in and authorize-params routes, both sign-out routes, the refresh routes with `allowBearerAuth`, and every stub IdP route. A collision the backend would refuse when it loads, for example one block's `redirects.signOutPath: '/aws-blocks/auth/session'` next to a block on the default paths, fails `cdk synth` instead, with a message naming both blocks and the fix. A single block whose own `redirects.callbackPath` or `redirects.signOutPath` lands on another of its routes (for example `signOutPath: '/aws-blocks/auth/exchange'`) fails synth too.
