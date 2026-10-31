# @aws-blocks/auth-common

## 0.3.0

### Minor Changes

- aaa90b6: AuthBasic now revokes the session token server-side on sign-out. Each session
  JWT carries a unique `jti`; `signOut` records that id on a revocation list (in
  the existing codes store, expiring with the token) so a replayed cookie is
  rejected even though the JWT is still unexpired and signature-valid. The
  umbrella `@aws-blocks/blocks` is bumped because the bundled `bb-auth-basic`
  README/DESIGN docs it mirrors have changed.

  This is a `minor` (not `patch`) bump because it adds exported error constants —
  `AuthBasicErrors.SessionRevoked` (`SessionRevokedException`, thrown by
  `requireAuth` for a signed-out/revoked session, vs `SessionExpiredException` for
  an absent/aged-out one) and `AuthBasicErrors.SignOutIncomplete`
  (`SignOutIncompleteException`, 503, thrown when the revocation write fails) —
  and documents a new throwable name on the shared `BlocksAuth.requireAuth`
  contract in `@aws-blocks/auth-common`.

  `signOut` always clears the local cookie (so sign-out on this device never
  leaves the user stuck signed in), even when the server-side revocation write
  fails; in that case it throws a stable `SignOutIncompleteException` rather than
  the raw SDK error, so no `$metadata`/ARNs leak to the client.

  Legacy-surface behavior change: the deprecated `buildApi().signOut` previously
  always resolved to `{ success: true }`; it now awaits `signOut` and so can
  reject with `SignOutIncompleteException` (503) when the revocation write fails.
  Only direct `buildApi` callers are affected — the `createApi()` state machine
  catches it into the `AuthState.error` field.

  Operator note: the `codes` store gains `{ ttl: true }`. For an already-deployed
  AuthBasic app this is an in-place DynamoDB TimeToLive enablement (an `UpdateTable`)
  on the next `cdk deploy` — no data migration, and correctness does not depend on
  the reaper (reads filter expired items regardless). Caveat: DynamoDB rejects
  another `UpdateTimeToLive` on the same table for ~1 hour after a change, so if an
  unrelated resource fails in the same deploy, CloudFormation rollback (which
  disables TTL) — or a deploy → rollback → redeploy within that hour — can land in
  `UPDATE_ROLLBACK_FAILED`. Deploy AuthBasic apps with this in mind.

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

- f704a68: feat(auth-common): add the `StatusMessage` UI primitive

  Adds `StatusMessage` to `@aws-blocks/auth-common/ui` (re-exported from `@aws-blocks/blocks/ui`) — a themed, accessible status line for the loading / success / error affordance the starter templates otherwise hand-roll with inline styles.

  - `StatusMessage(options?)` returns a `StatusMessageHandle` (`{ element, set }`): mount `element`, then drive it with `set(kind, text)` as an async operation progresses.
  - Four lifecycle states (`StatusKind`): `idle` (muted), `loading` (muted + spinner), `success` (green), `error` (red) — all driven by the existing `--bb-*` semantic tokens, so the message matches the active light/dark theme.
  - The root is a polite ARIA live region (`role="status"`, `aria-live="polite"`); the `loading` spinner is decorative (`aria-hidden`) and holds still under `prefers-reduced-motion`.
  - Adds the `.bb-status*` / `.bb-spinner` classes and a reduced-motion-aware `bb-spin` keyframe to the shared theme CSS.
  - The `auth-cognito` template now renders its status lines through `StatusMessage` instead of a hand-built classed span.

  No breaking changes — purely additive.

### Patch Changes

- 33edca2: Add `submitAuthAction(api, input)` — a browser-only helper that calls `setAuthState` and then drives the local auth notification so `onAuthChange` subscribers and `AuthenticatedContent` re-render on a real signed-in/signed-out transition. This closes the `setAuthState` → `onAuthChange` reactivity gap where a custom auth UI stayed stale unless it also called `broadcastAuthChange` by hand. The framework's own `Authenticator` now routes every action through `submitAuthAction` as the single notifier, so there is no double-fire; challenge/retriable states are not broadcast. Fixes #185.
- d366907: chore: manual dependency bump (2026-10-19)
- Updated dependencies [0765f84]
- Updated dependencies [5572341]
- Updated dependencies [88747f5]
- Updated dependencies [1076ccc]
- Updated dependencies [928c48a]
- Updated dependencies [4d5ea86]
- Updated dependencies [90c1b12]
- Updated dependencies [50b8c94]
- Updated dependencies [ce5dfa9]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [9a32674]
- Updated dependencies [48c35f6]
- Updated dependencies [8c73a24]
- Updated dependencies [48c35f6]
- Updated dependencies [4553866]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [54e9443]
- Updated dependencies [48c35f6]
- Updated dependencies [d366907]
- Updated dependencies [91ed1fc]
- Updated dependencies [48c35f6]
- Updated dependencies [d062eeb]
- Updated dependencies [c22eeee]
- Updated dependencies [1546160]
- Updated dependencies [9c96135]
- Updated dependencies [63b154f]
- Updated dependencies [8565ef7]
- Updated dependencies [ce5dfa9]
- Updated dependencies [515089c]
- Updated dependencies [dde6340]
- Updated dependencies [7477b6e]
- Updated dependencies [6a53068]
- Updated dependencies [dd5e807]
- Updated dependencies [db15b5e]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [48c35f6]
- Updated dependencies [72e3259]
- Updated dependencies [48c35f6]
- Updated dependencies [8565ef7]
- Updated dependencies [48c35f6]
- Updated dependencies [0d4ede3]
- Updated dependencies [63b154f]
- Updated dependencies [b6b8ade]
- Updated dependencies [82ea78a]
- Updated dependencies [e44ac0c]
- Updated dependencies [33e8d73]
- Updated dependencies [b003705]
- Updated dependencies [48c35f6]
  - @aws-blocks/core@0.8.0

