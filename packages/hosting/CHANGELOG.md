# @aws-blocks/hosting

## 0.5.0

### Minor Changes

- dde6340: feat(hosting): swappable front doors, and bring-your-own doors written as one function

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
  of the backend's raw routes. Only a CloudFront-backed door (the default, or
  the stacked door's edge) claims the backend's API front-door role, so
  `apiFrontDoor: 'cloudfront'` builds no second distribution there. Behind the
  ALB, API Gateway or a bring-your-own door, the API keeps the distribution
  `apiFrontDoor: 'cloudfront'` asks for, and `ApiUrl` stays on it for native
  clients. A plain-HTTP door warns at synth (`PlainHttpFrontDoor`). The backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`, where the OIDC callback lands and whose scheme sets
  the session cookie's `Secure`) belongs to the door that serves `/aws-blocks/*`
  to browsers: a managed `cloudfront` API distribution built beside such a door
  doesn't overwrite it. `'none'` publishes none (the bucket serves no
  `/aws-blocks/*`), and its `config.json` names the same API URL as `ApiUrl`.

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
  synthesizes the same template, with one exception for JavaScript callers of
  `geoRestriction` (TypeScript only accepted `'whitelist'` / `'blacklist'`): any
  type other than `'whitelist'` used to deny the listed countries, so
  `'allowlist'` now allows them as its name says, and a missing or unknown type
  (e.g. `'Whitelist'`) now fails synth instead of denying. Setting a setting both ways fails synth with
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
  within the per-rule limits (five condition values, six wildcards; a pattern
  with more wildcards fails synth with `UnsupportedRoutePatternError`), and synth
  warns past the default 100 (`AlbRuleLimit`). Past CloudFront's 25
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

  The CloudFront door and the stacked door's edge set `x-forwarded-host` from
  the viewer's `Host`. Behind the ALB and API Gateway doors, a native handler
  server gets it from `Host` through a small shim (a streaming handler stays
  streaming), and a Lambda Web Adapter server that reads its host from
  `x-forwarded-host` through `HOST_HEADER` (SvelteKit) reads `host` instead. Any
  other Lambda Web Adapter server (Astro's Node adapter, Nitro's `node-server`)
  receives the request's headers as sent, so it shouldn't trust
  `x-forwarded-host` behind those doors.

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
  On the CloudFront door and the stacked door's edge, the app's header rules
  match the path the viewer asked for, as on the regional doors: the
  viewer-response function sees the URI rewritten to the build prefix, so the
  viewer-request function records the viewer's URI for it (`x-blocks-viewer-uri`,
  trusted only on a rewritten URI), and a rule such as `/assets/*` applies.
  Nuxt image optimization (`@nuxt/image` through the IPX Lambda) works under an
  `app.baseURL` behind every door: the ALB and API Gateway doors route the full
  `/<baseURL>/_ipx/...` path to the image Lambda, which now strips the base path
  before IPX's own prefix (`IPX_APP_BASE_URL`).
  The stacked door emits `HostingInvalidationId`, so the post-deploy liveness
  poll waits for the edge's invalidation.

  `HostingConstruct.securityHeadersPolicy` (the CloudFront door's security-headers
  policy, which `Hosting` reuses on the API and auth behaviors) is `undefined`
  behind a door with no CloudFront distribution here; the stacked door's edge
  carries its own policy on every behavior, the API's included.

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

- 7477b6e: Add `compute.type: 'web-function'` to run the SSR server on AWS Lambda Web Functions. The framework's own Node.js server runs directly on Lambda behind CloudFront origin access control, with no API Gateway and no Lambda Web Adapter. Each execution environment serves many concurrent requests and is billed for active CPU. It works with Astro, SvelteKit, Nuxt/Nitro and Next.js in the Regions where Web Functions are available. When this compute is selected, Nitro builds with the `node-server` preset and Next.js builds with OpenNext's `node` wrapper automatically. Tune it with `compute.webFunction` (`maxConcurrencyPerEnvironment`, `maxEnvironments`, `rateLimit`). The default (`'lambda'`) is unchanged.

  Sandbox deploys (`npm run sandbox`) of a Web Function app skip CloudFormation Express Mode after the first deploy. Express Mode can't update a Web Function endpoint, so the deploy uses a full deploy with rollback instead.

- 6a53068: Security headers (and the CSP) now cover the API and auth CloudFront
  behaviours, not just the static site. Before, a `ResponseHeadersPolicy` was
  attached only to the static root; requests through `/aws-blocks/api`,
  `/aws-blocks/api/*`, `/aws-blocks/auth/*` and the raw-route proxies went out
  with no security headers at all, so the two surfaces where it matters most —
  auth and API — were the ones left uncovered (issue #765).

  Both front-door paths are fixed:

  - **Hosting-claimed path:** the behaviours added in `addApiBehaviors` now reuse
    the distribution's existing `securityHeadersPolicy` — the same policy already
    on the static behaviours — so there is one policy per distribution and no
    drift. To reach it, `CdnConstruct` and `HostingConstruct` now expose the
    policy as a public `securityHeadersPolicy` field.
  - **Standalone managed front door** (`api-front-door.ts`): has no Hosting
    construct to borrow from, so it attaches the AWS-managed
    `ResponseHeadersPolicy.SECURITY_HEADERS` to its default behaviour. The managed
    policy creates no CloudFormation resource and consumes no account
    `ResponseHeadersPolicy` quota (capped at 20 per account by default), so a
    cloudfront-tier app near that cap can't fail a deploy, and it matches what the
    Hosting-fronted path ships by default. It carries HSTS, X-Content-Type-Options,
    X-Frame-Options, X-XSS-Protection and Referrer-Policy — no CSP, since the API
    subtree serves JSON and redirects rather than documents.

  This is a `minor` bump for `@aws-blocks/hosting` because it adds public API
  (`CdnConstruct.securityHeadersPolicy` and `HostingConstruct.securityHeadersPolicy`)
  and a `patch` for `@aws-blocks/core` because it only changes behaviour (no new
  public surface). Existing apps gain the headers automatically on their next
  synth. On the Hosting-fronted path the API/auth behaviours reuse the policy
  already on the static site, so there is no new option to set and no behaviour
  change beyond the added response headers. On the standalone managed front door
  the behaviour attaches the AWS-managed `SECURITY_HEADERS` policy — no new
  CloudFormation resource and no quota impact.

- 3b5a419: Add opt-in CloudFront **standard logging v2** for hosting access logs. Set `logging.version: 'v2'` to deliver access logs through the CloudWatch Logs vended-logs delivery pipeline instead of legacy inline logging. v2 removes the log bucket's ACL requirement (`BUCKET_OWNER_ENFORCED` instead of `BUCKET_OWNER_PREFERRED`), delivers a partitioned S3 key layout (`logging.partitioning: 'date' | 'hive'`), and supports selectable record formats (`logging.format: 'w3c' | 'plain' | 'json' | 'parquet'`). The default remains `'v1'` (no behavior or billing change). Standard logging v2's delivery source must be created in us-east-1; synth throws `LoggingV2RegionError` in any other Region, and warns when the Region is unresolved at synth.
- 48c35f6: `hosting-secret remove --force` and `blocks secret remove --force` now always need `--yes` (or `-y`) to confirm, in every stage, and print a warning first that names the stage (or says an un-staged value is shared by every stage, including production) and that the delete is immediate with no recovery window. Without `--yes` the command refuses before it calls Secrets Manager. **This changes existing CLI behaviour:** scripts that run `remove --force` must add `--yes`. A plain `remove` is still recoverable, `config` removes are unchanged, and the programmatic `removeValue()` / `removeSecret({ force: true })` stay non-interactive and log the same warning.

### Patch Changes

- 88747f5: feat: Building Block mock entries fail closed in a deployed environment

  - **Runtime guard.** `@aws-blocks/core/bb-utils` exports `assertNotMockInDeployedEnv(bbName)`, the runtime counterpart of the `--conditions=cdk` synth check. It throws when a Building Block's mock (`default` export) entry is loaded in a deployed environment, which happens when the backend was bundled without the `aws-runtime` export condition. A deployed environment is detected from `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`, which Blocks sets on every compute it provisions (Lambda, container, AgentCore). On compute Blocks doesn't configure, the check is inert and the `aws-runtime` bundler condition is the only protection. It is a no-op in local dev and tests.
  - **Wired into every BB mock entry.** Each Building Block's mock entry calls the guard at module load, so a mis-bundled artifact throws instead of running in-memory stubs: at process start on container and AgentCore computes, and on the first invocation on Lambda (where the backend is imported lazily, so the deploy succeeds and requests then return an error).
  - **AuthOIDC mock cookie secret.** The mock runtime's cookie-signing secret is now random per project instead of a fixed string, persisted (mode 0600) under the instance's `.bb-data/` mock data dir so local sessions survive backend reloads and dev-server restarts. Local sign-in is unchanged.
  - **Bundler conditions.** The `@aws-blocks/hosting` handler bundle and the AuthOIDC IdP-registration and DistributedTable GSI-manager Lambda bundles now pin the `aws-runtime` condition. The hosting bundle uses `['aws-runtime', 'module']` so esbuild keeps preferring packages' ESM builds.
  - **Scaffold template.** `@aws-blocks/create-block`'s primitive template calls the guard in its mock entry and depends on an `@aws-blocks/core` range that exports it.
  - **Docs.** `docs/guides/extending-with-existing-aws-resources.md` documents configuring your own bundler (esbuild, webpack) or unbundled Node (`--conditions=aws-runtime`) with the `aws-runtime` condition when deploying to a compute target Blocks doesn't own, and adds the guard call to the BB-author checklist.

  Maintainer note: these are `minor` bumps because AWS Blocks is pre-1.0, where `minor` is the channel for behavior changes — mock entries that previously ran in a deployed environment now throw.

- d366907: chore: manual dependency bump (2026-10-19)
- 2c73654: fix(hosting): load `astro.config` under Astro 7

  Astro 7's `astro/config` pulls in a Vite build that uses `import.meta.require`, which the adapter's config loader couldn't handle. The adapter logged "Failed to load astro.config … falling back to defaults" and dropped the whole config, so `redirects`, `trailingSlash` and image settings were ignored. The config now loads natively first, and the verified Astro range covers 7.x.

- 515089c: fix(hosting): serve the default 404 page behind every front door

  A multi-page static site that ships no 404 page of its own and sets no
  `errorPages.notFound` (for example Astro with `output: 'static'` and no
  `404.astro`) now gets AWS Blocks' default "404 — Page Not Found" page, at HTTP
  404, behind every front door, not only CloudFront. The ALB and API Gateway
  (HTTP and REST) doors serve it from their asset proxy instead of a plain-text
  `Not Found`. A bring-your-own door receives it as `DoorInput.app.errorPages.notFound`
  (`_not_found.html`), so `cf.errorPages` wires it too. The precedence is the same
  on every door: the app's `errorPages.notFound`, then the framework's
  `errorPages[404]`, then the default. The stacked door's edge and
  `cf.errorPages` now serve an error page at its own key (the default
  `_not_found.html`, or a framework page under any name) instead of always
  pointing at `404.html` / `500.html`. An SPA keeps its `index.html` fallback, a
  site with a server keeps its own 404, and the `'none'` door keeps its S3
  website error document.

  Every door now makes the same decision from the manifest:
  - only an explicit `staticAssets.spaFallback: true` is an SPA, as in routing,
    so a custom adapter's manifest that leaves it unset gets the default page
    rather than S3's 403 (the built-in adapters always set it);
  - an image optimizer doesn't count as a server, so a static site with one
    still gets the default page on CloudFront too;
  - the build's cutover waits for the default page's upload, so a miss never
    reaches a new build before its 404 page does.

  The CloudFront door no longer maps 403 twice for a static site that ships a
  500 page but no 404 page. `cf.origin` now lets CloudFront list the assets
  bucket (scoped to the door's distribution, as on the built-in doors), so a
  missing file is a 404 and a bring-your-own door's `cf.errorPages` can serve
  the page. The CloudFront template of an app built by a built-in adapter is
  otherwise unchanged.

  The docs now match the doors' behavior:
  - the ALB door's own alarms are on unless `monitoring: { enabled: false }`;
  - only a CloudFront-backed door takes over the API's address under
    `apiFrontDoor: 'cloudfront'`;
  - the ALB packs listener rules within five condition values and six wildcards
    per rule;
  - which servers behind the ALB and API Gateway doors are given `Host` as
    `x-forwarded-host`, and which receive the client's value.

- a02549a: fix(hosting): keep `HostingError.cause` out of serialized output

  `HostingError` now passes its optional cause to the native `Error` constructor, so `cause` is a non-enumerable property. `JSON.stringify` and object spread of a `HostingError` no longer include the wrapped error (for example AWS SDK `$metadata`). `error.cause` still returns the original error.

- f8bfab1: fix(hosting): pages that render on demand inside a Nuxt/Nitro ISR folder no longer 404

  With an ISR or SWR route rule that names a folder in `public/` (for example `routeRules: { '/blog/**': { isr: 60 }, '/blog/featured': { prerender: true } }`), the Nitro adapter used to emit a blanket static `/blog/*` route for the folder. Every front door takes the first match, so `/blog/any-other-post` went to the static asset origin and returned 404, including when the prerendered page sat one folder deeper (`/blog/2024/featured`).

  The folder no longer gets a blanket static route. Instead:

  - Its real files keep their own static routes: each file directly in the folder (`/blog/hero.png`), and one route per sub-folder that holds no pages (`/blog/img/*`). They're still served from S3.
  - A page frozen by an explicit `prerender: true` rule keeps its own routes and is still served frozen from S3.
  - Every other path under the folder goes to the server and renders on demand.

  `RouteBehavior` has a new optional `exact` field. A route marked `exact` keeps its own row in the front door's route table: it isn't merged with its siblings into a `<parent>/*` wildcard, and it isn't switched to the server when ISR/SWR is active. The Nitro adapter sets it for the routes above. A site-wide rule (`'/**'`) and apps without ISR/SWR rules are unchanged.

- 3ae22e6: fix(hosting): build Next.js apps with a verified OpenNext version, and explain Edge-route and version mismatches

  - **`@opennextjs/aws` not installed.** Hosting declares OpenNext as an optional peer dependency, so nothing installs it for the app, and a bare `npx @opennextjs/aws build` downloaded the newest release, which is often outside the version range the Next.js adapter is verified against. When the project doesn't declare it, the adapter now builds with `@opennextjs/aws@4.0.3` and prints the command to declare it (`npm install --save-dev @opennextjs/aws@~4.0.3`). If that build fails, it throws `OpenNextNotFoundError` with the same command. Before this change that error could never be raised.
  - **Next.js outside OpenNext's `next` peer range.** When the app's `next` version is outside the range the building OpenNext declares (for example `next@15.5.7` with `@opennextjs/aws@4.0.3`, which requires `>=15.5.18 <16 || >=16.2.6`), the adapter now prints a warning naming both versions and the range. Package managers that skip peer checks would otherwise build an untested pair without a word.
  - **Edge routes on a stack without a region.** A Next.js route with `runtime = 'edge'` is built as Lambda@Edge, which needs the stack's region at synth time. On a stack with no explicit `env.region`, synth failed with CDK's `stacks which use EdgeFunctions must have an explicitly set region`. Hosting now throws `EdgeComputeRequiresRegionError`, which names the route's compute and shows the `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }` fix.
  - **Package versions in workspaces and monorepos.** The Next.js, Astro, Nuxt and SvelteKit adapters now read `next`, `@opennextjs/aws`, `astro`, `@astrojs/node`, `nitropack`, `@nuxt/image`, `@sveltejs/kit` and `@sveltejs/adapter-node` from the app's own directory. They previously started at its parent, so an app that pins a different version than the one hoisted to the workspace root got the root's version. For example, a Next.js 15 app under a root `next@16` had the Next.js 16 image-optimizer patch applied and missed the peer-range warning.
  - **Local images on Next.js 15.5.16+ and 16.2.0–16.2.4.** The adapter patches OpenNext's call to Next.js's `fetchInternalImage` when Next.js takes an extra `maximumResponseBody` argument. It decided by major version (patch on 16, skip on 15), but that argument arrived in patch releases: it is in 15.5.16 and later, and in 16.2.5 and later, but not in 16.0.x, 16.1.x or 16.2.0–16.2.4. So `/_next/image` returned 500 (`TypeError: … is not a function`) for local images on Next.js 15.5.16+ and on 16.2.3–16.2.4. The adapter now reads the signature from the installed `next` (falling back to those version boundaries).
  - The `@opennextjs/aws` peer dependency range is now bounded: `>=3.10.0 <5.0.0`.
  - `@aws-blocks/create-blocks-app`: the `nextjs` template declares `@opennextjs/aws` (`~4.0.3`) as a devDependency, so new Next.js apps build with a pinned, verified OpenNext.

- c8c26f7: fix(hosting): don't hard-fail a Next.js deploy the day its major ages out of OpenNext's support window

  `@opennextjs/aws` refuses to build a Next.js major that has passed the Next.js team's 2-year support window: it prints `Next.js version X is not supported by the Next.js team` and calls `process.exit(1)` unless invoked with `--dangerously-use-unsupported-next-version`. Because that window is a wall-clock deadline, a Next.js SSR deploy that worked yesterday would start hard-failing the day the major expires — with no change on the user's side (e.g. Next 15 aged out on 2026-10-21).

  The Next.js adapter now passes `--dangerously-use-unsupported-next-version` to the OpenNext build unconditionally. The flag is inert on a supported version — OpenNext reads it only inside its `if (!isSupported)` branch — and on an aged-out major it downgrades the hard `exit(1)` to a warning and continues. The deployed app still runs; the support policy is about upstream security patches, not runtime compatibility. OpenNext's own `isNextVersionSupported` remains the single source of truth for the supported/unsupported decision, so nothing in this package needs to track Next.js release dates.

- 3803f19: Ship a patched `sharp` in every image-optimization bundle. The Next.js image-optimization Lambda, the Astro SSR `/_image` endpoint and the Nuxt IPX Lambda installed sharp 0.34.x, which is affected by [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (a librsvg use-after-free that can lead to remote code execution on glibc Linux). They now install `sharp@^0.35.5`. A sharp already in the bundle is replaced unless it is 0.35.5 or later and built for the function's CPU, and the Nuxt IPX bundle forces ipx onto the same sharp. Redeploy to pick up the fix.

  Astro 4 and 5: sharp 0.35 removed the `failOnError` option that Astro's sharp image service passes, so a slightly corrupt source image (for example a truncated JPEG) that `/_image` used to render now fails to optimize.

- db15b5e: fix(core): make the API Gateway 29s integration default explicit and warn on an undeliverable alarm topic

  Two right-sizing fixes to the production defaults a deployed Blocks app ships with.

  - **API Gateway integration timeout is set explicitly to 29s.** `LambdaIntegration` already defaults to 29s, so this is no runtime change — it writes the boundary into the synthesized template (an explicit `TimeoutInMillis: 29000` on each Lambda method) so it is visible at review and aligned with the handler's own 28s deadline guard (`APIGW_TIMEOUT_MS`), which already emits a structured 504 just before the cut-off. A request still in flight at 29s is cut off by API Gateway regardless of how long the Lambda may run; the shared handler's function timeout (up to 900s) is the async-work ceiling and is unreachable on the synchronous HTTP path. The `bb-lambda-compute` `memory`/`maxTimeoutSeconds` docs now explain that the generous defaults are sized for the shared async path and how to right-size an API-only compute.
  - **Hosting monitoring warns at synth when an alarm topic has no subscriber.** When monitoring is enabled and an alarm topic ends up with no subscriber, it can enter ALARM but deliver to no one. A shared validation now emits a loud synth warning, applied to both the regional alarm topic and the off-region us-east-1 support-stack topic that carries the CloudFront 5xx alarm, so each topic is judged on its own alarms and subscribers. The check is deferred to synth so it accounts for subscriptions added after construction — a direct `topic.addSubscription`, or a `LambdaSubscription`/`SqsSubscription` whose subscription resource lands in another stack — and it stays quiet when no alarm is wired or when every alarm already routes to a delivery action other than the topic. The message names the `acknowledgeWarning` escape hatch for callers who accept the gap knowingly.

- c0f6a83: Include the Apache-2.0 `LICENSE` file in the published package.

## 0.4.1

### Patch Changes

- 8b5ef4a: fix(hosting): stop the SSR REST API from leaking an IAM role on every teardown

  The SSR origin's `RestApi` relied on CDK's default `cloudWatchRole: true`, which
  provisions an account-level `AWS::ApiGateway::Account` plus a CloudWatch Logs IAM
  role with `RemovalPolicy.RETAIN`. The SSR stage enables neither execution nor
  access logging, so the role was unused, and because it is retained, every
  `cdk destroy` of a hosting SSR stack left one orphaned IAM role behind — enough,
  over repeated deploys, to exhaust the account's 3000 `RolesPerAccount` quota and
  make all subsequent deploys fail with `ServiceLimitExceeded`. The SSR `RestApi`
  now sets `cloudWatchRole: false` (matching `bb-lambda-compute`), so no role or
  `ApiGateway::Account` is created. Existing stacks drop both resources on their
  next deploy; the previously retained role is not removed by CloudFormation and
  can be deleted manually — but first check `aws apigateway get-account`: if the
  region's `cloudwatchRoleArn` still points at that role, deleting it breaks
  logging for every other API Gateway stage in the region.

- 382dac6: fix(hosting): the image-optimization Lambda no longer follows redirects on remote image fetches

  The IPX image Lambda validated a remote image URL against the allowlist
  (`IMAGE_ALLOWED_HOSTNAMES` / `remotePatterns`) once, before fetching — and the
  fetch then followed HTTP redirects without re-validating the target. An allowlisted
  host with an open redirect (a user-content CDN, say) could therefore steer the fetch
  to any host, including `127.0.0.1` inside the Lambda sandbox.

  Remote fetches now use `fetchOptions: { redirect: 'error' }`, so a 3xx fails the
  image request instead of being followed, and the allowlist holds for every request
  the Lambda makes. **If an allowlisted image host serves its images through a redirect,
  allowlist the final location instead.** The generated Lambda also pins `ipx` to an
  exact version (`3.1.1`) rather than `^3.0.0`, so the fetch behavior this guard relies
  on can't change at deploy time.

- c6d9e49: fix(hosting): the image-optimization Lambda's SVG gate now decides by content, not file extension

  With `dangerouslyAllowSVG` / `IMAGE_ALLOW_SVG` off, the image Lambda rejected SVG
  sources only when the URL ended in `.svg`. An origin's content type isn't tied to its
  path, so an SVG served from `/logo` or `/logo.png` passed the gate and was returned as
  `image/svg+xml` from the application's own origin. SVGO, which IPX runs on SVG input,
  is an optimiser rather than a sanitiser and keeps some script-capable constructs.

  The Lambda now sniffs the image bytes from both the S3 originals bucket and allowlisted
  remote hosts, and rejects SVG content with a `415` before IPX processes it. That also
  covers rasterizing requests such as `?f=png`. As a backstop it refuses any SVG output
  unless SVG is enabled. The `.svg` extension check remains as a cheap pre-filter.
  Nothing changes when SVG is enabled, or for raster images.

- 7c19c4f: feat: `npm run deploy -- --wait-live` holds `BLOCKS_DEPLOYED` until the new build is actually served

  `cdk deploy` returning is not the same as the new frontend build being served.
  Two edge windows stay open after CloudFormation reports complete, and emitting
  `BLOCKS_DEPLOYED` while either is open lets a caller's immediate self-test hit a
  stale bundle and silently miss a regression.

  - **New opt-in `--wait-live` flag.** When set, `npm run deploy` only prints
    `BLOCKS_DEPLOYED` once the new build is confirmed live, so a request issued
    immediately after the signal returns the new asset.
  - **Per-build config match (the KVS cutover).** Each deploy stamps its build id
    into the runtime config (`/.blocks-sandbox/config.json`) and surfaces it as a
    `HostingBuildId` stack output; the poll declares the config live only when the
    body CloudFront serves carries that exact id, distinguishing the new build from
    a byte-identical config still served by an edge POP routing to the previous
    build during cutover — the common re-deploy case.
  - **Invalidation wait (the compute/SSR window).** For a compute deploy the `/*`
    CloudFront invalidation that flushes the previous build's edge-cached SSR HTML
    is fire-and-forget, so CloudFormation returns before it propagates. The deploy
    now surfaces the invalidation id as a `HostingInvalidationId` stack output and,
    under `--wait-live`, polls `GetInvalidation` until `Completed` before signalling
    — closing the window where the edge still serves old SSR HTML (referencing old
    hashed assets → 403). Pure-static deploys issue no invalidation and skip this.
  - **Bounded probing.** Each config probe carries a per-request timeout
    (`AbortSignal`), so one stalled response cannot hold the deploy past its budget.
    `--wait-live-timeout=<seconds>` tunes the overall budget (default 180); if
    liveness can't be confirmed in time, the deploy — which itself succeeded — prints
    a clear warning and exits non-zero rather than emitting a false "live" signal.
  - **No-op for backend-only apps** (no frontend to verify) and off by default, so the
    existing deploy flow is unchanged unless you opt in.

## 0.4.0

### Minor Changes

- 5501cb6: Fix off-region CloudFront 5xx alarm and rework alarm subscription wiring (#481).

  **Breaking change** (a minor bump pre-1.0):

  - The `monitoring.snsTopicArn` prop is **removed**. Attach notifications
    with the new `monitoring.subscriptions` list instead: `EmailSubscription`
    and `UrlSubscription` from `aws-cdk-lib/aws-sns-subscriptions` (endpoint
    subscriptions only, for now). Each subscription is applied to **both**
    hosting alarm topics, so you subscribe in one place and every alarm is
    covered regardless of region.
  - The `hosting.monitoringTopic` attribute is **removed**, replaced by
    `hosting.monitoring` = `{ alarms, alarmTopics }` (all alarms and all
    alarm topics across both regions).

  `AWS/CloudFront` metrics publish only in us-east-1 and a CloudWatch alarm
  cannot watch a metric cross-region, so off-region the CloudFront 5xx alarm
  never fired (it sat at `OK` under `treatMissingData: NOT_BREACHING`).
  Off-region deployments now **always** place the CloudFront alarm in a
  synthesized `<stackName>-CfMonitoring-<addr>` us-east-1 stack with its own
  encrypted SNS topic; `monitoring.subscriptions` are applied to that topic
  too. Off-region placement is always on; the only escape is when it is
  genuinely impossible. When the region resolves but the account is
  unresolved (a single-synth multi-account pipeline), the us-east-1 support
  stack cannot be built, so the CloudFront alarm is skipped with a loud synth
  warning and all other alarms are kept, rather than throwing. Set
  `env: { account, region }` to enable CloudFront coverage.

  Migration: replace `monitoring: { snsTopicArn }` with
  `monitoring: { subscriptions: [new subs.EmailSubscription('oncall@example.com')] }`
  (or a `UrlSubscription`). Two escape paths cover what `subscriptions` no
  longer does directly:

  - **Route alarms to an existing/central SNS topic:**
    `hosting.monitoring.alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(myTopic)))`.
  - **Resource-target (Lambda/SQS) subscriptions:** still valid on the
    regional topic via `hosting.monitoring.alarmTopics[].addSubscription(...)`.
    Only the automatic cross-region fan-out to the us-east-1 CloudFront topic
    drops them (that would need an unresolvable cross-region reference).

  See `docs/DECISIONS.md` D-016 for the always-on and warn-and-skip rationale.

  `@aws-blocks/core` surfaces `monitoring.subscriptions` and the
  `monitoring` attribute in place of `monitoringTopic`.

- 5515483: fix(hosting): fail-closed SSR cache key + per-credential cache-key options

  Ensures cacheable SSR responses on compute deployments are keyed per credential, and adds the controls to include credentials in the SSR cache key.

  **BREAKING:** existing configs that set `cdn.ssrDefaultTtl > 0` now fail synth (`SsrCacheKeyCredentialsRequiredError`) until they include a credential in the SSR cache key. Enabling `ssrDefaultTtl > 0` makes SSR responses without an explicit `Cache-Control` header cacheable and shared at the CloudFront edge, keyed only on the Next.js router headers — not on `Authorization` or session cookies (CloudFront ignores `Vary`).

  Migration — pick one:
  - Add `cacheKeyCookies: ['<your session cookie>']` and/or `cacheKeyHeaders: ['authorization']` so cached responses are keyed per credential; or
  - Remove `ssrDefaultTtl` (and ensure personalized routes emit `Cache-Control: private`).

  - **Fail-closed guard on `cdn.ssrDefaultTtl`.** Synth throws unless `cacheKeyCookies` and/or `cacheKeyHeaders` is set, so credentials are in the cache key before per-credential responses can be cached. An unresolved-token TTL is treated as `> 0` (fail closed).
  - **New `cdn.cacheKeyCookies` and `cdn.cacheKeyHeaders` options.** Add your session cookie name(s) and/or credential-bearing header(s) (e.g. `'authorization'`) to the SSR cache key so authenticated responses are cached per credential. `'accept-encoding'` is rejected (handled by the brotli/gzip flags), and at most 8 caller cookies are allowed (CloudFront's 10-cookie cap, 2 reserved for Next.js preview mode). The cookie/header caps are resolved via `QuotaBudget` (`quotas.cacheKeyCookies` / `quotas.cacheKeyHeaders`) so a granted quota increase raises them.
  - **Shared-route cache key on compute deploys.** Compute deploys route every request through a single default cache behavior, so `cacheKeyCookies`/`cacheKeyHeaders` would key all routes per credential. The edge router now strips the configured cookies and `authorization` on static and image routes so shared assets keep a shared cache key, while SSR/compute routes stay keyed per credential.
  - **Cache-key JSDoc** on `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` documenting how credentials enter the cache key and safe usage.
  - **`@aws-blocks/core`:** `Hosting` exposes `ssrDefaultTtl`, `cacheKeyCookies`, and `cacheKeyHeaders` as top-level props and forwards them to the CDN cache-key config.

  Note: any route that sets cookies via `Set-Cookie`, or otherwise varies per user without opting into the cache key, must emit `Cache-Control: private` so its response is not cached as a single shared entry at the edge.

### Patch Changes

- 773cef2: fix(astro): allow an empty `dist/client` for pure-SSR builds

  A server/hybrid Astro app with no static assets — no `public/` files and no
  prerendered pages — produces an empty `dist/client`. The adapter treated that as
  a missing build output and threw `AstroBuildOutputMissingError`, blocking synth
  and deploy. `dist/server/entry.mjs` is the real required artifact; an empty (or
  absent) `dist/client` is valid, since CloudFront routes every request to the SSR
  Lambda. The adapter now requires only the server entry and ensures `dist/client`
  exists (creating it when absent, with a build-log breadcrumb) instead of failing.

- 6b7fe4c: fix(hosting): retain the ISR tag-table seed custom resource on stack delete

  The `IsrTagTableSeed` custom resource is backed by a Lambda through a CDK
  `Provider`. On stack delete CloudFormation tore the provider's framework Lambda
  down before it sent the custom resource its `Delete`, so the delete invoke hit
  an already-gone function, received no response, and hung to the 30-minute
  custom-resource timeout -- failing the whole stack delete with `DELETE_FAILED`
  and re-failing identically on every retry. The seed custom resource now carries
  `RemovalPolicy.RETAIN`, so CloudFormation drops it on delete without a delete
  invoke and the stack tears down cleanly. This is behavior-preserving: the
  OpenNext `dynamodb-provider` `remove()` path is a no-op, and the seeded rows
  live only in the ISR tag table, which is destroyed with the stack -- so
  retaining the custom resource orphans nothing.

- dae7a86: fix(hosting): warn when a compute resource pins an end-of-life Node.js runtime

  `resolveRuntime` still accepts an explicitly pinned `nodejs18.x` or `nodejs20.x`
  (so an existing/deployed function isn't hard-broken at synth), but both are past
  their AWS Lambda deprecation dates (Node 18: Apr 2025; Node 20: Apr 2026). It now
  emits a CDK synth-time **deprecation warning** for those runtimes, pointing at
  `nodejs22.x` / `nodejs24.x` (or omitting the runtime to use the default). A
  supported runtime, or omitting it, warns nothing; the accepted set and the
  hard error for unrecognized runtimes are unchanged.

- 7b7a59f: fix(bb-cron-job,hosting): scope service-principal grants to the deploying account

  - **bb-cron-job**: the EventBridge Scheduler role's trust policy is now limited to
    schedules in the stack's account and region (`aws:SourceAccount` and an `aws:SourceArn`
    schedule-group pattern).
  - **hosting**: removed a redundant CloudFront `kms:Decrypt` statement from the SSE-KMS key
    policy. The Origin Access Control wiring already grants CloudFront decrypt on the bucket key,
    conditioned on `AWS:SourceArn` matching the account's CloudFront distributions.

## 0.3.1

### Patch Changes

- 2806ae2: Ensure the hosting route cutover waits for the resolved client configuration deployment.
- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

## 0.3.0

### Minor Changes

- f2f186c: fix(hosting): DeleteOldBuilds no longer expires the build that is currently served (#480)

  The `DeleteOldBuilds` S3 lifecycle rule expired every object under `builds/`
  after `buildRetentionDays` (default 30), including the build that CloudFront KVS
  `meta.b` currently points to. An app that did not deploy within the retention
  window had its live build's objects expired out from under an otherwise-healthy
  stack — the router kept rewriting to the now-empty prefix, so every static path
  returned 403 (hosting ≤ 0.1.4) or 404 (≥ 0.1.5) while the API path stayed 200.
  Recovery required a redeploy.

  **Fix.** The lifecycle rule now matches only objects tagged
  `aws-blocks:build-state=superseded`. At the KVS cutover, after the pointer flips
  to the new build, the cutover handler tags the _outgoing_ build's objects
  superseded (best-effort; list + tag/untag only — the handler is granted **no** S3
  delete-object permission). The live build is never tagged, so it is never expired,
  regardless of deploy cadence. Superseded builds are still cleaned up after
  `buildRetentionDays`. S3 lifecycle `TagFilters` are inclusion-only (there is no
  "NOT tagged" predicate), which is why the superseded build is tagged rather than
  the live build excluded.

  **Rollback-safety hardening.** The same cutover also _clears_ the build-state tag
  on the _incoming_ build's objects, symmetric to tagging the outgoing one. Without
  this, a rollback that re-points `meta.b` back to a retained build that was tagged
  superseded by an earlier cutover would hand the now-live build to
  `DeleteOldBuilds` — #480 again. Clearing is best-effort and uses
  `s3:DeleteObjectTagging` (tags only, never objects).

  **`buildRetentionDays` is now configurable from `@aws-blocks/core`.** Previously
  `HostingProps` dropped it (only `retainOnDelete` was forwarded), so the only way
  to change retention was an L1 bucket override. It now flows through to the
  hosting bucket lifecycle rule. Must be at least `skewProtection.maxAge`
  (converted to days) or synth throws `InvalidSkewProtectionMaxAgeError`, as
  before.

  **New advisory guard.** An optional `storage.deployIntervalDays` hint emits a
  synth-time **warning** (never an error) when the deploy cadence is at or beyond
  `buildRetentionDays`, i.e. when superseded builds could age out before the next
  deploy and shrink the rollback window. The live build is unaffected, so this is
  a rollback-window note, not a correctness gate.

  Pre-1.0 `minor` per this repo's convention: the change alters the synthesized
  lifecycle rule and the `KvKeys` custom resource (a benign in-place bucket-config
  - Lambda-role update on the next deploy; no bucket replacement), and adds a new
    IAM grant (`s3:ListBucket` + `s3:PutObjectTagging` + `s3:DeleteObjectTagging`,
    scoped to `builds/*`) to the
    cutover handler. Build artifacts uploaded before the upgrade carry no
    `build-state` tag and are therefore never expired by the new rule — including
    the live build — so the upgrade cannot delete a running build; from the next
    deploy onward each superseded build is tagged and reclaimed normally.

### Patch Changes

- 1da58fd: `HostingConstruct`: retain the CDKBucketDeployment custom resources so they're skipped on stack teardown. A BucketDeployment custom resource runs a delete-time handler (object cleanup / CloudFront invalidation — aws-cdk#15891, aws-cdk#23708); when it fails it wedges the whole stack in `DELETE_FAILED`, orphaning the CloudFront distribution. Retaining the CRs removes them from the teardown path so the stack — and its distribution — delete cleanly (object cleanup is handled by the bucket's `autoDeleteObjects` / sandbox teardown). Observed leaking distributions on the high-volume Amplify SSR-adapter e2e (`deployment-type=standalone`), which consumes this construct.
- 4b74c7f: feat(hosting,pipeline): managed-value JSON codec + a public per-stage post-deploy hook

  **`@aws-blocks/hosting` — managed-value JSON codec.** `secret()`/`config()` markers
  are branded with a `Symbol` (and may carry a non-serializable `schema`), so they do
  not survive `JSON.stringify`/`JSON.parse` — the brand is dropped and
  `isManagedValue()` then returns false. Any consumer that carries a config object
  containing markers across a JSON boundary (e.g. serializing per-stage config into a
  build environment variable and reading it back in a later phase) now has a lossless
  round-trip: `encodeManagedValue`/`decodeManagedValue`, the `managedValueReplacer` /
  `managedValueReviver` for use with `JSON.stringify`/`JSON.parse`, plus
  `isManagedValueJSON`, `ManagedValueJSON`, `MANAGED_VALUE_JSON_TAG`,
  `MANAGED_VALUE_JSON_VERSION`, and the typed `ManagedValueCodecError`. The wire form
  is a versioned, cross-build compatibility boundary: `decodeManagedValue` accepts
  `unknown` and validates exhaustively — throwing `ManagedValueCodecError` on an
  unsupported version, unknown kind, or malformed value — while the reviver leaves
  anything that is not an exact wire value untouched (a tagged object carrying extra
  fields is not mistaken for a marker, so no data is silently dropped). A marker's
  `schema` object is not serializable and is not transported, but its operational bit
  is, so a schema-bearing marker round-trips **without silently changing runtime
  behavior** (the far side still JSON-parses the stored value); deep re-validation
  still requires re-declaring the schema on the far side.

  **`@aws-blocks/pipeline` — `postStage` hook.** New optional `postStage` prop on
  `PipelineProps`. It is invoked once per stage with the stage, its config, and the
  resolved pipeline source (`PostStageContext`), and its returned steps are attached
  as that stage's post-deploy steps. When the stage also has a `bakeTime`, the bake
  step is made to depend on the hook's steps, so baking begins only after they
  complete rather than racing them in parallel. This lets a higher-level construct run
  a second per-stage deploy phase (one that needs the first phase's outputs) without
  matching internal construct names to rediscover the stage's source.

  Both additions are backward compatible — new exports and one new optional prop.

## 0.2.0

### Minor Changes

- 9d4ccea: Add `secret()` / `config()` support to hosting and pipeline for self-hosted deployments — externalized values that are never hardcoded in source, committed to git, or written into the CloudFormation template.

  **Two intent functions; the store is implied by which you call.**

  - **`secret('KEY')` → AWS Secrets Manager** — for sensitive values (API keys, tokens, credentials).
  - **`config('KEY')` → SSM Parameter Store** (free tier) — for non-sensitive externalized values (feature flags, a custom domain, a connection ARN).

  The developer never selects a store; it is derived from the function (`storeForKind`), so the CLI write, the IAM grant, the synth-time fetch, and the runtime read can never disagree.

  **Runtime read — two getters, one per store.** `getSecret('KEY')` reads Secrets Manager; `getConfig('KEY')` reads SSM. Each reads its own injected locator env var (`HOSTING_SECRET_PARAM_<KEY>` vs `HOSTING_CONFIG_PARAM_<KEY>`), so the store is unambiguous. Both read `process.env.KEY` first, so **local dev needs no AWS** (put the value in a `.env` file). Values are fetched + decrypted on first use, cached (per-kind `cacheTtlSeconds` for rotation without a cold start; otherwise cached for the process lifetime), and never enter the template. The getters live on the **CDK-free `@aws-blocks/hosting` entry** — the value API (`secret`/`config`/`getSecret`/`getConfig`) is the package's `.`, and its module graph pulls in no CDK, no `fast-glob`, and no `node:fs`, so importing it into an SSR/runtime bundle (including the edge runtime) is safe. Build-time tooling lives off `.` so it never enters a runtime bundle: the CDK construct + resolution engine on `@aws-blocks/hosting/constructs`, and the CLI + typegen engines on `@aws-blocks/hosting/scripts`. (`@aws-blocks/core` already exports a backend `getConfig`, so import the hosting getters from `@aws-blocks/hosting`.)

  **CDK wiring.** In `Hosting` `environment` (and `domain`) a `secret()`/`config()` marker injects only the store _locator_ and grants the compute role least-privilege read (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to the exact ARN) + `kms:Decrypt` (conditioned on `kms:ViaService`). When a `stage` is set the grant covers BOTH the stage locator `<prefix>/<stage>/<key>` and the shared fallback `<prefix>/<key>` (the fallback read is what lets a stage fall back to a shared value), so treat the shared entry as readable by every stage sharing that prefix. A **synth-time** position — `domain.domainName` — accepts only `config()` (or a plain string), never `secret()`: the value is resolved via an SDK read and **inlined as a literal into the template** (a domain must be a literal before CloudFront/ACM), so a secret there would defeat its own purpose; a domain is public anyway. Synth resolution is async, so use `await Hosting.create(...)`. (Runtime `environment` markers still accept both `secret()` and `config()` — those inject only the locator and never inline.) Per-kind namespace/cache config is set via the separate `secretStore` / `configStore` props (`{ prefix, stage, cacheTtlSeconds }`), defaulting to the neutral `/hosting/secrets` and `/hosting/config` prefixes.

  **Namespacing (avoid cross-app collisions).** A **Blocks** app is scoped automatically: the `Hosting` / `Pipeline` blocks and the `npm run secret` / `config` CLIs default to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`, where `stackId` is the app's stable id from the committed `.blocks/config.json`. Both the CLI and the CDK synth read that same file, so two Blocks apps in one account/region never collide, and the write and the read can never diverge (when the file is absent — e.g. a bare test — both sides fall back to the unscoped `/blocks/*` identically). `stackId` is stage-independent (prod and sandbox share it; use the opt-in `stage` segment for per-stage values). A **standalone** hosting/pipeline app (the framework-neutral leaf) has no `.blocks/config.json`, so its defaults (`/hosting/secrets`, `/hosting/config`) stay account-global — give each app its own `secretStore.prefix` / `configStore.prefix` (and matching CLI `--prefix`) when more than one deploys to an account. Use `--region` (or `AWS_REGION`) to write the value in the same region the app deploys to.

  **Bring-your-own (BYO).** `environment` (hosting) and `buildSecrets` (pipeline) also accept an existing CDK `ISecret` / `IParameter` handle alongside the managed markers: the construct grants read via the handle and injects its locator, so `getSecret`/`getConfig` resolve it identically — managed _provisions_, BYO _references_.

  **Pipeline.** `source.connectionArn` accepts a `config()` marker (resolved to a literal at synth; a connection ARN is a reference inlined into the template, so `secret()` is a type error there — same rule as `domain`). `buildSecrets` accepts `secret()` markers or BYO `ISecret` handles and wires them as CodeBuild `SECRETS_MANAGER` env vars fetched at build time (masked in logs, never inlined) — build-time credentials are secrets, so this surface is Secrets-Manager-only. Namespace config via `secretStore` / `configStore`.

  **CLI.** `secret set|list|remove` (Secrets Manager) and `config set|list|remove` (SSM), sharing one engine (`setValue`/`listValues`/`removeValue`/`runValueCli`). Blocks apps get `npm run secret` / `npm run config` (scoped per app to `/blocks/<stackId>/secrets` and `/blocks/<stackId>/config`); standalone/pipeline apps get the `hosting-secret` and `hosting-config` bins. A **secret** value is never read from argv/shell history — `secret set` takes it from a hidden prompt or `--value-stdin` (a positional value is a hard error); a non-sensitive **config** value may be passed positionally. `list` prints names only, never values. All commands accept `--prefix`, `--stage`, and `--region` (write to the same region the app deploys to).

  **Type-safe reads (zero code) — `getSecret` / `getConfig` autocomplete + typo errors.** The runtime getters are typed against two augmentable registries (`HostingSecretRegistry` / `HostingConfigRegistry`): empty by default they accept any `string` (unchanged, non-breaking), and once populated they narrow to your declared keys — editor autocomplete, and a typo (or reading a `config` key via `getSecret`, i.e. the wrong store) becomes a compile error. You populate them with **no code change** via the new `hosting-typegen` CLI (`npm run typegen`, `--watch` to regenerate on save, `--check` for CI): it statically scans your `secret('...')` / `config('...')` calls (TypeScript compiler API — no app execution, no AWS credentials) and generates a `.d.ts` (`.blocks/hosting-values.d.ts`) that augments the `@aws-blocks/hosting` entry (where the getters live), narrowing them to your declared keys. The generated file is derived from your `secret()`/`config()` calls, and `--check` fails CI when it's stale. Add `.blocks/**/*.d.ts` to your tsconfig `include`. In a Blocks app this is automatic: the dev server (`npm run dev`) auto-detects `secret()`/`config()` usage and runs the generate-and-watch step itself (a no-op when the app declares no secrets, and non-fatal), so keys update as you type with no second command; standalone hosting apps use `hosting-typegen --watch`.

  **Typed, parsed values via a schema.** `secret('KEY', { schema })` / `config('KEY', { schema })` accept any Standard Schema (Zod, Valibot, ArkType — typed as `StandardSchemaV1`, library-neutral). `typegen` builds a TypeScript `Program`, infers the schema's output type, and inlines it into the generated `.d.ts`, so **`getSecret`/`getConfig` return the inferred type** (e.g. `const { beta } = await getConfig('FEATURE_FLAGS')`) instead of `string` — no `JSON.parse(...)` and no `any`. At runtime the value is JSON-parsed (a per-key flag is injected at synth); the schema itself isn't shipped to the runtime, so this is parse-to-type, not a deep re-validation across the bundle boundary.

  **Templates.** `@aws-blocks/create-blocks-app` templates scaffold a `secret` script (`npm run secret`) wired to the Blocks CLI, and a `typegen` script (`npm run typegen` → `runTypegenCli` from `@aws-blocks/blocks/scripts`) with `.blocks/**/*.d.ts` added to the tsconfig `include`, so a newly-created app can manage secrets and get type-safe `getSecret`/`getConfig` out of the box.

## 0.1.10

### Patch Changes

- dd2350b: Trim the `KvKeys` custom resource IAM policy to true least privilege: it now grants only `cloudfront-keyvaluestore:DescribeKeyValueStore` and `UpdateKeys` — the two actions the deploy-time handler actually calls. The previously-granted `ListKeys`, `GetKey`, `PutKey`, and `DeleteKey` are dropped.

  This also makes the hosting stack deployable under restrictive Service Control Policies (SCPs) / permission boundaries that deny `cloudfront-keyvaluestore:ListKeys`, which previously blocked the deploy.

  Behavior is preserved: `ListKeys` was only used to diff against the live store on Create, but the route-table `KeyValueStore` is created fresh with no `ImportSource`, so it is empty at Create time — the handler now diffs Create against `{}`. The Update path still diffs against the prior template's entries and Delete still drains via `deleteDrainSet()`, neither of which used `ListKeys`.

## 0.1.9

### Patch Changes

- 940956e: fix(hosting): encrypt the alarm SNS topic by default, with a key policy CloudWatch can actually use

  The monitoring construct's auto-created alarm topic was unencrypted. It now gets
  a dedicated customer-managed KMS key (`MonitoringAlarmTopicKey`) whose policy
  grants `cloudwatch.amazonaws.com` `kms:Decrypt` + `kms:GenerateDataKey*` in
  addition to the usual account-root administration statement.

  Both halves matter. Encrypting the topic makes hosting secure-by-default, and
  the CloudWatch grant is what keeps alarms working once it is encrypted: when an
  SNS topic used as a CloudWatch alarm action is KMS-encrypted, the key policy
  must grant the `cloudwatch.amazonaws.com` service principal, because CloudWatch
  calls KMS **directly** (not via SNS) and an account-root `kms:*` statement does
  not cover AWS service principals. Without the grant, CloudWatch's publish fails
  with `KMSAccessDenied` and notifications are dropped silently — the alarm still
  transitions to ALARM in the console, so the only symptom is the notification
  that never arrives.

  An AWS-managed key (`alias/aws/sns`) cannot be used instead: its key policy is
  not editable and does not grant CloudWatch, so a customer-managed key is the
  only option that can carry the grant.

  The grant is scoped to just those two actions for that one service principal on
  a single-purpose key, plus a `StringEqualsIfExists` guard on `aws:SourceAccount`
  against cross-account confused-deputy use. `IfExists` is deliberate:
  `aws:SourceAccount` is only populated on direct service-principal calls, and a
  hard `StringEquals` would reintroduce the very silent deny this grant exists to
  prevent.

  No configuration changes: encryption is unconditional, with no opt-out knob to
  weaken it. The only API addition is a read-only `encryptionKey` accessor on
  `MonitoringConstruct`, alongside the existing `topic` and `alarms`, so callers
  can grant additional publishers on the key. Callers who need different key
  management continue to pass their own `snsTopic` / `snsTopicArn` and own that
  topic's encryption. Note the KMS key adds roughly $1/month per stack, and
  monitoring is on by default; `monitoring: { enabled: false }` or a BYO topic
  avoids it.

- 4981137: fix(hosting): disable installLatestAwsSdk on the CDN invalidation custom resource

  The `DeployInvalidation` `AwsCustomResource` in `CdnConstruct` left
  `installLatestAwsSdk` at its CDK default of `true`. That default makes the
  custom-resource provider Lambda `npm install` the AWS SDK at invoke time,
  adding roughly 15-30s of cold start and forcing a 512MB memory floor on the
  provider function.

  Nothing here needs a newer SDK than the runtime ships. The resource makes a
  single `CloudFront.createInvalidation` call — a long-stable API already bundled
  in the Lambda runtime's AWS SDK v3. And unlike a one-off resource, this one
  fires on _every_ hosting deploy (its `CallerReference`/`physicalResourceId` are
  keyed on `buildId`), so the install cost was paid on every deploy rather than
  once.

  Setting `installLatestAwsSdk: false` removes that per-deploy penalty and also
  silences CDK's `installLatestAwsSdkNotSpecified` warning for this construct.
  No public API or template change beyond the `InstallLatestAwsSdk: false`
  property on the synthesized `Custom::AWS` resource; invalidation behavior,
  IAM policy, and deploy ordering are unchanged.

- 5c58c53: fix(hosting): deploy SSR framework Lambdas on nodejs24.x and throw on unrecognized runtimes instead of silently falling back to nodejs20.x

  SSR framework compute (Nuxt/Nitro, Astro, SvelteKit, Next.js regional) now runs on
  `nodejs24.x` via a shared `FRAMEWORK_COMPUTE_RUNTIME` constant, and `resolveRuntime()`
  recognizes `nodejs24.x`, defaults to it when no runtime is declared, and throws
  `UnsupportedRuntimeError` for unrecognized runtimes rather than silently returning
  Node 20. Lambda@Edge compute (`FRAMEWORK_EDGE_COMPUTE_RUNTIME`) is bumped to
  `nodejs24.x` as well: Lambda@Edge draws Node.js versions from the same managed runtime
  table as regional Lambda, where `nodejs24.x` is supported and `nodejs20.x` is already
  past deprecation. The OpenNext edge bundle banner patch was revalidated — the crash it
  works around comes from ES Module namespace exports being non-writable per spec, not
  from any Node-20-specific behavior.

## 0.1.8

### Patch Changes

- 0284e5b: fix(hosting): serve HTML from the current build after a deploy (fixes returning-visitor blank page)

  Returning visitors — browsers holding a `__dpl` skew-protection cookie from a
  previous build — got a blank page on their first load after every deploy (a
  second reload fixed it). The KVS router's viewer-request function honored the
  `__dpl` cookie for **all** URIs including HTML, so a returning visitor was served
  the **old** build's HTML, while the viewer-response function stamped `__dpl` with
  the **current** build on every HTML response. The old HTML references
  content-hashed assets that only exist under the old build's prefix; with the
  cookie now advanced to the new build, those asset requests were rewritten to
  `/builds/<newBuildId>/…<oldHash>` (which does not exist) and failed (403 on
  0.1.4, 404 on ≥ 0.1.5), rendering a blank page.

  The viewer-request function now resolves HTML documents from the current build
  (`meta.b`), never a pinned cookie build, while assets keep honoring the cookie.
  HTML, cookie, and referenced assets therefore always agree on one build
  generation. Mid-session visitors stay safe: asset requests keep honoring their
  old cookie and old `builds/<id>/` prefixes are retained (`prune: false`), so an
  already-loaded page keeps working until the next HTML navigation lands the
  visitor consistently on the current build.

## 0.1.7

### Patch Changes

- b09e568: Add a SvelteKit framework adapter. SvelteKit apps are now auto-detected (via
  `@sveltejs/kit`) and deployed through `@sveltejs/adapter-node` running on Lambda
  behind the Lambda Web Adapter (the existing `http-server` compute path), fronted
  by CloudFront + S3. Supports SSR pages, `+server.js` endpoints, form actions,
  server `load`, `hooks.server`, streaming, prerendered/SSG pages (served frozen
  from S3), custom headers, cookies, redirects, `error()`, and `paths.base`. A
  transparent build bridge wires `@sveltejs/adapter-node` when the app hasn't
  configured it, so no manual setup is required. Patch (not minor) per the
  pre-1.0 caret convention — the change is additive and backward-compatible.

## 0.1.6

### Patch Changes

- 9586841: docs(hosting): document custom domain configuration (Route 53 and bring-your-own DNS)

## 0.1.5

### Patch Changes

- 71eb746: Fix eleven reproducible hosting issues:

  - **Astro SSR `/_image` content-type**: the SSR bundle now ships a linux-x64 `sharp` (installed post-build into `dist/server/node_modules`, wasm fallback pruned, ~19.5 MB), so Astro's default `sharp` image service works on Lambda and `/_image` returns a real optimized image with a correct MIME (`image/png`/`image/webp`) instead of the `noop` passthrough's `content-type: image/null`. Gated on the app using the sharp service; apps that pick `noop`/custom are skipped. A dedicated image Lambda isn't feasible for Astro (it fuses `/_image` into the SSR bundle via the `astro:assets` virtual module, unlike Nuxt IPX / OpenNext).

  - **Next image optimizer on Next 15.x**: the `fetchInternalImage` arity patch was gated on an inverted version assumption (the `maximumResponseBody` parameter was added in Next 16, not 15.5). It now only applies on Next ≥ 16, so local image optimization no longer 500s on Next 15.x apps. Renamed `patchImageOptimizerForNext155` → `patchImageOptimizerForNext16`.
  - **Image optimizer on disallowed types (SVG)**: an untrusted SVG (with `dangerouslyAllowSVG` disabled) now fails closed with its real `400` status instead of a blanket `500` — OpenNext was catching Next's 400 in a generic block that discarded the status.
  - **SPA hashed assets**: the SPA adapter now marks Vite's content-hashed `assets/*` bundles `immutable` (`immutablePaths: ['assets/*']`) instead of leaving them in the revalidation-only cache tier.
  - **Missing static assets**: the OAC bucket policy now grants `s3:ListBucket` so a missing key returns a clean `404 NoSuchKey` instead of leaking `403 AccessDenied` XML to the viewer.
  - **RSC prefetch cache efficiency**: the SSR cache policy excludes Next's random `_rsc` prefetch query param from the cache key (`denyList('_rsc')`), so prefetches of the same page share one edge cache entry.
  - **Wildcard redirects**: Next `:path*` named-catch-all redirects are now lifted to the edge router (converted to `/*`), with a bare-prefix companion redirect, so they no longer leak the literal `:path*` token in `Location`.
  - **Route-table budget**: `TooManyRoutesError` now names which table (routes/redirects/headers) exceeded the budget and calls out `trailingSlash: true` as the likely driver, and the previously-hardcoded 64-chunk cap is now tunable via the `quotas.maxRouteChunks` hosting prop (default 64) for very large sites with measured edge-function headroom.
  - **Nuxt ISR/SWR on-demand pages**: when ISR/SWR is active (`manifest.cache` set), route coalescing now folds a prerendered static sibling group into a single `parent/*` **compute** wildcard (instead of a static one), so a non-prebuilt on-demand child renders at the SSR Lambda instead of hard-404ing from S3 — while the route table stays bounded (one row per parent), avoiding the CloudFront-Function compute-limit 503 a non-coalesced fan-out would cause.
  - **CloudFront S3-origin policy**: every behavior whose origin is S3 — the default behavior AND the edge-route (`runtime: 'edge'`) behavior — now uses a synthesized custom origin request policy instead of the managed `ALL_VIEWER_EXCEPT_HOST_HEADER`, which CloudFront rejects on S3 origins (`InvalidRequest` at distribution create). The sentinel behaviors keep the managed policy (their origins are the tagged server/image custom origins, not S3). A regression guard asserts no S3-origin behavior references a managed origin request policy.
  - **Nuxt IPX remote images**: the IPX image Lambda now rides the shared SSR API Gateway (via a dedicated `<baseURL>/{proxy+}` resource) instead of an OAC Function URL, so an unencoded `://` in a remote source path no longer breaks SigV4 (was `403 InvalidSignatureException`); and the IPX runtime is configured with `httpStorage` scoped to the allowlisted domains so allowlisted remote images resolve instead of `404 IPX_RESOURCE_NOT_FOUND`.

- 71eb746: Verify the Next.js adapter against OpenNext 4.0.x. An OpenNext 4.0.3 integration deploy confirmed all four bundle patches (streaming wrapper, edge-bundle process banner, `fetchInternalImage` arity insertion, and SVG-status catch rewrite) still match the 4.0.x minified shape, and the live app served optimized rasters, a fail-closed SVG (400), edge routes, and redirects with no regressions. `VERIFIED_OPENNEXT_RANGE` now covers `>=3.10.0 <3.11.0 || >=4.0.0 <4.1.0` so apps on OpenNext 4.0.x no longer trip the out-of-range warning.

## 0.1.4

### Patch Changes

- 9075b81: Fix four hosting correctness bugs:

  - **Base path is now a first-class `Hosting` prop, and Nuxt `app.baseURL` is modelled.** Added a caller-declared `basePath` option to `Hosting` (e.g. `{ basePath: '/app' }`) — the recommended, framework-agnostic source of truth that CloudFront behaviors are prefixed with (plus a root→`/<basePath>/` 308 redirect). When the prop is omitted, the Nitro adapter now detects Nuxt's `app.baseURL` from the build output and sets `manifest.basePath` (parity with Next `basePath` / Astro `base`); previously it was silently dropped, so a Nuxt app with a base path deployed broken — pages rendered but their hashed `/<base>/_nuxt/*` assets 404'd (no hydration). If a base path is detected in the prerendered output but can't be read, synth fails loud instead of shipping a broken site.
  - **Per-pattern header rules delegate to the SSR runtime instead of competing for CloudFront behavior slots.** For SSR (compute) deploys, a header rule whose pattern has no dedicated behavior is no longer wired as its own CloudFront behavior — the request falls through to the catch-all SSR Lambda, which already emits the framework's `headers()` / `routeRules` at runtime (CloudFront caches the response including those headers). This removes redundant behaviors that burned the scarce ~25-behavior budget and re-asserted a header the origin already sets, and it means SSR header rules can never trip the behavior cap. For **static-only** deploys (S3 origin, no runtime to emit the header) the cap still applies: a rule that would exceed it throws if it sets a security header (CSP, HSTS, X-Frame-Options, … — a lost CSP otherwise looks like a successful deploy) and is dropped with a warning if it's cosmetic.
  - **config.json deploy ordering is now wired correctly.** The resolved `config.json` deployment now depends on the asset deployments so the build's placeholder config can't clobber it. The previous `tryFindChild('AssetDeployment')` never matched the real child ids and the dependency was silently never created.
  - **AWS service quotas are now centrally accounted, configurable, and degrade gracefully.** A new `QuotaBudget` module centralizes the previously-scattered, hardcoded limits (CloudFront cache behaviors, Lambda@Edge associations, and the account-wide response-headers-policy quota — the last of which was previously unguarded and blew up opaquely at deploy time). Three things change:
    - **Configurable:** a new `quotas` prop on `Hosting` (`{ cacheBehaviors?, edgeFunctions?, headerPolicies? }`) lets accounts that have been granted a Service Quota increase raise the corresponding ceiling, instead of hitting a hardcoded throw at the AWS default. Each field documents that synth cannot verify the real granted quota, so an over-set value just moves the failure to deploy time.
    - **Graceful degradation (SSR):** when prerendered pages would exceed the behavior budget on a compute deploy, the lowest-priority pages are demoted to the SSR runtime (served by the catch-all Lambda) instead of failing the build — deterministically, and never touching hashed-asset prefixes, edge routes, image-opt, or non-default compute origins.
    - **Grouping (static-only):** when co-located sibling pages would exceed the budget on a static deploy (no runtime to demote to), they collapse into one `<parent>/*` behavior — lossless, since every path under the parent resolves from S3 either way.
    - **Deploy-fail guards for hard limits:** the static-asset upload Lambda (CDK's `BucketDeployment`) is now sized to 1024 MB / 1024 MiB `/tmp` (up from CDK's 128 MB / 512 MiB defaults, which large sites silently overran with an opaque CloudFormation failure), overridable via `storage.deployment`. Synth also now emits a warning as a stack approaches CloudFormation's hard 500-resource-per-stack limit, so the operator can split the stack before a deploy fails opaquely.

## 0.1.3

### Patch Changes

- 162c47d: fix(hosting): stop hardcoding image-optimization Lambda reserved concurrency

  The image-optimization Lambda hardcoded `reservedConcurrency: 10`, which made `cdk deploy` fail on fresh AWS accounts (the default account-level unreserved-concurrency limit is also 10, so reserving all 10 drops the account below its required minimum and Lambda returns a 400). It now defaults to no reservation and exposes `compute.imageOptimization.reservedConcurrency` so operators with headroom can still cap it.

## 0.1.2

### Patch Changes

- 42adb51: Fix multi-page routing for static sites (Astro static, SSGs). The L3 no longer infers SPA-vs-multi-page from the presence of error pages; adapters now declare `staticAssets.spaFallback` explicitly. The Astro adapter sets `spaFallback: false` (static Astro is always multi-page), and the generic adapter sources it from the framework contract (`spa` → single-page, `static` → multi-page). Multi-page static sites without their own `404.html` now get a built-in default 404 page (served at HTTP 404) instead of CloudFront's raw error. Adds a `hosting-ssr-astro` e2e test app.

  **Migration**: If you were passing `framework: 'static'` and relied on SPA-fallback routing (extensionless paths → /index.html), switch to `framework: 'spa'`. `framework: 'static'` now always produces multi-page directory-index resolution.

- 061a0b2: fix(hosting): make redeploys atomic by uploading assets before the CloudFront build-id cutover, eliminating the 403 window for new visitors during deployment

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements

## 0.1.0

Initial version
