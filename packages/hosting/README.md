# @aws-cdk-blocks/hosting

Low-level CDK L3 constructs for deploying web applications on AWS
(S3, Lambda, WAF, monitoring, DNS), behind a front door of your choice:
CloudFront by default, an Application Load Balancer, Amazon API Gateway, an S3
website, or your own (see [Front doors](#front-doors)).

## When to use this package directly

Most apps use `Hosting` from `@aws-cdk-blocks/core`, which wraps these
constructs with the AWS CDK Blocks integration layer (route registry, config.json
generation, RPC prefix wiring). Use `HostingConstruct` directly for a CDK app
without an AWS CDK Blocks backend, or to pass a `DeployManifest` you built
yourself.

The `frontDoor` prop and its settings (front doors, caching, custom domains,
logging, monitoring) apply to both `Hosting` and `HostingConstruct`. The
`stacked` door and `await Hosting.create(...)` exist on `Hosting` only.

## Quick start

An adapter runs the framework build and returns a `DeployManifest`.
`HostingConstruct` provisions it.

```ts
import { App, Stack } from 'aws-cdk-lib';
import { nextjsAdapter } from '@aws-cdk-blocks/hosting/adapters';
import { HostingConstruct } from '@aws-cdk-blocks/hosting/constructs';

const app = new App();
const stack = new Stack(app, 'Web');

const manifest = nextjsAdapter({ projectDir: process.cwd() });
new HostingConstruct(stack, 'Hosting', { manifest });
```

| Adapter | Arguments | Input |
|---|---|---|
| `nextjsAdapter` | `{ projectDir, configPath?, skipBuild? }` | A Next.js app, built with OpenNext. `configPath` is a custom `open-next.config.ts`, relative to `projectDir`. |
| `nuxtAdapter`, `nitroAdapter` | `{ projectDir, preset?, buildCommand?, skipBuild? }` | A Nuxt app, or another Nitro app. `preset` overrides the Nitro preset. |
| `astroAdapter` | `{ projectDir, buildCommand?, skipBuild?, bodySizeLimit? }` | An Astro app. `bodySizeLimit` is the largest request body in bytes (default 20 MB). |
| `sveltekitAdapter` | `{ projectDir, buildCommand?, skipBuild?, bodySizeLimit? }` | A SvelteKit app. `bodySizeLimit` as for Astro. |
| `spaAdapter` | `projectDir, { buildOutputDir?, spaFallback? }` | An already built single-page app in `dist/`, `build/` or `out/`. `spaFallback: false` declares a multi-page static site. |

`skipBuild: true` reuses an existing build output.

### Entry points

| Import from | Exports |
|---|---|
| `@aws-cdk-blocks/hosting` | `secret`, `config`, `getSecret`, `getConfig` and the marker codec. It imports no CDK, so SSR and runtime code can use it. |
| `@aws-cdk-blocks/hosting/constructs` | `HostingConstruct`, `HostingConstructProps`, `HostingDomainConfig`, `HostingWafConfig`, `generateBuildId`, `defineFrontDoor`, the manifest types (`DeployManifest`, `RouteBehavior`, `ComputeResource`), `FrameworkAdapterFn`, `HostingError`. |
| `@aws-cdk-blocks/hosting/adapters` | The adapters, `withComputeTarget`, `LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS`. |
| `@aws-cdk-blocks/hosting/error` | `HostingError`. |

### Props (`HostingConstructProps`)

| Prop | Type | Default | Description |
|---|---|---|---|
| `manifest` | `DeployManifest` | required | The adapter's output. |
| `frontDoor` | `'cloudfront'`, `'none'` or `{ kind?, features?, … }` | `'cloudfront'` | The public entry point and its settings. See [Front doors](#front-doors). |
| `compute` | object | | Overrides for the compute: `type` (`'lambda'` or `'web-function'`, default `'lambda'`), `webFunction`, `memorySize`, `timeout` (a `Duration` or seconds), `reservedConcurrency`, `provisionedConcurrency`, `imageOptimization.reservedConcurrency`, `logRetention`, `environment`, `warmup: { rate }`, `tracing: { otelEndpoint, otelHeaders?, serviceName? }`. |
| `environment` | `Record<string, string \| ManagedValue \| ISecret \| IParameter>` | | Environment variables for all compute functions. See [Secrets & config](#secrets--config). |
| `secretStore`, `configStore` | `KindStoreOptions` | | Prefix, stage and cache settings. Before deploying, check the [region, prefix and stage limits](#region-prefix-and-stage-limits). |
| `storage` | object | | `encryption` (`'S3_MANAGED'` or `'KMS'`), `encryptionKey`, `retainOnDelete`, `buildRetentionDays` (default 30), `deployIntervalDays`, `inventory: { enabled }`, `deployment: { memoryLimit, ephemeralStorageMiB }` (the asset-upload Lambda, default 1024 MiB each). |
| `errorPages` | `{ notFound?, serverError? }` | | Paths of the 404 and 500 HTML files, relative to the project root. |
| `buildCache` | `{ enabled, bucket? }` | | An S3 bucket for framework build caches. Created unless `bucket` is given. |
| `backendApi` | `{ url, paths? }` | | The backend API a door other than CloudFront and `'none'` proxies on the app's origin. `url` ends in `/cdk-blocks/api`; `paths` adds raw routes to `/cdk-blocks/*`. |
| `skipImageOptimization` | `boolean` | `false` | Builds no image-optimization function, even when the manifest declares one. |
| `inPlaceBuild` | `boolean` | `false` | For a manifest whose `buildId` stays the same while the build is unchanged: the door's cutover does not wait for the uploads. For throwaway environments only. The CloudFront door ignores it. |
| `skipRegionValidation` | `boolean` | | Skips the Region checks for WAF, ACM, the Lambda Web Adapter, Web Functions and logging v2. |
| `edgeStackId` | `string` | CDK's `edge-lambda-stack-<hash>` | Construct id of the `us-east-1` stack that holds Lambda@Edge functions when the stack is in another region. |
| `domain`, `waf`, `logging`, `monitoring`, `skewProtection`, `cdn` | | | Deprecated aliases of `frontDoor.features` settings. See [Settings per door kind](#settings-per-door-kind). |

## Front doors

The front door is the public entry point in front of the app: it exposes one
address and routes each request to the static assets, the server-rendering
compute, image optimization, or the backend API. Pick it with the `frontDoor`
prop (on `HostingConstruct`, or on `Hosting` from `@aws-cdk-blocks/core`):

| `frontDoor` | What serves the app |
|---|---|
| omitted / `'cloudfront'` / `{ features }` | The global CloudFront CDN (default): edge cache, WAF, custom domain, streaming, skew protection. |
| `{ kind: 'alb' }` | A regional Application Load Balancer (no CDN): asset-proxy Lambda, SSR/image Lambda targets, same-origin API forwarder; regional WAF, access logs and alarms; HTTPS at your domain with `certificate` + `features.domain`. SSR responses are buffered. |
| `{ kind: 'apiGateway', api?: 'http' \| 'rest' }` | Amazon API Gateway (no CDN, no VPC, scale-to-zero). `'http'` (default) buffers SSR responses. `'rest'` streams them, but needs a custom `domain`: its own URL carries the `/prod` stage, which the app's root-relative links miss, so synth fails without one (`RestFrontDoorNeedsDomainError`). |
| `{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` | A CloudFront edge in front of a full ALB router (`Hosting` from `@aws-cdk-blocks/core` only): static routes come straight from S3 at the edge, the API and dynamic routes go through the ALB, which admits only the edge. |
| `'none'` | No front door: a public S3 website bucket (HTTP only, static sites only; the client calls the API cross-origin). |
| `{ kind: 'custom', door }` | Your own door (see [Bring your own front door](#bring-your-own-front-door)). |

**Where TLS ends on each door.** The viewer hop is the browser → the door; the
origin hop is the door → what serves the request. The secret header is what a
locked origin requires on every request, so it only answers its own door.

| Door | Viewer TLS | Origin-hop TLS | Secret header |
|---|---|---|---|
| CloudFront (default) | HTTPS (HTTP redirects to HTTPS; TLS 1.2+ with a custom `domain`) | HTTPS: S3 through origin access control, Lambda function URLs through origin access control, and the API Gateway REST APIs in front of the server and the image optimizer | `Referer` carrying a Secrets Manager secret, which each server-origin REST API's resource policy requires (plus the `x-blocks-front-door` marker); over HTTPS only |
| `stacked` (CloudFront edge over an ALB router) | HTTPS at the edge (HTTP redirects to HTTPS) | Static routes: HTTPS to S3 (origin access control). Edge → router: HTTPS :443 with a router `certificate` and `features.router.domain`, otherwise plain HTTP :80 (see [the stacked door](#the-stacked-door)) | `x-blocks-origin-verify` carrying a Secrets Manager secret, which every listener rule requires |
| `alb` | HTTPS with `certificate` and `features.domain` (port 80 redirects to 443), otherwise plain HTTP :80 | None on the network: the ALB invokes its Lambda targets through the Lambda service, and the asset proxy reads S3 over HTTPS | None: the standalone ALB door is public by design |
| `apiGateway`, `api: 'http'` | HTTPS only (the `execute-api` endpoint, or a custom `domain`) | None on the network: API Gateway invokes Lambda through the Lambda service | None |
| `apiGateway`, `api: 'rest'` | HTTPS only, at the required custom `domain` (TLS 1.2) | None on the network: API Gateway invokes Lambda through the Lambda service | None |
| `'none'` | None: S3 website endpoints are HTTP only | None: the website bucket serves the files itself | None: the bucket is public read |

A bring-your-own door (`{ kind: 'custom', door }`) decides all three itself.

**Sandbox-only options.** Some plain-HTTP shapes synthesize only in a sandbox
deploy (the `sandboxMode` context the sandbox scripts pass); a production
deploy fails synth, and a sandbox deploy warns:

| Shape | Production synth | Production synth with `allowPlainHttp: true` | Sandbox synth |
|---|---|---|---|
| `{ kind: 'alb' }` without `certificate` + `features.domain`, with an API | Fails: `PlainHttpFrontDoorError` | Warns: `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction`; `Auth` issues its session cookie without `Secure` | Warns: `@aws-cdk-blocks/hosting:PlainHttpFrontDoor` |
| `{ kind: 'custom', door }` whose URL is `http://`, with an API | Fails: `PlainHttpFrontDoorError` | Warns: `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction`; `Auth` issues its session cookie without `Secure` | Warns: `@aws-cdk-blocks/hosting:PlainHttpFrontDoor` |
| `stacked` with an internet-facing router and no router `certificate` + `features.router.domain` | Fails: `OriginSecretOverPlainHttpError` | Warns: `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction` (the origin secret crosses the edge → router hop in cleartext) | Warns: `@aws-cdk-blocks/hosting:OriginSecretOverPlainHttp` and `@aws-cdk-blocks/hosting:StackedRouterPlainHttp` |

> [!WARNING]
> `allowPlainHttp: true` turns off a production safeguard. Sign-in, session
> cookies and every RPC (and, on the stacked door, the router's origin secret)
> travel in cleartext, and `Auth`'s session cookie has no `Secure`: anyone who
> can read or alter traffic on that path can steal a session. Use it in
> production only when the whole network path is trusted. It changes nothing
> in a sandbox deploy, which already only warns. See
> [Running a plain-HTTP door in production](#running-a-plain-http-door-in-production).

`'none'` is not sandbox-only: it serves static sites with no same-origin API,
and warns in every stage (`@aws-cdk-blocks/hosting:PlainHttpFrontDoor`, see
[the `'none'` door](#the-none-door)). An ALB door without a certificate and
without an API synthesizes in every stage.

### Running a plain-HTTP door in production

`allowPlainHttp: true` on the door (default `false`) lets a production deploy
synthesize a shape from the table above. Use it for an `internal` ALB reached
only inside a trusted private network, or for a door whose TLS is ended
upstream by a corporate proxy or another load balancer:

```ts
import { Annotations } from 'aws-cdk-lib';

// An internal ALB reached only inside your network (`vpc`: your ec2.IVpc with private subnets).
new Hosting(stack, 'Hosting', {
  root: '.',
  api: stack,
  frontDoor: { kind: 'alb', internal: true, vpc, allowPlainHttp: true },
});
// Or: { kind: 'custom', door, allowPlainHttp: true }
// Or: { kind: 'stacked', edge: 'cloudfront', router: 'alb', allowPlainHttp: true }

// After reviewing the warning, acknowledge it:
Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction');
```

- A production synth with the option warns
  `@aws-cdk-blocks/hosting:PlainHttpAllowedInProduction`. A sandbox deploy behaves
  as without the option.
- On the `stacked` door the browser still reaches the edge over HTTPS. Only
  the edge → router hop is plain HTTP: anyone who reads the
  `x-blocks-origin-verify` secret there can reach the router directly, past
  the edge and its web ACL. Prefer `internal: true` (a VPC origin, on the AWS
  network) or a router `certificate`.
- A value other than `true` or `false` fails synth with
  `InvalidFrontDoorOptionError`.
- The option has no effect on a door that serves HTTPS, or on `'none'`, which
  takes no options.

**`Auth` behind a plain-HTTP door.** A browser discards a `Secure` cookie set
over plain HTTP.

- In a sandbox deploy, or with `allowPlainHttp: true`, `Auth` issues its
  same-origin session cookie without `Secure` behind an `alb` or `custom`
  door served over HTTP. `Hosting` registers `BLOCKS_ALLOW_PLAIN_HTTP` in the
  backend's config for the option.
- Otherwise sign-in fails with `InsecureTransportException`
  (`AuthErrors.InsecureTransport`, HTTP 500) before any session is stored, and
  no `Set-Cookie` line is written. Sign-out and account deletion still clear
  the cookie.
- Behind the `stacked` door the session cookie keeps `Secure`: the edge is
  HTTPS.

### `frontDoor` validation

`frontDoor` is checked at synth:

| Mistake | Error |
|---|---|
| A value that is not a front door (`'alb'` as a string, `{ kind: 'ALB' }`) | `UnsupportedFrontDoorError` |
| An option the kind doesn't take, or a value of the wrong shape (`api: 'REST'`, an ARN string as `certificate`) | `InvalidFrontDoorOptionError` |
| An unknown key inside a `features` setting (`waf: { enable: true }`) | `InvalidFrontDoorSettingError` |

### What needs the CloudFront door

- `'none'` serves static files only: an app with a server fails synth with
  `UnsupportedFrontDoorError`.
- `compute: { type: 'web-function' }` (AWS Lambda Web Functions) works with the
  CloudFront door only. Every other door routes to Lambda functions, so synth
  fails with `UnsupportedComputeFrontDoorError`.
- Next.js middleware (`middleware.ts`) runs only on the CloudFront door.
  Behind any other door synth fails with `MiddlewareNeedsCloudFrontDoorError`.
- A Lambda@Edge compute behind any other door fails synth with
  `EdgeRouteNeedsCloudFrontDoorError`.

### Streaming and buffered servers

A streaming server handler (Next.js through OpenNext, or Nitro's `aws-lambda`
preset with `awsLambda.streaming: true`) answers only through a door that
streams. Behind a door that invokes the server without streaming, synth fails
with `StreamingServerNeedsStreamingDoorError`. A Lambda Web Adapter server
(Astro, SvelteKit, Nitro's `node-server`) works behind every door.

| Door | Invokes the server | Next.js | Nitro `aws-lambda` preset |
|---|---|---|---|
| CloudFront; `apiGateway` with `api: 'rest'` | Streaming or buffered, as it was built | Works | Works with `awsLambda.streaming` on or off |
| `apiGateway` with `api: 'http'` | Buffered | Works with the HTTP API build profile that core `Hosting` selects. A default streaming build fails synth | Works with `awsLambda.streaming` off; fails synth with it on |
| `alb`, `stacked` | Buffered | Fails synth | Works with `awsLambda.streaming` off; fails synth with it on |
| `custom` | As the door's `serverResponse` declares (default `'streaming'`) | Works with `'streaming'`; fails synth with `'buffered'` | Works with `'streaming'`, or with `awsLambda.streaming` off |

### Error pages with `httpErrorStatus`

The CloudFront door maps 403 / 404 to a not-found page when the app has one
(`errorPages.notFound`, or a static build's own `404.html`) and, for a
multi-page static site with no server and no 404 page of its own, to the
default AWS CDK Blocks page. The mapping applies to every path the distribution
serves, the proxied API (`/cdk-blocks/*`) included. The API answers every
call with HTTP 200 unless an `ApiNamespace` sets `httpErrorStatus: true`
(`@aws-cdk-blocks/core`), which answers a 4xx `ApiError` with that status. Its
403 / 404 would then reach the browser as the HTML page instead of the
JSON-RPC error. `Hosting` from `@aws-cdk-blocks/core` fails synth when it sees
both (`HttpErrorStatusErrorPagesError`, naming the namespaces and the mapped
codes). Remove the 4xx error pages (`errorPages.notFound`, a build's own 404
page), or leave `httpErrorStatus` off for those namespaces.

### Settings per door kind

Each door kind takes its settings as `features`, typed for that kind: a
setting the chosen door doesn't implement does not compile. `{ features }`
with no `kind` is the CloudFront default with settings.

```ts
frontDoor: { features: { waf: { enabled: true }, priceClass: PriceClass.PRICE_CLASS_ALL } }
frontDoor: { kind: 'alb', certificate, features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com' }, waf: { enabled: true } } }
frontDoor: { kind: 'apiGateway', api: 'rest', features: { domain: { domainName: 'app.example.com', hostedZone: 'example.com' } } }
frontDoor: { kind: 'alb', features: { geoRestriction: { type: 'allowlist', countries: ['US'] } } } // ✗ type error
```

| Setting | CloudFront | ALB | API Gateway | Custom (BYO) |
|---|---|---|---|---|
| `domain` | ✓ (certificate in us-east-1, aliases, Route 53 records, `wwwRedirect`) | ✓ (regional certificate, HTTPS listener, :80 → :443 redirect, Route 53 alias records; no `wwwRedirect`) | ✓ (regional; no `wwwRedirect`) | ✓ |
| `waf` | ✓ (CLOUDFRONT-scoped web ACL) | ✓ (REGIONAL web ACL) | – | ✓ |
| `logging` | ✓ | ✓ (the ALB's own logs: off unless set) | – | ✓ |
| `monitoring` | ✓ | ✓ (`enabled` only: ALB 5xx and latency alarms, on unless `enabled: false`, no topic or subscriptions) | – | ✓ |
| `skewProtection` | ✓ | – | – | ✓ |
| `geoRestriction` | ✓ | – | – | ✓ |
| `priceClass`, `contentSecurityPolicy`, `ssrDefaultTtl`, `cacheKeyCookies`, `cacheKeyHeaders`, `responseHeadersPolicy`, `quotas`, `serverOrigin` | ✓ | – | – | – |

- `geoRestriction.type` is `'allowlist'` or `'denylist'`. The legacy
  `'whitelist'` / `'blacklist'` mean the same. Any other value fails synth
  with `InvalidFrontDoorSettingError`.
- The asset bucket's own access logs are on by default on every door;
  `logging: { enabled: false }` turns them off.
- The door's own options (`vpc`, `internal`, `certificate`, `api`, `door`,
  `wiringCheck`, `allowPlainHttp`) sit beside `features`.
- On the ALB, a `certificate` needs `features.domain` (synth fails with
  `AlbCertificateNeedsDomainError` otherwise). A certificate can't cover the
  ALB's own `*.elb.amazonaws.com` name, so that domain is the app's URL (the
  trusted origin and the CORS origin).
- The stacked door takes its settings per layer:
  `features: { edge: { waf: { webAclArn }, contentSecurityPolicy }, router: { domain, waf, logging, monitoring } }`.
  The edge takes your CLOUDFRONT-scoped web ACL, the ALB router a REGIONAL
  one.
- `'none'` takes no settings.

**Deprecated top-level props.** `domain`, `waf`, `logging`, `monitoring`,
`skewProtection` and the `cdn.*` settings are deprecated aliases of the
`frontDoor.features` settings of the same name (`cdn.priceClass` is
`features.priceClass`; `cdn.webAclArn` is `features.waf.webAclArn`). They are
merged into the effective `frontDoor.features`. With `frontDoor` omitted or set
to `'cloudfront'`, moving each alias to its corresponding feature preserves the
synthesized template.

- Setting a setting both ways fails synth with
  `FrontDoorSettingConflictError`.
- A top-level prop the chosen kind doesn't implement (for example
  `cdn.geoRestriction` with `{ kind: 'alb' }`) fails synth with
  `UnsupportedFrontDoorSettingError`.

**The API on the app's origin.** Every door except `'none'` serves the API on
the app's own origin: `/cdk-blocks/*` (RPC and sign-in) and each of the
backend's raw routes registered before `Hosting`
(`DoorInput.origins.api.paths`). `ApiUrl` (what native clients call) depends
on the backend's `apiFrontDoor`:

| `apiFrontDoor` | Door | `ApiUrl` |
|---|---|---|
| `'cloudfront'` | CloudFront or stacked | The door's URL. The backend builds no distribution of its own. |
| `'cloudfront'` | ALB, API Gateway or bring-your-own | The backend's own distribution. |
| `'apigateway'` (default) | Any | The backend's own API Gateway URL. |

**The host the server sees.** The CloudFront door and the stacked door's edge
set `x-forwarded-host` from the viewer's `Host`. Behind the ALB and API Gateway
doors nothing sets it:

- Next.js (OpenNext), Nitro's `aws-lambda` preset and SvelteKit are given the
  viewer's `Host` instead.
- Any other Lambda Web Adapter server (Astro's Node adapter, Nitro's
  `node-server`) receives the request's headers as sent, so don't configure
  it to trust `x-forwarded-host` behind these doors.

Behind the ALB, multi-value headers are on, so several `Set-Cookie` headers
survive.

### The ALB and API Gateway doors: rules and limits

**Static files.** The asset proxy answers like the CloudFront door: a missing
file 404s (the SPA fallback is for extensionless paths only), and each file
keeps the `Cache-Control` it was uploaded with. It also:

- percent-decodes the path (`/My%20Resume.pdf`), and answers 400 for a dot
  segment, an encoded slash or backslash, or a malformed escape;
- gzips text, JSON, JavaScript, SVG and similar files of 1 KiB or more for a
  client that accepts it (`Vary: accept-encoding`);
- returns `ETag` and `Last-Modified`, and answers a matching `If-None-Match` /
  `If-Modified-Since` with a body-less 304;
- adds `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`
  and `Referrer-Policy` to every response (an app header rule of the same name
  wins). Server and API responses don't pass the proxy and don't get them.

**The build cutover.** The asset proxy's environment names the build
(`builds/<buildId>`), and it changes only after every upload of the build —
the resolved runtime config included — has landed, so the previous build keeps
serving until then. There is no skew protection on these doors: a tab opened
before a deploy that later loads a code-split chunk of the previous build gets
a 404. Old builds are kept (rollback works); they are not tagged for the
lifecycle rule as on the CloudFront door, so they are kept until you remove
them.

**Redirects, headers and error pages.** The app's redirects, per-pattern
response headers and error pages are applied by the door's asset proxy (and,
on the ALB, the headers also by the API forwarder) with the CloudFront door's
semantics, using the same matching code:

- redirects: first match wins, a wildcard destination gets the matched tail
  (`/old/*` → `/new/*`), and the status is kept exactly (301, 302, 307, 308).
  A spliced target's leading slashes or backslashes collapse to one slash,
  so `/old//evil.example` never becomes `Location: //evil.example`. Each
  redirect source routes to the asset proxy through an ALB listener rule,
  an HTTP API route or a REST resource;
- header rules: every matching rule is added to a successful response (not to
  a redirect or an error, as at the CloudFront edge);
- error pages: a missing static file answers with the 404 page (status 404),
  an S3 failure with the 500 page (status 500). The 404 page is the app's
  `errorPages.notFound`, else the framework build's, else, for a multi-page
  static site that ships none (Astro `output: 'static'` without a 404 page),
  AWS CDK Blocks' default "404 — Page Not Found" page, as on the CloudFront door.
  An SPA keeps its `index.html` fallback.

Responses the door sends straight to a function or the backend don't pass
through those proxies: server-rendered (SSR) and image-optimization responses,
and on API Gateway the API (proxied natively). Synth names exactly what is not
applied (`@aws-cdk-blocks/hosting:DoorRulesNotApplied`). The CloudFront door and
the stacked door's edge apply the rules to every response.

**Size and time limits.** The asset proxy returns each file base64-encoded (a
third larger; gzipped first when compressible) in its Lambda response, so a
file is capped by that response's limit:

| Door | Limit on the base64-encoded response | Largest file, about |
|---|---|---|
| ALB (Lambda target) | 1 MB | 750 KB (a compressible file: 750 KB gzipped) |
| API Gateway (Lambda proxy integration) | 6 MB (Lambda's response limit, below API Gateway's 10 MB payload limit) | 4.5 MB |

Synth lists every build asset over the limit
(`@aws-cdk-blocks/hosting:AssetExceedsProxyLimit`). Serve large files from the
CloudFront door or the stacked door (static files come straight from S3), or
from a file bucket. The same limits bind everything else these doors carry:

- ALB: a Lambda target's request body and response are each capped at 1 MB,
  for server-rendered pages and API calls alike. The API forwarder returns text
  as UTF-8 (no base64 inflation) and times out after 30 seconds.
- API Gateway: a 10 MB request payload, a 6 MB Lambda response, and a 29-second
  integration timeout.

**ALB listener rules.** Consecutive paths bound for the same target share a
rule: up to five path values (four alongside the stacked router's header
check) and six wildcards per rule. Routes to the default target need no rule. A single pattern
with more than six wildcards (`*` or `?`) fails synth
(`UnsupportedRoutePatternError`). A load balancer allows 100 rules by default;
synth warns above that (`@aws-cdk-blocks/hosting:AlbRuleLimit`).

**ALB custom domain.** `{ kind: 'alb', certificate, features: { domain } }`
serves HTTPS (TLS 1.2+, the `RECOMMENDED_TLS` policy) with a port 80 → 443
redirect, Route 53 alias records to the ALB when you give a hosted zone, and
the domain as the app's URL. Without `certificate`, `domain.certificate` is
used, else a DNS-validated regional certificate (needs `hostedZone` /
`hostedZoneId`). Without a hosted zone, point your DNS at the ALB (the
`AlbDnsName` output).

**Internal ALB.** `internal: true` with the default VPC places the ALB in
isolated private subnets (the VPC still has no NAT gateway). With your own VPC,
it goes in that VPC's private subnets. The API forwarder isn't VPC-attached: it
still reaches the backend at its public endpoint.

**API Gateway routes.** A raw route `/hooks/*` also serves `/hooks`. A backend
route with a wildcard inside a segment (`/files*`) has no API Gateway form and
fails synth (`UnsupportedRoutePatternError`); a route-table pattern of that
shape is served by the default integration, with a synth warning
(`@aws-cdk-blocks/hosting:RouteNotExpressible`). A REST API allows 300 resources
by default (every path segment is one); synth warns above that.
Each function gets one API-scoped invoke permission, not one per route, so
adding routes doesn't fill Lambda's 20 KB resource policy.

**The server behind the HTTP API.** An HTTP API Lambda integration sends the
payload format 2.0 event and can't stream. `Hosting` from `@aws-cdk-blocks/core`
selects the HTTP API build profile for the adapter. If you run the adapter
yourself for `HostingConstruct`, import `withBuildProfile` from
`@aws-cdk-blocks/hosting/adapters` and wrap the build, for example
`withBuildProfile({ serverInvoke: 'http-api', edgeToRegional: true }, () => nextjsAdapter({ projectDir: process.cwd() }))`.
Without that profile, the default Next.js build streams and fails synth.
Core `Hosting` uses these settings:

- Next.js: OpenNext's `aws-apigw-v2` converter with the buffered `aws-lambda`
  wrapper. A hand-written `open-next.config.ts` must use the same pair.
- Nitro with no preset set, in a stack whose region is pinned to one with a
  Lambda Web Adapter layer (`LAMBDA_WEB_ADAPTER_SUPPORTED_REGIONS`, exported
  from `@aws-cdk-blocks/hosting/adapters`): the `node-server` preset, a Lambda Web
  Adapter server run buffered.
- Nitro otherwise, including a stack with no `env`: the `aws-lambda` preset,
  which the HTTP API serves while `awsLambda.streaming` is off. The CloudFront
  door serves that build too, so the same Nuxt app works behind both doors
  (for example the HTTP API for a preview stack and CloudFront for
  production).
- A route served by a compute other than the server (for example a Next.js
  `runtime: 'edge'` route built as a regional function) gets its own route to
  that function.

**No image function.** With `imageOptimization: false` on `Hosting` from
`@aws-cdk-blocks/core` (which `HostingPresets.preview` sets) no image function is
built, and the HTTP API routes the framework image endpoints (`/_next/image`,
`/_ipx/*`, `/_image`, under the basePath) to the asset proxy, which serves the
source image unoptimized. A remote source is redirected (302) to itself only
when its host is in the manifest's image allowlist
(`imageOptimization.domains`, `remotePatterns` hostnames); anything else is a
404. The proxy never fetches a remote URL.

### The `'none'` door

`'none'` publishes the build to its own public S3 website bucket, at the root.
Each deploy prunes what the build no longer ships (a removed `*.map` stops being
downloadable), and uploads with the same cache tiers as the other doors (hashed
assets immutable, HTML and the rest revalidated). Pruning includes the previous
build's hashed assets: a tab opened before a deploy that then lazy-loads one of
its chunks gets a 404 (the website's error document) and needs a reload. The page is plain HTTP and the
API is cross-site, so an auth Building Block needs `crossDomain: true`; its
session cookie is then set by the API's own HTTPS response.

The website endpoint takes no certificate, so `'none'` always warns at synth
(`@aws-cdk-blocks/hosting:PlainHttpFrontDoor`), with or without a backend API: the
HTML and scripts travel unencrypted and can be altered in transit, even when
the API they call is HTTPS. Use `'none'` for testing or public,
non-interactive content; use the CloudFront door for HTTPS. If you chose
`'none'` deliberately, acknowledge the warning on the stack:

```ts
import { Annotations } from 'aws-cdk-lib';

Annotations.of(stack).acknowledgeWarning('@aws-cdk-blocks/hosting:PlainHttpFrontDoor');
```

### The stacked door

`{ kind: 'stacked', edge: 'cloudfront', router: 'alb' }` puts a CloudFront edge
(TLS, cache, security headers, your edge web ACL) in front of the ALB router.

- **Static routes come from S3.** The edge serves the app's static routes
  from the private assets bucket (origin access control); only the API and
  the dynamic routes (server rendering, image optimization) go to the ALB.
  The app's redirects, header rules and error pages apply at the edge to
  every response. A new build never hits the previous build's cached files,
  and the cutover waits for the build's uploads, the resolved runtime config
  included.
- **Caching.**
  - The API is never cached at the edge.
  - Server-rendered routes honor the server's `Cache-Control` and key on
    cookies.
  - Image routes honor the origin's TTLs without cookies in the key.
  - Static routes beyond the behavior budget get the router default: the
    origin's TTLs without cookies for a site without a server, the server's
    default (cookies in the key) with one.
  - An app with a server gets a CloudFront invalidation on each deploy
    (`manifest.invalidationPaths`, else `/*`), after the new build and server
    are live.
  - The router sees the public host in `x-forwarded-host`.
- **Behavior budget.** A distribution allows 25 behaviors, the default
  included. Over that, the router becomes the default, API paths no static
  route can shadow are left to it first, and the rest goes through the ALB
  (`@aws-cdk-blocks/hosting:StackedEdgeBehaviorLimit`); files that then reach the
  router are checked against its 1 MB limit.
- **The ALB admits only the edge.**
  - Every listener rule requires a secret header (`x-blocks-origin-verify`)
    that the edge sends; without it the ALB answers 403. Secrets Manager
    generates the value once (a secret in the stack), and it is in no
    template.
  - An internet-facing ALB's security group admits only the CloudFront
    origin-facing managed prefix list
    (`com.amazonaws.global.cloudfront.origin-facing`). With `internal: true`,
    the edge reaches the ALB through a CloudFront VPC origin, and the
    security group admits only that VPC origin's service security group
    (`CloudFront-VPCOrigins-Service-SG`).
  - To rotate the secret, put a new value and then deploy a change that
    updates both the distribution and the listener rules (CloudFormation
    re-reads the value only for a resource it updates). The listener rules
    update within seconds and the distribution takes minutes, so expect 403s
    from the router in between; rotate in a quiet window.
  - The ALB forwards the header to a Lambda Web Adapter server and to the
    image-optimization function. Don't log or report request headers
    verbatim from them: a leaked value lets any CloudFront distribution reach
    the router, past the edge's web ACL.
- **The edge → router hop.**
  - With a router `certificate` and `features.router.domain` (the name the
    certificate covers; Route 53 alias records point it at the ALB), the edge
    connects to the router over HTTPS on port 443. A domain with a hosted
    zone and no certificate gets a DNS-validated one.
  - A certificate without a router domain fails synth
    (`StackedRouterCertificateNeedsDomainError`).
  - Without either, the hop is plain HTTP on port 80, and the router's
    `x-forwarded-proto` is `http`. With `internal: true` it stays on the AWS
    network, through a VPC origin. To an internet-facing ALB it would carry
    the origin-verify secret in cleartext: the sandbox-only options table
    under [Front doors](#front-doors) gives the production, sandbox and
    `allowPlainHttp` outcomes.
- The stacked door's edge has no custom domain and no skew protection.

### Switching doors on a deployed app

Changing `frontDoor` on a deployed stack replaces the front door's resources;
it is not an in-place update.

- **The address changes.** The new door has a new URL (`HostingUrl`,
  `BLOCKS_PUBLIC_ORIGIN`, the CORS origin), so existing sessions (cookies are
  scoped to the old host) and bookmarks to the old address stop working.
- **CloudFront → ALB or stacked** deletes the default distribution and its
  alarms; the ALB door's (and the router's) own alarms are on unless
  `monitoring: { enabled: false }`, and its access logs are off unless you set
  them.
- **A custom domain moving between doors** (for example the CloudFront door's
  `domain` to an API Gateway or ALB door) creates Route 53 records of the same
  name under new logical IDs, which collides with the old ones while both
  exist. Remove the domain from the old door in one deploy, then add it to the
  new door.

### Bring your own front door

A door is one function, typed by `defineFrontDoor` from
`@aws-cdk-blocks/hosting/constructs` and passed as
`frontDoor: { kind: 'custom', door }`.
[CUSTOM-FRONT-DOOR.md](./CUSTOM-FRONT-DOOR.md) shows a complete CloudFront
door and its limits, and covers what the door receives (`DoorInput`) and
returns, the `cf.*` helpers, testing a door with `assertDoorConformance`, and
a door that stacks CloudFront over its own ALB.

What AWS CDK Blocks checks for a bring-your-own door:

- A missing or empty `url` fails synth with `MissingFrontDoorUrlError`.
- An `http://` `url` with an API is a plain-HTTP door: see
  [Running a plain-HTTP door in production](#running-a-plain-http-door-in-production).
- Routing, from what the `cf.*` helpers recorded. A failed check throws
  `UnsupportedFrontDoorError`, whose message lists the unmet rules:
  - `ServeStaticAsset`: nothing reaches the static assets.
  - `ProxySameOriginApi`: the app has an API and none of `origins.api.paths`
    were wired, or the door wired `/aws-blocks/*` but not `/cdk-blocks/*`.
- The same check warns:
  - `@aws-cdk-blocks/hosting:FrontDoorApiPathUnwired`: some API paths (for
    example a raw route) were left unwired.
  - `@aws-cdk-blocks/hosting:FrontDoorRuleUnwired`: the app has redirects,
    per-pattern headers or error pages and the door wired none of them
    (`cf.redirects`, `cf.headers`, `cf.errorPages`).
  - `@aws-cdk-blocks/hosting:FrontDoorBehaviorLimit`: `cf.behaviors` and
    `cf.apiBehaviors` handed out more than the 24 behaviors a distribution
    allows besides its default.
- A door that wires with raw CDK declares its origins and rules with
  `cf.recordWired(...)`, or turns the check off with
  `frontDoor: { kind: 'custom', door, wiringCheck: false }`.
- Features are not checked. If a door ignores `features.waf`, the app deploys
  without a WAF.
- A door that invokes the server without streaming declares
  `serverResponse: 'buffered'`, and AWS CDK Blocks builds the server to answer
  with a complete response. The default is `'streaming'`.

## Next.js: the OpenNext version

The Next.js adapter builds with [OpenNext](https://opennext.js.org/aws)
(`@opennextjs/aws`). Declare it in your app so you control its version and the
build doesn't download it:

```bash
npm install --save-dev @opennextjs/aws@~4.1.14
```

- The adapter is verified against `@opennextjs/aws` `>=3.10.0 <3.11.0 || >=4.0.0 <4.2.0`.
  Outside that range the build warns and continues.
- If the app doesn't declare OpenNext, the adapter builds with
  `@opennextjs/aws@4.1.14` and prints a warning.
- OpenNext declares the Next.js versions it supports as a `next` peer range
  (4.1.14: `>=15.5.28 <16 || >=16.4.1`). When your `next` version is outside
  it, the build prints a warning. Upgrade `next` within its major version to
  one that range accepts.

### Edge routes (`runtime = 'edge'`)

A route with `runtime = 'edge'` is built as Lambda@Edge, which needs the
stack's region at synth time. Set `env` on the stack that holds `Hosting`:

```ts
const blocksStack = await BlocksStack.create(app, stackName, {
	env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
	// …
});
```

- Without `env`, synth fails with `EdgeComputeRequiresRegionError`.
- Outside `us-east-1`, an Edge route adds a separate `us-east-1` support stack
  for the Lambda@Edge function, so bootstrap `us-east-1` too
  (`npx cdk bootstrap aws://<account>/us-east-1`).
- `npm run sandbox:destroy` deletes every stack the sandbox deploys, the
  `us-east-1` support stack included.
- `npm run destroy` passes no stack selection, so the CDK CLI refuses to
  destroy an app with more than one top-level stack.

## SvelteKit: the server's dependencies

The SvelteKit adapter runs `@sveltejs/adapter-node`'s server, and the server
function ships `build/` without your app's `node_modules`. adapter-node leaves
each package in your `dependencies` (for example `aws-cdk-blocks`, whose
`/server` entry a `+page.server.ts` imports) as an import that it expects to
find in `node_modules` at runtime. So the deploy builds the server with its
dependencies bundled:

- The build runs with a Node.js preload (`NODE_OPTIONS=--import=…`) that hands
  `vite build` a config in a temporary directory: it loads the config that Vite
  itself would load (the file your build command names with `--config`, else
  the first of `vite.config.{js,mjs,ts,cjs,mts,cts}` in the root that the
  command names, else in the working directory), in the same ESM or CommonJS
  format, and adds one build-only Vite plugin, which sets
  `ssr.noExternal: true`. When the command leaves the config unclear (for
  example `--config` given twice, or an option the preload doesn't know), the
  build runs unchanged and says so. Nothing in your project is written or
  renamed, so builds that overlap are safe and a `cdk watch` sees no change.
  Your own adapter-node setup and the adapter's transparent build are treated
  the same.
- After the build, synth resolves every module the server in `build/` loads,
  the way Node.js does from the importing file's place in `build/` (where the
  deployed ZIP stores it, also for a symlinked file) and only inside `build/`
  (`exports`, `imports`, `main`, the CommonJS file lookup, and the target file
  has to exist; a symlink or relative path that leads outside `build/` counts
  as missing, and scripts reached only through such a symlink aren't checked),
  and also checks the files those resolve to. An `import` or `require()` of an
  `@aws-sdk/*` package that the Lambda Node.js runtime ships passes, as the
  runtime puts its copy on `NODE_PATH` and its Node.js reads `NODE_PATH` for
  ESM too; an `@aws-sdk/*` package the runtime doesn't ship (for example
  `@aws-sdk/client-lambda-web`) needs a copy in `build/`. The check fails with
  `SvelteKitUnbundledDependencyError`, naming each missing module with the file
  that imports it, for example a package you list in `ssr.external`. Remove it
  from `ssr.external`, or, for a build whose config the preload couldn't tell,
  set `ssr: { noExternal: true }` yourself. A dynamic `import()` or `require()`
  that the code handles failing (a `require()` in a `try` with a `catch`, or an
  `import()` awaited there or given a `.catch()`) is optional and doesn't fail
  synth, and neither does a missing dependency of a file that only optional
  loads reach, as the load then fails into the code's fallback.
- `npm run destroy` skips this check, so a build left from before can't block
  deleting the stack.

## SSR compute: Lambda or Lambda Web Functions

By default the SSR server runs on a Lambda function behind an API Gateway REST
API (`compute.type: 'lambda'`). HTTP-server frameworks run inside it via the
Lambda Web Adapter. Set `compute.type: 'web-function'` to run it on
[AWS Lambda Web Functions](https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html)
instead. The framework's own Node.js server then runs directly on Lambda, and
CloudFront reaches it through origin access control (OAC):

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  compute: {
    type: 'web-function',
    timeout: Duration.seconds(60),
    webFunction: { maxEnvironments: 20 }, // optional tuning
  },
});
```

| | `'lambda'` (default) | `'web-function'` |
|---|---|---|
| Path | CloudFront → API Gateway → Lambda (+ Lambda Web Adapter) | CloudFront → Web Function endpoint |
| Requests per environment | 1 | many (dynamic, up to `webFunction.maxConcurrencyPerEnvironment`, 1–128, default 64) |
| Billing | duration × memory | active CPU + memory over the environment lifetime |
| Origin auth | shared-secret header checked by API Gateway | IAM: OAC-signed, endpoint grants only this distribution |
| Warm capacity | `provisionedConcurrency` / `warmup` | automatic headroom (scales to zero when idle) |
| Regions | all | us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1 |
| Runtime | Node.js 18–24, x86_64 | Node.js 24, Arm64, 2 GB per environment |

**Requirements.**
- An HTTP-server build. With `Hosting` from `@aws-cdk-blocks/core` every built-in
  framework works unchanged, because the adapters switch their output when
  Web Functions are selected:
  - Astro (`@astrojs/node` standalone) and SvelteKit (`adapter-node`)
    already emit an HTTP server.
  - Nuxt/Nitro builds with the `node-server` preset instead of `aws-lambda`.
  - Next.js builds with OpenNext's `node` wrapper/converter as a container
    origin. A user `open-next.config.ts` must then set `wrapper: 'node'`,
    `converter: 'node'` and `generateDockerfile: true`.
- If you run an adapter yourself in front of `HostingConstruct`, wrap the run in
  `withComputeTarget('web-function', …)` from `@aws-cdk-blocks/hosting/adapters` to
  get the same output.
- An event-handler build (an OpenNext `aws-lambda` wrapper or a Nitro
  `aws-lambda` preset) fails synth with `WebFunctionUnsupportedComputeError`.
- Synth also fails with `WebFunctionUnsupportedRegionError` outside the
  supported Regions. If Web Functions have since launched in your Region,
  bypass the check with `skipRegionValidation: true`.

**What changes.**
- `memorySize`, `reservedConcurrency`, `provisionedConcurrency` and `warmup`
  apply to Lambda only: they are ignored with a synth warning. Use
  `webFunction.maxEnvironments` and `webFunction.rateLimit` to cap scale.
- No default SSR CloudWatch alarms are created for a Web Function.
- Only the SSR server moves. Image optimization, ISR revalidation,
  middleware and edge routes stay on Lambda.
- Native modules must be Arm64. Astro's bundled `sharp` is installed for
  Arm64 automatically. Synth warns when the bundle contains x86-64 `.node`
  binaries; a server that crashes on start still deploys.
- The SSR server is exposed as `HostingConstruct.computeWebFunctions`, not in
  `computeFunctions`. Grant it access to AWS resources through its
  `grantPrincipal`.
- Each deploy writes `web-function/<fn>/code.zip` to a versioned S3 bucket.
  The revision pins that object version; superseded zips expire after 30 days.
  A content-derived logical ID lets CloudFormation create the new revision
  and switch the endpoint without a replacement update, which sandbox Express
  Mode rejects when rollback is disabled.
- An entry shim sets `HOST` and `PORT` from `AWS_LAMBDA_HTTP_ENDPOINT` before
  importing the server. A custom resource grants the distribution
  `lambda:InvokeWebFunctionEndpoint` because CloudFormation has no resource
  type for the Web Function's resource policy.
- Each Web Function stack creates one response headers policy, which counts
  against the account's response headers policy quota (20 by default). It has
  the settings of AWS's managed `SecurityHeadersPolicy` and removes the
  `lambda-web-logstream` response header, which names the internal log stream
  and revision. To share one policy across stacks, create it once with
  `removeHeaders` and pass it as `frontDoor.features.responseHeadersPolicy`
  in each stack:

    ```ts
    // once, e.g. in a shared-infra stack
    new ResponseHeadersPolicy(shared, 'WebFunctionHeaders', {
      securityHeadersBehavior: { /* … */ },
      removeHeaders: ['lambda-web-logstream'],
    });
    // in each hosting stack
    frontDoor: {
      features: { responseHeadersPolicy: ResponseHeadersPolicy.fromResponseHeadersPolicyId(this, 'Headers', policyId) },
    }
    ```

    Synth reminds you to include the removal in a policy of your own, because
    Hosting can't inspect or extend it.

### The server origin's REST API (`compute.type: 'lambda'`)

CloudFront reaches the SSR Lambda through a regional API Gateway REST API. Its
`execute-api` URL is public, so the API is locked to the distribution. A Nuxt
IPX image optimizer gets a REST API of its own with either compute type, so
with `compute.type: 'web-function'` everything below, including the
`serverOrigin` settings, applies to that image REST API.

The REST API invokes the server the way it was built:

| Server build | Integration | Response |
|---|---|---|
| Streaming: Next.js through OpenNext, Nitro's `aws-lambda` preset with `nitro.awsLambda.streaming: true`, any Lambda Web Adapter server | Response streaming (`ResponseTransferMode: STREAM`) | Sent as the page renders |
| Buffered: Nitro's `aws-lambda` preset with `awsLambda.streaming` off (Nitro's default) | Lambda proxy, which reads the `{ statusCode, headers, body }` object the handler returns | Sent whole once the handler returns; Lambda limits it to 6 MB |

- **Origin-verify secret.** CloudFront adds a secret as the `Referer` origin
  custom header (a viewer's own `Referer` is replaced), and the REST API's
  resource policy denies any request without it.
  - Secrets Manager generates the secret once per stack. The policy and the
    CloudFront origin read it through a CloudFormation
    `{{resolve:secretsmanager:…}}` dynamic reference, so it is in no template
    or source.
  - Anyone who can read the distribution's config
    (`cloudfront:GetDistributionConfig`), the API's policy (`apigateway:GET`)
    or the Secrets Manager secret can read it.
  - Your SSR app receives it as the request's `Referer` header. Don't log
    that header (for example with a `combined`-format request logger) or
    redirect back to it.
- **A separate image origin.** A Nuxt IPX image optimizer (`imageOptimization.baseURL`)
  gets its own REST API with its own secret, so neither value reaches the other
  Lambda.
- **A web ACL on the stage.** With an AWS CDK Blocks-managed web ACL on the
  distribution (`waf: { enabled: true }`), each server-origin stage also gets
  a REGIONAL web ACL.
  - It has the same rules: the AWS managed common and known-bad-inputs rule
    groups, and the per-IP rate limit at the same `rateLimit`.
  - Requests from CloudFront carry an `x-blocks-front-door` marker (the
    stack's id), with or without a web ACL, which exempts them from the
    stage's rate rule.
  - It logs the requests a rule blocked or counted to a CloudWatch log group
    named `aws-waf-logs-…`, with the `Referer`, `Cookie` and `Authorization`
    headers redacted. It keeps no sampled requests, which AWS WAF doesn't
    redact.
  - Cost: each web ACL has a monthly charge, a charge per request it
    evaluates (every uncached SSR request is evaluated by two web ACLs), and
    the CloudWatch Logs ingestion of the requests it blocks or counts.
  - A `waf.webAclArn` of your own adds nothing to the stage.
- **Access logs (opt-in).** `serverOrigin: { accessLogging: true }` writes JSON
  access logs (`AccessLogFormat.jsonWithStandardFields()`) from each stage to a
  CloudWatch log group. REST API access logging needs the account-level API
  Gateway CloudWatch Logs role (`AWS::ApiGateway::Account`), which this then
  creates once per stack (the same resource `@aws-cdk-blocks/core`'s
  `defaults.accessLogging` uses). That setting is one per account and region:
  a second stack that also creates it repoints it, and tearing that stack down
  leaves it pointing at a deleted role. Turn it on in one stack per account and
  region, or manage that role yourself.

```ts
frontDoor: {
  features: {
    waf: { enabled: true, rateLimit: 2000 }, // also on the server origin's stage
    serverOrigin: {
      accessLogging: true,
      logRetention: RetentionDays.THREE_MONTHS, // default: one month (access and web ACL logs)
    },
  },
}
```

| `serverOrigin` option | Default | Description |
|---|---|---|
| `accessLogging` | `false` | JSON access logs from each stage to CloudWatch Logs. |
| `logRetention` | `RetentionDays.ONE_MONTH` | Retention of the access logs and of the stage's web ACL logs. |
| `verifySecretRotation` | `0` | A non-negative integer. A new number rotates the origin-verify secrets. |
| `acceptLegacyVerifyHeader` | `false` | For one deploy of an upgrade (below). |

**Rotating the secret.** Bump `serverOrigin.verifySecretRotation` (`1`, `2`, …)
and deploy: Secrets Manager generates new values, and the REST API policies and
the CloudFront origins update in the same deploy. The REST API policy applies
within seconds and the distribution takes minutes, so the server origin
answers 403 in between; rotate in a quiet window.

**`acceptLegacyVerifyHeader`.** A stack whose header value is still derived
from the stack name and construct path has the same window of 403s on the
deploy that moves it to the random secret. To avoid it, deploy once with
`serverOrigin: { acceptLegacyVerifyHeader: true }`, and then deploy again
without it. While it is set:

- the SSR REST API's policy accepts both values;
- anyone who can derive the earlier value can reach the server origin directly;
- with a Nuxt IPX optimizer, the SSR REST API keeps the image routes for the
  edges still sending image requests there;
- the SSR REST API's stage gets no web ACL, because edges on the previous
  config don't send the `x-blocks-front-door` marker and would hit the per-IP
  rate limit. The next deploy attaches it;
- synth warns (`@aws-cdk-blocks/hosting:AcceptLegacyVerifyHeader`).

## Build retention & rollback

Each deploy uploads its assets under an immutable `builds/<buildId>/` prefix.
A build that a later deploy replaced is kept for `storage.buildRetentionDays`
(default 30) so you can roll back, then expired by an S3 lifecycle rule.

- The build being served is never expired.
- `storage.buildRetentionDays` must be at least `skewProtection.maxAge`
  (converted to days), or synth throws `InvalidSkewProtectionMaxAgeError`: a
  skew cookie must not outlive the build it pins to.
- `storage.deployIntervalDays` is an advisory hint: when it is ≥
  `buildRetentionDays`, synth warns that superseded builds may expire before
  your next deploy.
- The lifecycle rule expires only builds tagged
  `aws-blocks:build-state=superseded`, which a deploy's cutover sets. Builds
  uploaded before hosting tagged builds, or left by an aborted or rolled-back
  deploy, stay untagged and must be removed manually.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  storage: {
    buildRetentionDays: 90,   // keep 90 days of rollback targets
    deployIntervalDays: 30,   // advisory only
  },
});
```

## Access logging

CloudFront access logs are delivered to a dedicated, private S3 bucket.
`frontDoor.features.logging.version` picks the pipeline. The server origin's
API Gateway stage logs separately, to CloudWatch Logs, when
`frontDoor.features.serverOrigin.accessLogging` is on (see
[The server origin's REST API](#the-server-origins-rest-api-computetype-lambda)):

| | `'v1'` (default) | `'v2'` |
| --- | --- | --- |
| Mechanism | Legacy standard logging (inline on the distribution) | Standard logging v2 (CloudWatch Logs vended-logs delivery) |
| Log bucket ACLs | Required (`BUCKET_OWNER_PREFERRED`) | None (`BUCKET_OWNER_ENFORCED`) |
| S3 key layout | Flat prefix | Partitioned: `date` or Hive-compatible (`logging.partitioning`) |
| Record format | W3C tab-separated | `w3c` \| `plain` \| `json` \| `parquet` (`logging.format`) |
| CloudFront charge | None (S3 storage only) | Per-GB vended-logs delivery charge |
| Region constraint | Any | Delivery source must be us-east-1 |

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  frontDoor: {
    features: {
      logging: {
        enabled: true,
        version: 'v2',
        partitioning: 'hive',   // or 'date' (default). Athena/Glue-friendly.
        format: 'parquet',      // or 'w3c' (default), 'json', 'plain'
        retentionDays: 90,
      },
    },
  },
});
```

`version: 'v2'` needs the stack in us-east-1. Synth throws
`LoggingV2RegionError` in any other Region, and warns
`@aws-cdk-blocks/hosting:LoggingV2RegionUnresolved` when the stack's Region is
unresolved. `skipRegionValidation` skips this check along with the WAF, ACM
and Lambda Web Adapter Region checks.

The deprecated top-level `logging` prop of `Hosting` from `@aws-cdk-blocks/core`
accepts only `enabled` and `retentionDays`, so it always uses v1.

## SSR caching & cache-key credentials

`frontDoor.features.ssrDefaultTtl` (CloudFront door) enables CloudFront edge
caching of SSR responses that carry no explicit `Cache-Control` header. The
SSR cache key does not include `Authorization` or session cookies by default,
so one cached entry would answer requests regardless of their credentials.
Set `cacheKeyCookies` (your session cookie names) and/or `cacheKeyHeaders`
(for example `'authorization'`) so cached responses are keyed per credential.

| `frontDoor.features` option | Type | Default | Limit | Error |
|---|---|---|---|---|
| `ssrDefaultTtl` | `Duration` | `Duration.seconds(0)`: no caching unless the origin opts in | Edge TTLs are capped at 1 day | `SsrCacheKeyCredentialsRequiredError` when above 0 and neither `cacheKeyCookies` nor `cacheKeyHeaders` is set |
| `cacheKeyCookies` | `string[]` | none | 8 extra names by default (10 minus 2 reserved). Set `quotas.cacheKeyCookies` to your approved CloudFront quota. | `SsrCacheKeyCookieCapError` |
| `cacheKeyHeaders` | `string[]` | none | 5 extra names by default (10 minus 5 reserved). Set `quotas.cacheKeyHeaders` to your approved CloudFront quota. `accept-encoding` is handled automatically and not allowed. | `SsrCacheKeyHeaderCapError`, `SsrCacheKeyAcceptEncodingError` |
| `cacheGuardIgnoredCookies` | `string[]` | none | A name may not also be in `cacheKeyCookies` | `CacheGuardIgnoredCookieInCacheKeyError` |

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  frontDoor: {
    features: {
      ssrDefaultTtl: Duration.seconds(60),
      cacheKeyCookies: ['session'], // your session cookie name(s)
    },
  },
});
```

Synth checks only `ssrDefaultTtl`. It does not see routes the origin makes
cacheable (`s-maxage`, Next.js `revalidate`, Nuxt `routeRules`, Astro SSR).
For those, the construct installs a runtime cache guard in front of the SSR
server and of every other regional compute a route targets: Lambda handlers,
and Node.js servers on the Lambda Web Adapter or a Web Function. Where the
guard cannot be installed (for example a Lambda Web Adapter server that is not
Node.js, or a handler module missing from the bundle), synth warns
`@aws-cdk-blocks/hosting:SsrCacheGuardNotInstalled` and that server's responses
are cached as its `Cache-Control` says. The guard sends
`Cache-Control: private, no-store` instead of the origin's value when:

- the response sets cookies (`Set-Cookie`) and is not already `private` or
  `no-store` — CloudFront stores `Set-Cookie` with a cached object and replays
  it on every hit; or
- the request carries `Authorization` (unless `'authorization'` is in
  `cacheKeyHeaders`) or a cookie whose name is not in the cache key (the Next.js
  preview cookies, the skew-protection `__dpl` cookie and `cacheKeyCookies`),
  and the response is shared-cacheable: `s-maxage`, `public`, `max-age` without
  `private`, a future `Expires`, no caching headers while `ssrDefaultTtl > 0`,
  or an error status CloudFront caches without caching headers (404, 414 and
  500 to 504).

Responses that are already `private`/`no-store`, or `no-cache` without
`s-maxage`, are left as they are. To keep a credentialed route cacheable, list
its credential in `cacheKeyCookies`/`cacheKeyHeaders` so the cache is keyed per
credential. Any route that otherwise varies per user should still emit
`Cache-Control: private`.

Client-side analytics and consent cookies (`_ga`, `_gid`, `_fbp`, a consent
manager's cookie) are not in the cache key, so by default a visitor carrying one
gets ISR/SSR pages as `private, no-store` and they are not edge-cached for that
visitor. List such cookies in `cacheGuardIgnoredCookies`
(`frontDoor.features.cacheGuardIgnoredCookies`) to have the guard ignore them.
They stay out of the cache key, so a listed cookie must never change what the
server renders.

```ts
frontDoor: { features: { cacheKeyCookies: ['session'], cacheGuardIgnoredCookies: ['_ga', '_gid', '_fbp'] } }
```

Behind the stacked door the server-route cache key holds every
cookie, so cookies never lead to a rewrite there; `Authorization` and
`Set-Cookie` still do.

CloudFront caches the 500, 501, 502, 503 and 504 responses of an origin for the
error caching minimum TTL and, except for 501, does so whatever their
`Cache-Control` says. A distribution with a server (the CloudFront door and the
stacked door) therefore sets that TTL to 0 for those statuses,
keeping any error page configured for them.

The guard models CloudFront's own caching inputs only: `CDN-Cache-Control` and
`Surrogate-Control` are not CloudFront TTL inputs, and CloudFront ignores `Vary`
for the cache key, so the guard does not read them.

CloudFront uses `max-age` as its edge TTL when `s-maxage` is absent, so a bare
`max-age` is cached at the edge and counts as shared-cacheable. A credentialed
route that should still be cached by the browser should send
`Cache-Control: private, max-age=…`, which the guard leaves unchanged.

The SSR cache policy caps edge TTLs at 1 day, whatever `s-maxage` the origin
sends. The cache-key limits in the table above are defaults, not hard caps.

Static and image routes are not keyed on `cacheKeyCookies` /
`cacheKeyHeaders`, and those cookies and headers are not forwarded to the
origin on those routes (an auth-gated image source does not receive them).

## Custom domains (CloudFront door)

Configure a custom domain through `frontDoor.features.domain`
(`HostingDomainConfig`). The ALB and API Gateway doors take a regional
certificate instead (see [Front doors](#front-doors)). CloudFront only accepts
ACM certificates in us-east-1.

### Route 53 (automatic)

Provide `hostedZone` (the zone domain name) or `hostedZoneId`. The construct
provisions a DNS-validated ACM certificate and creates the A and AAAA alias
records for you. Validation is automatic when the hosted zone is in the same
account as the deployment, because the construct writes the ACM validation
records into the zone itself.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  frontDoor: {
    features: {
      domain: {
        domainName: 'app.example.com',
        hostedZone: 'example.com', // a Route 53 zone you control
      },
    },
  },
});
```

Pass `hostedZoneId` when the stack has no `env: { account, region }`, for
example in a pipeline stage: it skips `HostedZone.fromLookup()`.

```ts
domain: {
  domainName: 'app.example.com',
  hostedZone: 'example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
}
```

### Bring your own DNS (manual)

If your DNS is not in Route 53, omit `hostedZone` and `hostedZoneId` and pass a
validated `certificate`, an ACM certificate in us-east-1. The construct
creates no DNS records:

```ts
domain: {
  domainName: 'app.example.com',
  certificate, // an ACM certificate in us-east-1 with status Issued
}
```

1. Before the deploy, request an ACM certificate in us-east-1 for your domain
   and validate it (add the ACM validation CNAME to your DNS, or use email
   validation). Wait until the certificate status is Issued.
2. Deploy the stack. It emits the CloudFront distribution domain as the
   `DistributionDomainName` output (for example `d1234abcd.cloudfront.net`).
3. In your DNS provider, create a CNAME from your domain to that value. For
   an apex domain, use an ALIAS or ANAME record if your provider supports it.

### Error behavior

- Omitting `hostedZone`, `hostedZoneId` and `certificate` throws
  `MissingCertificateError` at synth.
- A certificate outside us-east-1 fails synth with
  `InvalidCertificateRegionError`.

## CloudFront 5xx alarm outside us-east-1

CloudFront metrics are published only in `us-east-1`, and a CloudWatch alarm
evaluates only metrics of its own region. When the stack's region is not
`us-east-1`, `HostingConstruct` adds a companion stack named
`<stackName>-CfMonitoring-<addr>` in `us-east-1` with the CloudFront 5xx rate
alarm and its own encrypted SNS topic. There is no opt-out.

- Your `frontDoor.features.monitoring.subscriptions` apply to that topic too.
- The topic's ARN is the `MonitoringTopicArnUsEast1` output.
- Set `env: { account, region }` on the hosting stack when deploying outside
  `us-east-1`.
- With the region resolved and the account unresolved, only the CloudFront
  alarm is skipped, with a synth warning. All other alarms are kept.
- A stack with an unresolved region creates the alarm locally and warns that
  it never fires if the app deploys outside `us-east-1`.
- In `us-east-1` the alarm stays in the hosting stack.

Subscribe with endpoint subscriptions (`EmailSubscription` /
`UrlSubscription` from `aws-cdk-lib/aws-sns-subscriptions`):

```ts
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';

new HostingConstruct(this, 'Hosting', {
  // ...
  frontDoor: {
    features: {
      monitoring: {
        subscriptions: [new subs.EmailSubscription('oncall@example.com')],
      },
    },
  },
});
```

Lambda and SQS subscriptions are not supported. For a custom action, use the
alarms in `hosting.monitoring.alarms`.

## Secrets & config

`secret('KEY')` and `config('KEY')` declare a value. The function you call
picks the store:

| Declare (infra) | Store | Read (runtime) |
| --- | --- | --- |
| `secret('KEY')` | AWS Secrets Manager (sensitive) | `getSecret('KEY')` |
| `config('KEY')` | AWS SSM Parameter Store (non-sensitive, free tier) | `getConfig('KEY')` |

### Declare — in your hosting infra

```ts
import { HostingConstruct } from '@aws-cdk-blocks/hosting/constructs';
import { secret, config } from '@aws-cdk-blocks/hosting';

new HostingConstruct(stack, 'Web', {
  manifest, // a DeployManifest from an adapter (see Quick start)
  environment: {
    STRIPE_KEY: secret('STRIPE_KEY'), // → Secrets Manager
    FEATURE_FLAGS: config('FEATURE_FLAGS'), // → SSM Parameter Store
  },
  // Optional per-kind namespace / cache config:
  secretStore: { prefix: '/myapp/secrets' },
  configStore: { prefix: '/myapp/config', cacheTtlSeconds: 30 },
});
```

| Option of `secretStore` / `configStore` | Default | Description |
|---|---|---|
| `prefix` | `/hosting/secrets`, `/hosting/config` | Store path prefix. A value is stored at `<prefix>/<key>`. |
| `stage` | none | A value resolves to `<prefix>/<stage>/<key>` and falls back to the shared `<prefix>/<key>`. |
| `cacheTtlSeconds` | none | Seconds the getter reuses a fetched value. Omitted or `0`: for the life of the process. |

The marker is inert (`{ key, kind }`) and safe to commit. Only the store
locator is injected, never the value. The compute role is granted read on that
one resource (`secretsmanager:GetSecretValue` / `ssm:GetParameter`, scoped to
the exact ARN) plus `kms:Decrypt`.

`environment` accepts both `secret()` and `config()`. On `HostingConstruct`,
`domain.domainName` is a plain `string | string[]`. Only
`await Hosting.create(...)` (`Hosting` from `@aws-cdk-blocks/core`) resolves a
marker at synth, and there it accepts only `config()` or a plain string, never
`secret()`: the resolved value is written into the CloudFormation template.

**Bring your own:** `environment` also accepts an existing CDK `ISecret` /
`IParameter` handle. The construct grants read through the handle and injects
its locator, so `getSecret` / `getConfig` read it the same way.

### Read — in your SSR / API / runtime code

```ts
import { getSecret, getConfig } from '@aws-cdk-blocks/hosting';

const key = await getSecret('STRIPE_KEY'); // Secrets Manager
const flags = await getConfig('FEATURE_FLAGS'); // SSM
```

- Each getter reads `process.env.KEY` first, so local development needs no
  AWS.
- Locally, put the value in `.env.local`. `npm run dev` and `npm run sandbox`
  load that file into the backend and do not load `.env`: with a value only
  in `.env`, `getConfig` throws `no config reference found` and `getSecret`
  throws `no secret reference found`.
- Next.js SSR code under `next dev` also reads `.env`, because Next.js loads
  it.
- On a deployed function the getter fetches and decrypts the value from its
  store and caches it for the life of the process, or for `cacheTtlSeconds`
  (a rotated value is then read without a redeploy).

### Type-safe keys (`hosting-typegen`)

`getSecret` / `getConfig` accept any `string` until you run `hosting-typegen`
(wire it as `"typegen": "hosting-typegen"`), which narrows them to the
declared keys with no call-site change:

```bash
npx hosting-typegen           # scan secret()/config() calls → .cdk-blocks/hosting-values.d.ts
npx hosting-typegen --watch   # regenerate on every save (run alongside your dev server)
npx hosting-typegen --check   # CI: fail if that file is stale
```

In an AWS CDK Blocks app, `npm run dev` runs the generate-and-watch step itself
when the app calls `secret()` / `config()`. In a standalone hosting app, run
`hosting-typegen --watch` beside the dev server or add a `"predev"` hook.

The scan is static: the app is not run and no AWS credentials are needed. A
key that is not declared with the matching function is a compile error:

```ts
await getSecret('STRIPE_KEY'); // ✅ declared with secret()
await getSecret('STRIPE_KYE'); // ❌ compile error — not a declared secret key
```

Add the generated file to your `tsconfig.json` `include`. Do not edit it by
hand: the tool regenerates it.

```jsonc
{ "include": ["src", "cdk-blocks", ".cdk-blocks/**/*.d.ts"] }
```

The file is safe to delete (the keys fall back to `string`) and safe to
`.gitignore`. A `secret(myVar)` with a non-literal key is reported and
skipped. A synth-only `domain` / `connectionArn` key may appear in
autocomplete even though it is not readable at runtime.

### Typed, parsed values with a schema

Pass a Standard Schema (Zod, Valibot, ArkType) to get a typed, JSON-parsed
value instead of a `string`:

```ts
// declare
import { z } from 'zod';
environment: { FEATURE_FLAGS: config('FEATURE_FLAGS', { schema: z.object({ beta: z.boolean() }) }) }

// read — no JSON.parse, no `any`
const { beta } = await getConfig('FEATURE_FLAGS');   // typed as { beta: boolean }
```

Declaring a schema sets a flag at synth: `getConfig` and `getSecret` JSON-parse
that key on read, even without `hosting-typegen`. Typegen gives the getter the
schema's static output type. The schema (`StandardSchemaV1`) does not run at
runtime: the stored value is parsed, not validated.

### Transport markers across a JSON / build boundary

A marker does not survive `JSON.stringify` → `JSON.parse`:
`isManagedValue()` returns `false` afterwards. To carry markers through JSON,
for example in a build environment variable that a later build phase reads,
use the codec:

```ts
import { config, isSecret, managedValueReplacer, managedValueReviver, secret } from '@aws-cdk-blocks/hosting';

// Producer (phase 1): stringify with the replacer, stash in an env var.
process.env.STAGE_CONFIG = JSON.stringify({ domain: config('DOMAIN'), apiKey: secret('API_KEY') }, managedValueReplacer);

// Consumer (phase 2, possibly a different process): parse with the reviver.
const cfg = JSON.parse(process.env.STAGE_CONFIG, managedValueReviver);
isSecret(cfg.apiKey); // true
```

`managedValueReplacer` / `managedValueReviver` are `JSON.stringify` /
`JSON.parse` hooks for a whole, possibly nested, object. `encodeManagedValue`
/ `decodeManagedValue` convert a single value.

The wire format is a published, cross-build compatibility boundary:

- Each encoded value carries a protocol version
  (`MANAGED_VALUE_JSON_VERSION`). The decoder rejects versions it doesn't
  understand rather than silently misreading a different producer's data.
- `decodeManagedValue(v: unknown)` throws `ManagedValueCodecError` on an
  unsupported version, an unknown kind, an invalid key or any other malformed
  shape.
- `managedValueReviver` never throws: it leaves anything that is not an exact
  wire value untouched.
- Only an object whose sole property is the codec tag is revived. An object
  with the tag and other fields is left as is.
- `schema` is not transported. The decoded marker still JSON-parses its
  value; declare the schema again on the consuming side to get its type.

### Set the values (out of band, never in git)

Standalone hosting apps get two bundled CLIs:

```bash
# Secrets Manager — a secret value is NEVER taken from argv (it would land in
# shell history). Omit the value for a hidden prompt, or pipe it via --value-stdin:
npx hosting-secret set STRIPE_KEY --prefix /myapp/secrets --region us-east-1   # hidden prompt
cat key.txt | npx hosting-secret set STRIPE_KEY --value-stdin --prefix /myapp/secrets
npx hosting-secret list --prefix /myapp/secrets
npx hosting-secret remove STRIPE_KEY --prefix /myapp/secrets               # recoverable
npx hosting-secret remove STRIPE_KEY --force --yes --prefix /myapp/secrets # immediate, no recovery

# SSM Parameter Store — a config value is non-sensitive, so a positional value is fine:
npx hosting-config set FEATURE_FLAGS '{"beta":true}' --prefix /myapp/config
```

- `set` creates the entry or overwrites it, with no overwrite confirmation. Run it again to
  rotate a value.
- `hosting-secret set KEY value` is an error: a secret value comes from the
  hidden prompt or `--value-stdin`.
- `hosting-config set` also accepts `--value-stdin` and the prompt.
- `list` prints names only.
- `remove` on a secret is recoverable by default (Secrets Manager's recovery
  window). `--force` deletes immediately. It needs `--yes` (or `-y`) in every
  stage and prints a warning that names the stage, or says that the un-staged
  value is shared by every stage, production included.
- `remove` on a config value is always immediate (SSM Parameter Store has no
  recovery window) and needs no `--yes`.

### Region, prefix and `stage` limits

- `--region` (or `AWS_REGION`) must match the region the app deploys to, or
  the deploy reports the value as "not set".
- The default prefixes (`/hosting/secrets`, `/hosting/config`) are
  account-global. When more than one app deploys to the same account, give
  each its own `secretStore.prefix` / `configStore.prefix` and the matching
  CLI `--prefix`, or their same-named values collide.
- `stage` is not a security boundary. A stage's compute can read both its
  stage value and the shared `<prefix>/<key>` value, so every stage sharing a
  prefix can read the shared value. Put production-only secrets in a
  stage-scoped slot and only a safe cross-stage default (for example a sandbox
  credential) in the shared slot. Two constructs sharing a prefix are not
  isolated from each other.

## Errors

The errors below are `HostingError`s (`@aws-cdk-blocks/hosting/error`), thrown at
synth. `error.name` and `error.code` hold the name in the table, and
`error.resolution` says how to fix it.

| `error.name` | Thrown when |
|---|---|
| `AlbCertificateNeedsDomainError` | `{ kind: 'alb', certificate }` has no `features.domain`. |
| `CacheGuardIgnoredCookieInCacheKeyError` | A cookie is in both `cacheKeyCookies` and `cacheGuardIgnoredCookies`. |
| `EdgeComputeRequiresRegionError` | The app has Lambda@Edge compute and the stack has no explicit region. |
| `EdgeRouteNeedsCloudFrontDoorError` | A Lambda@Edge compute is behind a door other than CloudFront. |
| `EmptyGeoRestrictionError` | `geoRestriction.countries` is empty. |
| `FrontDoorSettingConflictError` | A setting is set both as a top-level prop and in `frontDoor.features`. |
| `HttpErrorStatusErrorPagesError` | `Hosting` from `@aws-cdk-blocks/core` sees an `ApiNamespace` with `httpErrorStatus: true` and a CloudFront 403 / 404 error page. |
| `InvalidCertificateRegionError` | The CloudFront door's `certificate` is not in us-east-1. |
| `InvalidFrontDoorOptionError` | A door option is unknown for the kind or has the wrong type. |
| `InvalidFrontDoorSettingError` | A `features` setting has an unknown key, an unknown `geoRestriction.type`, or a `serverOrigin.verifySecretRotation` that is not a non-negative integer. |
| `InvalidSkewProtectionMaxAgeError` | `skewProtection.maxAge` is outside 0 to 2592000 seconds (30 days), or exceeds `storage.buildRetentionDays`. |
| `InvalidWebFunctionOptionError` | `maxConcurrencyPerEnvironment` is not an integer in 1–128, `maxEnvironments` is not an integer in 2–10000, or `rateLimit` is not 0, 100–1000 in steps of 100, or 2000–10000 in steps of 1000. |
| `LoggingV2RegionError` | `logging.version: 'v2'` in a stack outside us-east-1. |
| `MiddlewareNeedsCloudFrontDoorError` | The app has Next.js middleware and the door is not CloudFront. |
| `MissingCertificateError` | A `domain` has no `hostedZone`, no `hostedZoneId` and no `certificate`. |
| `MissingFrontDoorUrlError` | A custom door's `build` returns no `url`. |
| `OriginSecretOverPlainHttpError` | Production synth of a `stacked` door whose edge → router hop is plain HTTP to an internet-facing router, without `allowPlainHttp: true`. |
| `PlainHttpFrontDoorError` | Production synth of an `alb` or `custom` door served over plain HTTP with an API, without `allowPlainHttp: true`. |
| `RestFrontDoorNeedsDomainError` | `{ kind: 'apiGateway', api: 'rest' }` has no custom domain. |
| `SsrCacheKeyAcceptEncodingError` | `cacheKeyHeaders` includes `accept-encoding`. |
| `SsrCacheKeyCookieCapError` | Extra cookie names plus the 2 reserved names exceed `quotas.cacheKeyCookies` (10 by default). |
| `SsrCacheKeyCredentialsRequiredError` | `ssrDefaultTtl` is above 0 and neither `cacheKeyCookies` nor `cacheKeyHeaders` is set. |
| `SsrCacheKeyHeaderCapError` | Extra header names plus the 5 reserved names exceed `quotas.cacheKeyHeaders` (10 by default). |
| `StackedRouterCertificateNeedsDomainError` | `Hosting` from `@aws-cdk-blocks/core`: the stacked door's router has a `certificate` and no `features.router.domain`. |
| `StreamingServerNeedsStreamingDoorError` | A streaming server handler is behind a door that invokes it without streaming. |
| `TooManyCacheBehaviorsError` | The default behavior plus the additional CloudFront cache behaviors exceed `quotas.cacheBehaviors`. |
| `UnsupportedComputeFrontDoorError` | `compute.type: 'web-function'` behind a door other than CloudFront. |
| `UnsupportedFrontDoorError` | `frontDoor` is not a front door, `'none'` is set for an app with a server, or a custom door fails the wiring check. |
| `UnsupportedFrontDoorSettingError` | The door kind doesn't implement a setting. |
| `UnsupportedRoutePatternError` | ALB: one pattern has more than six wildcards. API Gateway: a backend route has a wildcard other than one trailing `/*`. |
| `WafRegionError` | A CloudFront-scoped WAF is enabled in a known region outside us-east-1 and region validation isn't skipped. |
| `WebFunctionPolicyAlreadySetError` | `allowCloudFrontInvoke()` was called twice on the same Web Function. |
| `WebFunctionUnsupportedComputeError` | `compute.type: 'web-function'` with a compute that is not an HTTP-server build. |
| `WebFunctionUnsupportedRegionError` | `compute.type: 'web-function'` in a Region without Lambda Web Functions. |

The adapters and the construct throw further `HostingError`s for build
failures and invalid props. Two errors are not `HostingError`s:

- `ManagedValueCodecError` (from `@aws-cdk-blocks/hosting`): `decodeManagedValue`
  got a malformed value or an unsupported version.
- `InsecureTransportException`: thrown by `Auth` at sign-in behind a
  plain-HTTP door (see
  [Running a plain-HTTP door in production](#running-a-plain-http-door-in-production)).

## License

Apache-2.0

The bundled Lambda handlers in `dist/constructs/` (`kv_keys_handler_bundle.mjs`,
`web_function_policy_handler_bundle.mjs`) include third-party npm packages. Their
names, versions, licenses and license texts are in
`dist/constructs/THIRD-PARTY-LICENSES.txt`, generated by the build and shipped in
the package.
