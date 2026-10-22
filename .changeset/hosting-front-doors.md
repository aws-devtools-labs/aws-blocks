---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": patch
"@aws-blocks/blocks": patch
---

feat(hosting): swappable front doors, and bring-your-own doors written as one function

`Hosting` no longer hard-codes CloudFront. The optional `frontDoor` prop picks
the public entry point. Omit it and nothing changes: you get the same CloudFront
distribution as before.

- `'cloudfront'` (default): the global CloudFront CDN.
- `{ kind: 'alb', vpc?, internal?, certificate? }`: a regional Application Load
  Balancer, with no CDN. Server-rendered responses are buffered. With
  `certificate` and `features.domain` it serves HTTPS (TLS 1.2+) at your domain,
  with a port 80 → 443 redirect and Route 53 alias records.
- `{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`: Amazon API
  Gateway, with no CDN, no VPC, and scale-to-zero. `'http'` (the default)
  buffers server-rendered responses; `'rest'` streams them. `'rest'` needs a
  custom `domain`: its own URL carries the `/prod` stage, which the app's
  root-relative links miss, so synth fails without one
  (`RestFrontDoorNeedsDomainError`).
- `{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal?, certificate? }`:
  a CloudFront edge in front of a full ALB router. The edge serves the app's
  static routes straight from the private S3 bucket (origin access control);
  the API and the dynamic routes go through the ALB. The ALB admits only the
  edge: every listener rule requires a secret header the edge sends (otherwise
  403), whose value Secrets Manager generates once per stack and both sides
  read through a CloudFormation dynamic reference; its security group admits
  only the CloudFront origin-facing managed prefix list, or, with
  `internal: true`, only the CloudFront VPC origin the edge reaches it through.
  With a router `certificate` and `features.router.domain`, the edge reaches
  the router over HTTPS on port 443; otherwise that hop is plain HTTP, and an
  internet-facing router warns at synth (`StackedRouterPlainHttp`).
- `'none'`: no front door. A static site or SPA is served straight from an S3
  website bucket over HTTP. An app with a server fails synth.
- `{ kind: 'custom', door, wiringCheck? }`: your own door.

Every door serves the API on the app's own origin (except `'none'`, where the
browser calls the API cross-origin): `/aws-blocks/*` (RPC and sign-in) and each
of the backend's raw routes. An HTTPS door also claims the backend's API
front-door role, so `apiFrontDoor: 'cloudfront'` does not build a second
distribution; a plain-HTTP door doesn't, so native clients keep the backend's
HTTPS API URL, and it warns at synth (`PlainHttpFrontDoor`).

Each door kind takes the settings the app asks it for as `features`, typed for
that kind: a setting the chosen door doesn't implement does not compile.
`{ features }` with no `kind` is the CloudFront default with settings.

- CloudFront: `domain`, `waf`, `logging`, `monitoring`, `skewProtection`,
  `geoRestriction`, `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`,
  `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas`.
- ALB: `domain` (without `wwwRedirect`), `waf` (a REGIONAL web ACL), `logging`,
  `monitoring` (`enabled` only). The ALB's own access logs are off unless
  set; its alarms are on unless `monitoring: { enabled: false }`, as on the
  CloudFront door.
- API Gateway (HTTP and REST): `domain` (without `wwwRedirect`).
- Stacked: per layer, `edge: { waf: { webAclArn }, contentSecurityPolicy }` (a
  CLOUDFRONT-scoped web ACL) and `router: { domain, waf, logging, monitoring }`
  (a REGIONAL web ACL; the domain is the name the edge connects to).
- Custom: `domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
  `skewProtection`, handed to the door as `input.features`.
- `'none'`: no settings.

`geoRestriction.type` takes `'allowlist'` or `'denylist'`; the legacy
`'whitelist'` / `'blacklist'` mean the same, and any other value fails synth.
`frontDoor` is validated at synth: an unknown door, an option the kind doesn't
take, a value of the wrong shape, or an unknown key inside a `features` setting
fails with `UnsupportedFrontDoorError`, `InvalidFrontDoorOptionError` or
`InvalidFrontDoorSettingError`, naming it.

**Deprecated (still supported):** the top-level settings props. On `Hosting`
(`@aws-blocks/core`): `domain`, `waf`, `logging`, `monitoring`,
`skewProtection`, `contentSecurityPolicy`, `priceClass`, `geoRestriction`,
`quotas`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`. On
`HostingConstruct` (`@aws-blocks/hosting`): `domain`, `waf`, `logging`,
`monitoring`, `skewProtection` and `cdn` (each `cdn.<x>` is
`frontDoor.features.<x>`; `cdn.webAclArn` is `frontDoor.features.waf.webAclArn`).
Use `frontDoor.features.<x>` instead: the names are the same, so migrating is a
straight move. The aliases are merged into `frontDoor.features` at
construction, and an app that sets them with no `frontDoor` (or `'cloudfront'`)
synthesizes the same template. Setting a setting both ways fails synth with
`FrontDoorSettingConflictError`, naming both; a top-level prop the chosen kind
doesn't implement fails synth with `UnsupportedFrontDoorSettingError`, naming
the kind and the prop.

