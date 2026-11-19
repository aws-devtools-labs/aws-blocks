---
'@aws-blocks/core': minor
'@aws-blocks/hosting': minor
'@aws-blocks/bb-auth': minor
'@aws-blocks/bb-dashboard': minor
'@aws-blocks/bb-container-compute': patch
'@aws-blocks/admin-ui': minor
'@aws-blocks/create-blocks-app': minor
'@aws-blocks/blocks': minor
'@aws-blocks/bb-secret': patch
'@aws-blocks/auth-common': patch
'@aws-blocks/bb-compute': patch
'@aws-blocks/bb-lambda-compute': patch
---

The framework's reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*`, `/cdk-blocks/settings`, `/cdk-blocks/dashboard`, ...). The old `/aws-blocks/` prefix stays served as an alias with the same handlers: the runtime (Lambda, container and dev server) treats `/aws-blocks/...` as `/cdk-blocks/...`, the shared API gateway and the Hosting front doors route both, so already-deployed clients, mobile apps and registered auth callbacks keep working. Clients, generated config and defaults use `/cdk-blocks/`.

`BLOCKS_RPC_PREFIX` and `BLOCKS_AUTH_PREFIX` now hold the new prefix, and `canonicalBlocksPath()` maps a legacy path to its canonical one.

On upgrade, the default `redirects.callbackPath` of an `Auth` with `providers` becomes `/cdk-blocks/auth/callback`. An external identity provider (OIDC, Google, ...) that only allows the old `/aws-blocks/auth/callback` redirect URI must have the new one registered, or set `redirects.callbackPath: '/aws-blocks/auth/callback'` to keep the old one. A custom front door that wires only `/cdk-blocks/*` gets a warning that legacy `/aws-blocks/*` clients are not routed.

A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`. Native clients move tokens stored under a block's old `/aws-blocks/` keys to its new keys, so an upgrade keeps their session.

The Admin UI calls `/cdk-blocks/api` and retries at `/aws-blocks/api` only when an older dev server answers 404 without a JSON-RPC envelope, so it still works with that server and never runs a method twice.