## 0.2.0

### Minor Changes

- 8ca3692: feat: shared, framework-neutral `ui-theme` design-token layer

  Introduce a design-token layer for the Blocks UI so the shared Auth
  components and the starter templates share one consistent, polished look
  with no new runtime framework dependency.

  - `@aws-blocks/auth-common` ships a new theme module: CSS custom
    properties (`--bb-*` for color, spacing, radius, typography, elevation)
    on `:root`, a light and dark palette driven by `prefers-color-scheme`
    with a `data-bb-theme` override hook, and base `.bb-*` component
    classes. The palette declares `color-scheme` so UA-drawn widgets
    (checkboxes, `<select>`, scrollbars, `::placeholder`, autofill) follow
    the active palette, and `.bb-button` has a `:disabled` state. A new
    idempotent, SSR-safe `injectTheme()` adds the stylesheet to the document
    once. The shared `Authenticator`, `AccountMenuBar`, and
    `AuthenticatedContent` now render against these token classes instead
    of inline styles and inject the theme themselves, so the themed look
    travels with the component into any host (lit-html, vanilla, React,
    Next.js) with zero wiring. Every `data-testid` is preserved.
  - `@aws-blocks/blocks` re-exports `injectTheme`, `THEME_CSS`, and
    `THEME_STYLE_ID` from `@aws-blocks/blocks/ui`, and adds a lean
    `@aws-blocks/blocks/theme` subpath that re-exports ONLY the token layer
    (no `Authenticator`/WebAuthn surface) for non-auth hosts. `@aws-blocks/auth-common`
    is marked `sideEffects: false` so a bundler can drop the unused UI
    surface; `@aws-blocks/blocks` is not, because as an aggregator that
    re-exports side-effecting building blocks it is not side-effect-free.
  - `@aws-blocks/create-blocks-app` templates (`default`, `react`,
    `nextjs`, `demo`, `auth-cognito`) adopt the tokens for their own page
    chrome and todo UI, so the whole page is themed and dark-mode-aware;
    the `bare` template stays deliberately minimal. The static templates
    inline the first-paint palette and the `nextjs` template server-renders
    the token `<style>` so a dark-mode user never sees a white flash before
    the bundle runs. A `--bb-color-success` token keeps success messages
    from reading as accent blue.

  Focus states use a real `outline` ring (preserved under forced-colors /
  Windows high-contrast mode) rather than an `outline: none` + `box-shadow`
  ring, which such modes drop.

  Additive and non-breaking.

### Patch Changes

- Updated dependencies [ec7eebe]
- Updated dependencies [e682ba7]
- Updated dependencies [e7e96e6]
- Updated dependencies [9ebda66]
- Updated dependencies [78f4396]
- Updated dependencies [440ecce]
- Updated dependencies [1a5c18e]
- Updated dependencies [4ae500e]
- Updated dependencies [6d764f7]
- Updated dependencies [5d6656a]
- Updated dependencies [60616b1]
- Updated dependencies [a50fb46]
- Updated dependencies [8a1a4a9]
- Updated dependencies [38ce80c]
- Updated dependencies [94a914a]
- Updated dependencies [cb0ec01]
- Updated dependencies [005c095]
- Updated dependencies [b8649dc]
- Updated dependencies [2da2fd4]
- Updated dependencies [66f4be2]
- Updated dependencies [32a4b73]
- Updated dependencies [da6d4c7]
- Updated dependencies [e3e5e22]
- Updated dependencies [e9241b5]
- Updated dependencies [f1eb149]
- Updated dependencies [122c49c]
- Updated dependencies [7c19c4f]
  - @aws-blocks/core@0.7.0

## 0.1.9

### Patch Changes