The ALB and API Gateway doors serve static files through an asset-proxy Lambda
that answers like the CloudFront door: a missing file returns 404 (the SPA
fallback applies only to paths without an extension), and each file is served
with the `Cache-Control` it was uploaded with. It decodes the request path,
gzips compressible files, answers conditional requests with 304, and adds
baseline security headers. It switches to a new build only after the build's
uploads (and the runtime config) have landed. The proxies apply the app's
redirects (wildcard tail spliced, exact status, never a protocol-relative
target), per-pattern response headers and error pages with the CloudFront
door's semantics; synth names what they can't reach (server-rendered and image
responses, and API Gateway's natively proxied API) with the warning
`@aws-blocks/hosting:DoorRulesNotApplied`. A file is returned base64-encoded in
the Lambda response, so it is capped at about 750 KB (gzipped when
compressible) behind the ALB (1 MB response) and 4.5 MB behind API Gateway
(Lambda's 6 MB response); synth lists every larger build asset
(`@aws-blocks/hosting:AssetExceedsProxyLimit`). ALB listener rules are packed
and synth warns past the default 100 (`AlbRuleLimit`). Past CloudFront's 25
cache behaviors, the stacked door's edge serves the remaining static routes
through the ALB and warns (`@aws-blocks/hosting:StackedEdgeBehaviorLimit`).

Some apps need the CloudFront door. `compute: { type: 'web-function' }` fails
synth with `UnsupportedComputeFrontDoorError` behind any other door, and an app
with Next.js middleware with `MiddlewareNeedsCloudFrontDoorError` (only the
CloudFront door runs it). A streaming server (Next.js through OpenNext, or
Nitro with `awsLambda.streaming: true`) fails synth with
`StreamingServerNeedsStreamingDoorError` behind a door that invokes it without
streaming (the ALB, the stacked door, the API Gateway HTTP API, or a custom
door with `serverResponse: 'buffered'`): it would deploy and no page would
answer. Each built-in door declares what it can serve (streaming, wildcard
routes, the app's rules on every response, and whether it sets
`x-forwarded-host`), and the synth checks read those declarations.

The server is built for the door in front of it. Behind a door that invokes it
without streaming (the ALB, the stacked door's ALB router, the API Gateway HTTP
API), a Lambda Web Adapter server (Astro, Nuxt, SvelteKit) answers buffered.
Serve Next.js through CloudFront, the `'rest'` door, or a door that streams. Behind
the ALB, the server answers with multi-value headers (so every `Set-Cookie`
survives), and a native handler server (Nitro's `aws-lambda` preset) runs
behind a small ALB event shim that maps the ALB event to the API Gateway REST
shape (method, decoded query, base64 body) and the response back.

The server sees the viewer's host as `x-forwarded-host` behind every built-in
door, never a value the client sent. The CloudFront door and the stacked
door's edge set it at the edge; behind the ALB and API Gateway doors, a native
handler server gets it from `Host` through a small shim (a streaming handler
stays streaming), and a Lambda Web Adapter server that reads its host from
`x-forwarded-host` (SvelteKit's `HOST_HEADER`) reads `host` instead.

Redirects behave the same on every door. A wildcard tail spliced onto a
root-relative destination keeps one leading slash on the CloudFront door too,
so `/old//evil.example` never answers a protocol-relative `Location`; an
absolute destination (`https://example.org/moved`) is kept as written. On the
API Gateway door, a redirect source with a wildcard inside a segment has no
route, so on an app with a server it warns
(`@aws-blocks/hosting:RedirectNotExpressible`). The regional doors never route
the backend's catch-all raw route (`/*`) to the API, which would take every
page and asset, and warn (`@aws-blocks/hosting:CatchAllApiPathNotRouted`). The
stacked edge serves the framework build's own 404 page, as the other doors do.
The stacked door emits `HostingInvalidationId`, so the post-deploy liveness
poll waits for the edge's invalidation.

`HostingConstruct` exposes the resolved door as `frontDoorKind`, and takes the
backend API to proxy same-origin as `backendApi: { url, paths? }` (the core
`Hosting` sets it from `api`).

A bring-your-own door is one function:
`defineFrontDoor({ service, serverResponse?, build(scope, input) })` from
`@aws-blocks/hosting/constructs`. `Hosting` calls `build` once at synth, after it
has created the bucket, compute and API and before it declares the asset
uploads. A door that invokes the server without streaming sets
`serverResponse: 'buffered'` (the default is `'streaming'`). The door receives
a `DoorInput`:

- `app`: the build id, base path, Next.js asset prefix, SPA fallback, routes
  already joined to their origins, redirects, headers and error pages.
- `origins`: the assets bucket and build prefix, the server and image Lambdas
  with their Function URLs (the server's `streaming` says whether it streams,
  and its Function URL uses the matching invoke mode), and the API with every
  path that must reach it.
  The API paths are `/aws-blocks/*` (RPC and sign-in) plus the backend's raw
  routes. `app.errorPages` is the app's `errorPages`, else the 404 and 500
  pages the framework build shipped.
- `features`: the door's `frontDoor.features`, under the same names and shapes
  (`domain`, `waf`, `logging`, `monitoring`, `geoRestriction`,
  `skewProtection`). A field is present only when the app asked for that
  feature; skew protection is on by default.

The door returns `{ url, originHandle?, publicBucket?, onUpload?, cutover? }`.

- `url` is required. It becomes `HostingUrl`, `Hosting.url`,
  `BLOCKS_PUBLIC_ORIGIN` and an allowed CORS origin (a trailing slash is
  removed). A missing `url` fails synth with `MissingFrontDoorUrlError`.
- `originHandle` is derived from `url` when the door doesn't return one.
- `onUpload` runs after the asset uploads are declared, so the door can add
  something that runs after them, such as a cache invalidation. What it adds
  under the door's scope also waits for the runtime `config.json` upload.
- `cutover` names the constructs that switch traffic to the new build; each
  waits for every upload.

The `cf.*` helpers (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`,
`cf.redirects`, `cf.headers`, `cf.errorPages`, `cf.invalidate`) build
CloudFront origins, behaviors, functions and error responses from the input
and record what they wired. `cf.redirects` and `cf.headers` run the same
matcher as the built-in CloudFront door; `cf.errorPages` returns the same error
responses. From that record, synth fails if nothing reaches the
static assets (`ServeStaticAsset`). It also fails if the app has an API and
none of its paths were wired (`ProxySameOriginApi`). Unwired API paths, app
redirects, headers or error pages the door didn't wire, and more behaviors than
a distribution allows by default, are synth warnings. A door that wires with
raw CDK declares it with `cf.recordWired(...)`, or turns the check off with
`wiringCheck: false`. `assertDoorConformance(door)` runs the same checks in a
door's own tests.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces they
share are exported for your own doors: `generateAlbAssetProxyCode` and
`generateApiGwAssetProxyCode` (with `AssetProxyOptions`: the app's redirects,
headers and error pages, and `assetProxyEnvironment()` for the function's
environment), `generateAlbApiProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
`routeSpecificity`, `createSecurityHeadersPolicy`, and `ORIGIN_VERIFY_HEADER` /
`CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST` for a door that stacks CloudFront over
its own ALB.

The framework-injected CORS hosting origin matches case-insensitively (an
ALB's DNS name is case-preserving, the browser's `Origin` is lower case); the
app's own `CORS_ALLOWED_ORIGINS` patterns keep their case sensitivity.

`bb-auth-basic` sessions work behind a TLS-less ALB: its same-origin session
cookie drops `Secure` when the deployed front door serves over plain HTTP
(`isInsecurePublicOrigin()` and `plainHttpOrigin` in
`@aws-blocks/auth-common/cookies`). The other auth Building Blocks still set
`Secure`, so use an HTTPS door with them. Behind `'none'` (an HTTP S3 website
calling a cross-site API), auth needs `crossDomain: true`; that cookie keeps
`Secure` and `Partitioned`.
