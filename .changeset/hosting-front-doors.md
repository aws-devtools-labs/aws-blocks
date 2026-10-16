---
"@aws-blocks/hosting": minor
"@aws-blocks/core": minor
"@aws-blocks/auth-common": minor
"@aws-blocks/bb-auth-basic": patch
---

feat(hosting): swappable front doors, and bring-your-own doors written as one function

`Hosting` no longer hard-codes CloudFront. The optional `frontDoor` prop picks
the public entry point. Omit it and nothing changes: you get the same CloudFront
distribution as before.

- `'cloudfront'` (default): the global CloudFront CDN.
- `{ kind: 'alb', vpc?, internal?, certificate? }`: a regional Application Load
  Balancer, with no CDN. Server-rendered responses are buffered.
- `{ kind: 'apiGateway', api?: 'http' | 'rest', certificate? }`: Amazon API
  Gateway, with no CDN, no VPC, and scale-to-zero. `'http'` (the default)
  buffers server-rendered responses; `'rest'` streams them. `'rest'` needs a
  custom `domain`: its own URL carries the `/prod` stage, which the app's
  root-relative links miss, so synth fails without one
  (`RestFrontDoorNeedsDomainError`).
- `{ kind: 'stacked', edge: 'cloudfront', router: 'alb', vpc?, internal? }`: a
  thin CloudFront edge in front of a full ALB router.
- `'none'`: no front door. A static site or SPA is served straight from an S3
  website bucket over HTTP. An app with a server fails synth.
- `{ kind: 'custom', door, wiringCheck? }`: your own door.

Every door serves the API on the app's own origin (except `'none'`, where the
browser calls the API cross-origin): `/aws-blocks/*` (RPC and sign-in) and each
of the backend's raw routes. It also claims the backend's API front-door role,
so `apiFrontDoor: 'cloudfront'` does not build a second distribution. A door
applies the features the app asks for (custom domain, WAF, logging, alarms,
geo) as far as it supports them. An ALB, for example, has no edge cache or geo
restriction. There is no feature check.

The ALB and API Gateway doors serve static files through an asset-proxy Lambda
that answers like the CloudFront door: a missing file returns 404 (the SPA
fallback applies only to paths without an extension), and each file is served
with the `Cache-Control` it was uploaded with.

The server is built for the door in front of it. Behind a door that invokes it
without streaming (the ALB, the stacked door's ALB router, the API Gateway HTTP
API), a Lambda Web Adapter server (Astro, Nuxt, SvelteKit) answers buffered.
Next.js builds target a streaming API Gateway REST integration, so serve
Next.js through CloudFront, the `'rest'` door, or a door that streams.

A bring-your-own door is one function:
`defineFrontDoor({ service, serverResponse?, build(scope, input) })` from
`@aws-blocks/hosting/constructs`. `Hosting` calls `build` once at synth, after it
has created the bucket, compute and API and before it declares the asset
uploads. A door that invokes the server without streaming sets
`serverResponse: 'buffered'` (the default is `'streaming'`). The door receives
a `DoorInput`:

- `app`: the build id, base path, routes already joined to their origins,
  redirects, headers, error pages, www redirect and skew settings.
- `origins`: the assets bucket and build prefix, the server and image Lambdas
  with their Function URLs (the server's `streaming` says whether it streams,
  and its Function URL uses the matching invoke mode), and the API with every
  path that must reach it.
  The API paths are `/aws-blocks/*` plus the backend's raw routes, and
  `authPaths` lists `/aws-blocks/auth/*`.
- `features`: the features the app asked for. A field is present only when the
  app asked for that feature.

The door returns `{ url, originHandle?, publicBucket?, onUpload? }`.

- `url` is required. It becomes `HostingUrl`, `Hosting.url`,
  `BLOCKS_PUBLIC_ORIGIN` and an allowed CORS origin. A missing `url` fails synth
  with `MissingFrontDoorUrlError`.
- `originHandle` is derived from `url` when the door doesn't return one.
- `onUpload` runs after the asset uploads are declared, so the door can add
  something that runs after them, such as a cache invalidation.

The `cf.*` helpers (`cf.origin`, `cf.behaviors`, `cf.apiBehaviors`,
`cf.invalidate`) build CloudFront origins and behaviors from the input and
record what they wired. From that record, synth fails if nothing reaches the
static assets (`ServeStaticAsset`). It also fails if the app has an API and
none of its paths were wired (`ProxySameOriginApi`). A door that wires with raw
CDK declares it with `cf.recordWired(...)`, or turns the check off with
`wiringCheck: false`. `assertDoorConformance(door)` runs the same checks in a
door's own tests.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces they
share are exported for your own doors: `generateAlbAssetProxyCode`,
`generateApiGwAssetProxyCode`, `backendBaseUrl`, `coalesceRoutes`,
`routeSpecificity` and `createSecurityHeadersPolicy`.

Auth works behind every door. CORS origin matching is case-insensitive, and the
session cookie drops `Secure` when the deployed front door serves over plain
HTTP (`isInsecurePublicOrigin()` in `@aws-blocks/auth-common`), so sign-in works
behind an S3 website or an ALB without TLS.