- 4456fd7: Document the full `AuthState` shape returned by `getAuthState()`/`setAuthState()` (`errorName`, `retriable`, and the `confirmingSignIn` state) in the auth READMEs, and note that `bb-auth-cognito` / `bb-auth-oidc` consumers import the type from `@aws-blocks/auth-common`.
- fac0e75: fix(auth-common): Enter submits the Authenticator form from any field, not just the last

  The rendered auth form isn't a native `<form>`, so submit-on-Enter is wired
  explicitly — but the handler was bound only to the _last_ visible input. In any
  multi-field form, pressing Enter in an earlier field did nothing: the username in
  a username+password sign-in, or the verification code in a code+newPassword
  confirm-reset form. Enter now submits from every visible field, matching native
  form behavior.

- Updated dependencies [5501cb6]
- Updated dependencies [b58f248]
- Updated dependencies [39628cb]
- Updated dependencies [d4b32f2]
- Updated dependencies [a649895]
- Updated dependencies [27646ac]
- Updated dependencies [5515483]
- Updated dependencies [757d4a9]
- Updated dependencies [a23b8d8]
- Updated dependencies [9e02b82]
- Updated dependencies [465a002]
  - @aws-blocks/core@0.6.0

## 0.1.8

### Patch Changes

- 5eee114: Add npm keywords for discoverability via `npm search keywords:aws-blocks`

  Every published package now carries an npm `keywords` array: the shared `aws-blocks`
  discovery tag plus 2–5 functional keywords describing the package's domain and the
  AWS services it uses (e.g. `realtime`, `websocket`, `pubsub` for `bb-realtime`;
  `ci-cd`, `pipelines`, `deployment` for `pipeline`). Metadata only — no runtime,
  API, or behavior change.

- Updated dependencies [2806ae2]
- Updated dependencies [f552ebe]
- Updated dependencies [9aa0814]
- Updated dependencies [012cd89]
- Updated dependencies [5eee114]
- Updated dependencies [d7312f9]
- Updated dependencies [21443ba]
- Updated dependencies [acd1628]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [6496713]
- Updated dependencies [302090a]
  - @aws-blocks/core@0.5.0

## 0.1.7

### Patch Changes

- Updated dependencies [df667c5]
- Updated dependencies [df667c5]
- Updated dependencies [64ddd74]
- Updated dependencies [df667c5]
- Updated dependencies [646614b]
- Updated dependencies [c45eb92]
- Updated dependencies [4a830a6]
- Updated dependencies [f2f186c]
- Updated dependencies [46b7c89]
- Updated dependencies [1da58fd]
  - @aws-blocks/core@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [5798492]
- Updated dependencies [f00adb0]
- Updated dependencies [f00adb0]
- Updated dependencies [08ab129]
- Updated dependencies [9d4ccea]
- Updated dependencies [5bfae0a]
- Updated dependencies [0ac3879]
- Updated dependencies [e4dac4a]
  - @aws-blocks/core@0.3.0

## 0.1.5

### Patch Changes

- Updated dependencies [7b4c62d]
- Updated dependencies [5262062]
- Updated dependencies [3614a09]
- Updated dependencies [5262062]
- Updated dependencies [5071079]
- Updated dependencies [8966cfb]
- Updated dependencies [b11a75b]
  - @aws-blocks/core@0.2.0

## 0.1.4

### Patch Changes

- 75f5446: Add optional `fallback` parameter to `AuthenticatedContent` for rendering alternative content when the user is not authenticated.
- 2ed4177: Add stable `data-testid` hooks to the auth UI components so e2e suites can target the shipped `Authenticator` instead of forking it. Covers every interactive element (field inputs, hidden ones included, and submit buttons) plus the containers worth asserting against: the root, per-action wrappers, heading, error, the signed-in marker, `AuthenticatedContent`, and `AccountMenuBar`. Presentational markup such as hint text and layout wrappers stays unhooked. The full selector contract, including the `<action>:<provider>` form federated actions produce, is documented in CUSTOMIZING-AUTH-UI.md.

  The `@aws-blocks/blocks` umbrella package receives a `patch` because it re-exports these components from `@aws-blocks/auth-common/ui`. Sibling patch releases stay inside the umbrella's caret ranges, so `changeset version` never bumps it on its own (#212), and it is republished explicitly to stay in step with the components it hands to consumers.

