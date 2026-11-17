---
'@aws-blocks/hosting': minor
'@aws-blocks/core': minor
'@aws-blocks/blocks': minor
'@aws-blocks/auth-common': minor
'@aws-blocks/bb-auth': minor
---

Add `allowPlainHttp`, an explicit opt-out for builders who need a plain-HTTP front door in production. A production synth fails for a door that would carry sign-in, session cookies or the router's origin-verify secret over plain HTTP; this option is the migration for an app that serves plain HTTP on a network path it trusts, such as an internal ALB reached only inside a private network, or TLS ended upstream by a proxy or another load balancer.

- **The option.** The `alb` and `custom` doors (`AlbDoorOptions`, `CustomDoorOptions`) and the stacked door (`CloudFrontOverRouterFrontDoor`) take `allowPlainHttp?: boolean` (default `false`). With `allowPlainHttp: true`, a production synth that would fail with `PlainHttpFrontDoorError` or `OriginSecretOverPlainHttpError` succeeds and warns instead.
- **The warning.** `@aws-blocks/hosting:PlainHttpAllowedInProduction` names what travels in cleartext. Acknowledge it with `Annotations.of(stack).acknowledgeWarning('@aws-blocks/hosting:PlainHttpAllowedInProduction')`.
- **Sessions.** For the `alb` and `custom` doors, `Hosting` also registers the config entry `BLOCKS_ALLOW_PLAIN_HTTP`. With it, `Auth` issues its same-origin session cookie without `Secure` instead of throwing `AuthErrors.InsecureTransport`. The cookie helpers in `@aws-blocks/auth-common/cookies` read it fail-closed, from loaded config only on deployed compute: a missing or malformed value still refuses.

To keep serving plain HTTP in production, add `allowPlainHttp: true` to the door and acknowledge the warning; the deploy and `Auth`'s sign-in then behave as they did before plain-HTTP doors were limited to sandbox deploys. Without the option nothing changes: a sandbox deploy, HTTPS doors and the `'none'` door behave as before.
