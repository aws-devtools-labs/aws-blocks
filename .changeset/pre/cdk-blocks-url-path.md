---
'@aws-cdk-blocks/core': minor
'@aws-cdk-blocks/hosting': minor
'@aws-cdk-blocks/bb-auth': minor
'@aws-cdk-blocks/bb-dashboard': minor
'@aws-cdk-blocks/bb-container-compute': patch
'@aws-cdk-blocks/admin-ui': minor
'@aws-cdk-blocks/create-blocks-app': minor
'aws-cdk-blocks': minor
'@aws-cdk-blocks/bb-secret': patch
'@aws-cdk-blocks/auth-common': patch
'@aws-cdk-blocks/bb-compute': patch
'@aws-cdk-blocks/bb-lambda-compute': patch
---

The framework's reserved URL prefix is now `/cdk-blocks/` (`/cdk-blocks/api`, `/cdk-blocks/auth/*`, `/cdk-blocks/settings`, `/cdk-blocks/dashboard`, ...). The old `/aws-blocks/` prefix stays served as an alias with the same handlers: the runtime (Lambda, container and dev server) treats `/aws-blocks/...` as `/cdk-blocks/...`, the shared API gateway and the Hosting front doors route both, so already-deployed clients, mobile apps and registered auth callbacks keep working. Clients, generated config and defaults use `/cdk-blocks/`.

`BLOCKS_RPC_PREFIX` and `BLOCKS_AUTH_PREFIX` now hold the new prefix, and `canonicalBlocksPath()` maps a legacy path to its canonical one.

**Upgrade:**

- The default `redirects.callbackPath` of an `Auth` with `providers` becomes `/cdk-blocks/auth/callback`. An external identity provider (OIDC, Google, ...) that only allows the old `/aws-blocks/auth/callback` redirect URI must have the new one registered, or set `redirects.callbackPath: '/aws-blocks/auth/callback'` to keep the old one.
- A custom front door or an explicit `apiPaths` that routes `/aws-blocks/*` by hand must also route `/cdk-blocks/*` (or use `cf.apiBehaviors(origins.api)`), or the upgraded frontend's API calls won't reach the backend. A custom front door that records only `/aws-blocks/*` as wired now fails synth with `ProxySameOriginApi`; one that wires only `/cdk-blocks/*` gets a warning that legacy `/aws-blocks/*` clients are not routed.
- The built-in CloudFront front door adds one cache behavior (`/aws-blocks/*`). An app already at the distribution's cache-behavior quota (25 by default) needs to free a behavior or raise the quota, or the upgrade fails (at synth when container namespaces add direct behaviors, else at deploy).

A sandbox `stubIdp()` issuer moves to `/cdk-blocks/auth/idp/<id>`, so its users get a new `userId`. Native clients move tokens stored under a block's old `/aws-blocks/` keys to its new keys, so an upgrade keeps their session.

The Admin UI calls `/cdk-blocks/api` and retries at `/aws-blocks/api` only when an older dev server answers 404 without a JSON-RPC envelope, so it still works with that server and never runs a method twice.

A `ContainerCompute` keeps the logical ID and priority of each API listener rule it deployed under `/aws-blocks/api/<name>`, so the upgrade updates the rule's path to `/cdk-blocks/api/<name>` in place rather than replacing it.