- 58f77dd: Document four things people were reverse-engineering from compiled output.

  - **Runtime config resolution.** The client config is served at the dotted path `/.blocks-sandbox/config.json`; `/config.json` is not a route, so a 404 there means nothing. `{"_placeholder":true}` in the frontend build output is the Hosting construct's synth-time stub (the real `apiUrl` is still an unresolved CloudFormation token), so it is expected pre-deploy rather than a broken config. Covers the resolution order, what each environment should actually return, and what a genuine failure looks like.
  - **`RawRoute`.** Full section in the core README: constructor signature, a `GET` example that sets status, `Content-Type` and body, what you can read off `ctx.request` and write to `ctx.response`, path/parameter/wildcard syntax, and the registration rules (reserved paths, duplicate routes, register-during-load). Also added a "serve a raw HTTP endpoint" entry to the block catalog decision tree, which had no pointer to it.
  - **Server-initiated OIDC sign-in.** New section in the `bb-auth-oidc` README for `GET /aws-blocks/auth/signin/<provider>`: the redirect chain through the IdP and the callback, the pending-auth and session cookies, the JSON error shape, a runnable `curl` walkthrough, when to use it instead of the client PKCE API, and a pointer to the integration tests that assert each response. One route is mounted per configured provider, so an undeclared provider name 404s instead of reporting `ProviderNotConfiguredException`, which comes from `getSignInUrl()`.
  - **Error and RPC semantics.** `ApiError`'s constructor arguments (including `cause` staying server-side and `retriable`), how its `status` becomes the JSON-RPC error code and decodes back into an `ApiError` on the client, `hasAuthError`'s signature and when it applies instead of `isBlocksError`, how `params` is read as positional args vs a named object, that a top-level JSON array body (a batch) is rejected with `-32600`, and that `broadcastAuthChange` comes from `@aws-blocks/blocks/ui` rather than the package root.

  Docs only, plus tests locking in the documented `ApiError`, `params` and batch-rejection behaviour, and the documented `404`s on the OIDC sign-in and sign-out routes.

- Updated dependencies [b48aaec]
- Updated dependencies [ac0966a]
- Updated dependencies [9de27dd]
- Updated dependencies [8e96d87]
- Updated dependencies [58f77dd]
- Updated dependencies [2d3dfdc]
  - @aws-blocks/core@0.1.17

## 0.1.3

### Patch Changes

- 1da34f1: fix(auth): propagate the structured error name through `setAuthState()`

  The recommended client auth path is `createApi()` → `setAuthState()`. When an
  action failed, `setAuthState()` caught the thrown `ApiError` and returned an
  `AuthState` carrying only `error: e.message`, discarding the structured
  `e.name` (e.g. `'InvalidCredentialsException'`). Because `AuthState` had no
  field for an error name, a hand-rolled client could not branch on error type
  (e.g. "try sign-in, fall back to sign-up for a brand-new user") without
  brittle string-matching the human-facing message.

  `AuthState` now carries an optional `errorName`, and the `bb-auth-basic` and
  `bb-auth-cognito` `setAuthState` implementations populate it from the thrown
  `ApiError.name` (skipping the generic `'ApiError'` default). A new
  `hasAuthError(state, name)` type guard in `@aws-blocks/core` lets clients
  branch on the returned state — `isBlocksError` only matches thrown `Error`
  instances, so it cannot be used on the plain `AuthState` object. Rule of
  thumb: throw path → `isBlocksError`; returned `AuthState` → `hasAuthError`.

- Updated dependencies [f42c604]
- Updated dependencies [1da34f1]
  - @aws-blocks/core@0.1.6

## 0.1.2

### Patch Changes

- ba3bf7b: docs: add per-package DESIGN.md documents

  Adds a `DESIGN.md` to each building-block package describing its architecture, API surface, mock implementation, and key design decisions.

  - Each document is cross-checked against the current source so identifiers, environment variables, error names, and described behavior match the implementation.
  - Each `DESIGN.md` is listed in its package's `files` array so it ships on npm alongside `README.md`.
  - For consistency, `bb-auth-cognito`'s document lives at the package root like every other package.
  - Bumps the umbrella `@aws-blocks/blocks` package so its bundled `docs/` — assembled from these block READMEs at build time — republishes with a fresh version. Its packed content changes whenever the READMEs change, but the version was previously left untouched, which tripped the publish integrity guard.

- d4a1390: Fix `onAuthChange` and `Authenticator` to paint a synchronous first frame.

  Both previously deferred their initial emit/render behind the async
  `ensureState().then(...)`, so a signed-out UI never painted synchronously on
  subscribe — leaving a blank first frame and causing non-deterministic timeouts
  in CI harnesses (and contradicting `onAuthChange`'s documented "calls callback
  immediately" contract). `onAuthChange` now emits the last-known user from the
  shared cache synchronously, then refreshes from the async hydration — with a
  dedupe to avoid a spurious `null → user` flash and a `.catch` so a rejected
  `getAuthState()` never strands the UI. `Authenticator` does the same synchronous
  first paint from the cache and gains the same `.catch` hardening.

## 0.1.1

### Patch Changes

- 270c049: docs: scrub and port documentation from internal staging repo
- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1

## 0.1.0

Initial version
