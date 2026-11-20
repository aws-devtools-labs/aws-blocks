# Bring your own front door

For `frontDoor: { kind: 'custom', door }` on `HostingConstruct` or on `Hosting` from `@aws-cdk-blocks/core`. The built-in doors, the settings each takes and the rules for switching doors are in the [README](./README.md#front-doors).

A door is one function. `defineFrontDoor` types it. The example below is a
CloudFront door for a static site or a server that takes no request bodies.
It does not do two things the built-in CloudFront door does:

- **Single-page-app deep links.** A deep link (`/dashboard/settings`) has no
  file, so S3 answers 403/404. Map those to `/index.html` with `errorResponses`
  (status 200), or resolve the path in a viewer-request function as the
  stacked door's edge does.
- **POST bodies to the server.** `cf.origin(origins.server)` reaches the
  server's Function URL with origin access control, and CloudFront then
  requires the viewer to send an `x-amz-content-sha256` header with any request
  body. Browsers don't, so form posts and server actions answer 403. The
  built-in door reaches the server through an API Gateway REST API with a
  secret header instead. Use a door like that, or the built-in door, for an app
  that posts to its server.

```ts
// cdk-blocks/my-door.ts
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { cf, defineFrontDoor } from '@aws-cdk-blocks/hosting/constructs';

export const myDoor = defineFrontDoor({
  // A name for this door, used in error messages.
  service: 'my-cdn',

  // Called ONCE at synth, after AWS CDK Blocks has created the bucket, the compute
  // and the API, and before it declares the asset uploads.
  build(scope, { app, origins, features }) {
    const pages = cf.errorPages(app.errorPages, origins); // the app's 404/500 pages
    if (features.waf?.enabled && !features.waf.webAclArn) {
      throw new Error('my-cdn requires a CloudFront-scoped webAclArn when WAF is enabled.');
    }
    const functionAssociations = [...cf.redirects(scope, app.redirects), ...cf.headers(scope, app.headers)];
    const routes = { ...cf.behaviors(app.routes), ...cf.apiBehaviors(origins.api), ...pages.behaviors };
    const dist = new Distribution(scope, 'Cdn', {
      defaultBehavior: {
        origin: cf.origin(origins.server ?? origins.assets),
        // A server renders per request: every method, no edge cache, the viewer's
        // cookies and query string forwarded (all but Host, which a Function URL rejects).
        ...(origins.server
          ? {
              allowedMethods: AllowedMethods.ALLOW_ALL,
              cachePolicy: CachePolicy.CACHING_DISABLED,
              originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
            }
          : {}),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations,
      },
      // A static site: `/` serves the index (the assets origin sits at the build prefix).
      ...(origins.server ? {} : { defaultRootObject: 'index.html' }),
      // CloudFront selects one behavior per request; additional behaviors do not inherit the default's rules.
      additionalBehaviors: Object.fromEntries(
        Object.entries(routes).map(([path, behavior]) => [path, { ...behavior, functionAssociations }]),
      ),
      errorResponses: pages.errorResponses,
      webAclId: features.waf?.webAclArn,
    });
    return {
      url: `https://${dist.distributionDomainName}`, // the app's address (required)
      onUpload: ({ uploads }) => cf.invalidate(dist, { after: uploads }), // purge after the uploads
    };
  },
});
```

```ts
// cdk-blocks/index.cdk.ts
new Hosting(stack, 'Hosting', { root: '..', api: stack, frontDoor: { kind: 'custom', door: myDoor } });
```

**Streaming or buffered.** A door that invokes the server without streaming
(an ALB Lambda target, an API Gateway HTTP API integration, a `BUFFERED`
Function URL) declares `serverResponse: 'buffered'`, and AWS CDK Blocks builds the
server to answer with a complete response. The default is `'streaming'`.

```ts
export const myAlbDoor = defineFrontDoor({
  service: 'my-alb',
  serverResponse: 'buffered', // the ALB invokes the server without streaming
  build: buildMyAlb, // your build: an ALB whose default target is origins.server.fn
});
```

**What the door receives (`DoorInput`).**

- `app`: the app facts. `buildId`, `basePath`, `assetPrefix` (Next.js
  `assetPrefix`; only the Next.js adapter sets it), `spaFallback`, `routes`
  (most-specific first, each already joined to its origin object), `redirects`,
  `headers` and `errorPages` (the app's, else the framework build's, else, for
  a multi-page static site with no 404 page, AWS CDK Blocks' default
  `_not_found.html`).
- `origins`: what AWS CDK Blocks provisioned.
  - `assets`: `{ bucket, prefix, sourceDir }`. The private bucket and the
    `builds/<buildId>/` prefix.
  - `server`: `{ fn, url, streaming }`. `streaming` says whether the server
    streams its response (see `serverResponse`). The Function URL is created on
    first read, in the matching invoke mode.
  - `image`: `{ fn, url }`. Its routes are in `app.routes`.
  - `api`: `{ url, host, stagePath, paths }`. `paths` is `/cdk-blocks/*` (RPC
    and sign-in) plus every raw route.
  - `entry`: `{ fn, url, streaming }`, only for a door with `routing: 'app'`
    (see "Routing in the app" below).
- `features`: the door's `frontDoor.features`, under the same names and shapes,
  each present only when asked for: `domain` (with `wwwRedirect`), `waf` (when
  `enabled` or a web ACL is given), `logging` (when `enabled`), `monitoring`
  (when set and not `enabled: false`; a door gets no `monitoring` unless the
  app sets it), `geoRestriction` (as `'allowlist'` / `'denylist'`), and
  `skewProtection` (on by default, with `maxAge` resolved).

The server origin needs no secret header: `origins.server.url` is a Function
URL with IAM auth (reach it with origin access control, as `cf.origin` does).

**What the door returns.**

- `url` (required): the app's public address. It becomes the `HostingUrl`
  output and `Hosting.url`, the backend's trusted origin
  (`BLOCKS_PUBLIC_ORIGIN`), and an allowed CORS origin, so a trailing slash is
  removed (a browser's `Origin` has none). When the door serves a custom
  domain, return that domain. A missing or empty `url` fails synth with
  `MissingFrontDoorUrlError`.
- `originHandle`: how a door in front of this one reaches it. It is derived from
  `url` unless given.
- `publicBucket`: a public bucket the door serves from. The runtime
  `config.json` is published there.
- `onUpload({ uploads, buildId })`: called after the asset uploads are declared,
  to declare resources that must run after them. What it declares under the
  door's `scope` also runs after the runtime `config.json` upload that
  `Hosting` adds later, so a `cf.invalidate` never caches the placeholder
  config. (A resource created directly under the stack isn't ordered after
  that later upload.)
- `cutover`: the constructs that switch traffic to the new build (whatever
  holds the build id or prefix, e.g. a proxy function whose environment names
  `builds/<buildId>`). Each waits for every upload, the runtime config
  included, so the previous build serves until the new one is whole.

**The wiring check.** AWS CDK Blocks checks one thing about a bring-your-own door:
its routing, from what the `cf.*` helpers recorded. A failed check throws
`UnsupportedFrontDoorError`, whose message lists the unmet rules:

- `ServeStaticAsset`: nothing reaches the static assets.
- `ProxySameOriginApi`: the app has an API and none of `origins.api.paths`
  were wired, or the door wired `/aws-blocks/*` but not `/cdk-blocks/*`.

It warns in three cases:

- `@aws-cdk-blocks/hosting:FrontDoorApiPathUnwired`: some API paths (for example
  a raw route) were left unwired.
- `@aws-cdk-blocks/hosting:FrontDoorRuleUnwired`: the app has redirects,
  per-pattern headers or error pages and the door wired none of them
  (`cf.redirects`, `cf.headers`, `cf.errorPages`).
- `@aws-cdk-blocks/hosting:FrontDoorBehaviorLimit`: `cf.behaviors` and
  `cf.apiBehaviors` handed out more than the 24 behaviors a distribution
  allows besides its default.

It does not check features. If a door ignores `features.waf`, the app deploys
without a WAF.

**Hand-wired doors: `cf.recordWired` or `wiringCheck: false`.** The check sees
only what the helpers recorded, so a door that wires correctly with raw CDK
fails it. Declare hand-wired origins with `cf.recordWired(origins.assets)` and
`cf.recordWired(origins.api)` (optionally with the paths you wired),
hand-wired rules with `cf.recordWired(app.redirects)` (likewise `app.headers`,
`app.errorPages`), or turn the check off with
`frontDoor: { kind: 'custom', door, wiringCheck: false }`.

**The `cf.*` helpers.** A helper that takes the app's routes, rules or API
returns an empty value when the app has none, so it can be spread
unconditionally.

| Helper | Returns |
|---|---|
| `cf.origin(origin)` | The CloudFront origin for `origins.assets`, `origins.server`, `origins.image` or `origins.api`. |
| `cf.behaviors(app.routes)` | One behavior per route, to its origin. An image-optimization route gets a cache policy that honors the image function's `Cache-Control` (one per stack). |
| `cf.apiBehaviors(origins.api)` | The behaviors for `/cdk-blocks/*` and the raw routes. |
| `cf.redirects(scope, app.redirects)` | A viewer-request CloudFront Function association that runs the built-in CloudFront door's matcher. The rules are inline: above the 10 KB a CloudFront Function holds, synth fails with `InvalidPropsError`. |
| `cf.headers(scope, app.headers)` | The same as a viewer-response association, with the same limit. |
| `cf.errorPages(app.errorPages, origins)` | The distribution's `errorResponses` and the `behaviors` that serve the pages from the assets. |
| `cf.invalidate(dist, { after: uploads })` | An invalidation that runs after the uploads. It grants `cloudfront:CreateInvalidation` on that distribution only. |
| `cf.recordWired(origin, paths?)` | Nothing. It declares an origin or a rule set you wired by hand. |

**Testing a door.** Use `assertDoorConformance(door)` from
`@aws-cdk-blocks/hosting/constructs` in the door's own tests. It builds the door
against a sample SPA with an API and runs the same checks: the shape, a
non-empty `url`, and the wiring.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way. The pieces
they share are exported from `@aws-cdk-blocks/hosting/constructs`:

- `generateAlbAssetProxyCode`, `generateApiGwAssetProxyCode`: the asset-proxy
  Lambda source. Pass `app.redirects`, `app.headers` and the error pages to
  apply the app's rules (see `AssetProxyOptions`).
- `assetProxyEnvironment(origins.assets)`: the environment that function
  needs. Set it as the function's `environment` and call
  `origins.assets.bucket.grantRead(fn)`.
- `generateAlbApiProxyCode`: the ALB's same-origin API forwarder.
- `backendBaseUrl`: the backend's base URL, from its API URL.
- `coalesceRoutes`, `routeSpecificity`: route grouping and ordering.
- `createSecurityHeadersPolicy`: the security response headers policy.
- `ORIGIN_VERIFY_HEADER`, `CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST`: the secret
  header's name and the name of CloudFront's origin-facing prefix list.

**A door that stacks CloudFront over its own ALB.** Lock the ALB to the
distribution the same way the stacked door does: admit only CloudFront in the
ALB's security group, and require a secret header that only the distribution
sends. Send the header over HTTPS: over plain HTTP to a public ALB anyone on
the path can read it and reach the ALB directly.

```ts
import { OriginProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST, ORIGIN_VERIFY_HEADER } from '@aws-cdk-blocks/hosting/constructs';

// In build(scope, input): `alb` is your ApplicationLoadBalancer, `target` its target group,
// `certificate` an ACM certificate for `routerDomainName`, a name of yours that points at the ALB.
// A random value (alphanumeric: an ALB header condition treats `*` and `?` as
// wildcards), read by both sides through a dynamic reference.
const secret = new Secret(scope, 'OriginVerify', {
  generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
}).secretValue.unsafeUnwrap();
const listener = alb.addListener('Https', {
  port: 443,
  certificates: [certificate],
  open: false, // no 0.0.0.0/0 ingress
  defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
});
listener.addTargetGroups('FromCloudFront', {
  priority: 1,
  conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [secret])],
  targetGroups: [target],
});
const cloudFront = ec2.PrefixList.fromLookup(scope, 'CloudFront', { prefixListName: CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST });
alb.connections.allowFrom(ec2.Peer.prefixList(cloudFront.prefixListId), ec2.Port.tcp(443));
const origin = new HttpOrigin(routerDomainName, {
  protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
  customHeaders: { [ORIGIN_VERIFY_HEADER]: secret },
});
```

`PrefixList.fromLookup` needs the stack's `env` (account and region); the
built-in door looks the list up at deploy time instead. For an internal ALB,
admit the VPC origin's `CloudFront-VPCOrigins-Service-SG` security group on
port 443. Replace the `HttpOrigin` with a `VpcOrigin` from
`aws-cdk-lib/aws-cloudfront-origins`, keeping the certificate name and the
header the listener requires:

```ts
import { VpcOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';

const origin = VpcOrigin.withApplicationLoadBalancer(alb, {
  domainName: routerDomainName,
  protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
  customHeaders: { [ORIGIN_VERIFY_HEADER]: secret },
});
```

**Routing in the app (`routing: 'app'`).** By default a door routes at the door: it renders the app's route table onto
its own primitives (behaviors, listener rules, API routes). A door that sets
`routing: 'app'` routes at the app instead: it maps a hostname to one entry
function, `origins.entry`, and that function runs the whole route table. This
fits a door shared by many apps, such as one ALB with one listener rule per app.

```ts
// cdk-blocks/shared-alb-door.ts
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { LambdaTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import { defineFrontDoor } from '@aws-cdk-blocks/hosting/constructs';

/** One app on a shared ALB: one listener rule (its hostname) and one Lambda target group. */
export const sharedAlbDoor = (listener: elbv2.IApplicationListener, host: string, priority: number) =>
  defineFrontDoor({
    service: 'shared-alb',
    routing: 'app',
    build(scope, { origins }) {
      const target = new elbv2.ApplicationTargetGroup(scope, 'Target', {
        targetType: elbv2.TargetType.LAMBDA,
        targets: [new LambdaTarget(origins.entry.fn)],
        multiValueHeadersEnabled: true, // keeps every Set-Cookie
      });
      new elbv2.ApplicationListenerRule(scope, 'Rule', {
        listener,
        priority,
        conditions: [elbv2.ListenerCondition.hostHeaders([host])],
        action: elbv2.ListenerAction.forward([target]),
      });
      return { url: `https://${host}` };
    },
  });
```

```ts
// cdk-blocks/index.cdk.ts: `listener` is the shared ALB's HTTPS listener.
new Hosting(stack, 'Hosting', {
  root: '..',
  api: stack,
  frontDoor: { kind: 'custom', door: sharedAlbDoor(listener, 'app.example.com', 10) },
});
```

The app code doesn't change. The entry function:

- is the app's server function when it has one: its handler is wrapped by the
  router, and no function is added. Otherwise (a static site or SPA) AWS CDK
  Blocks creates one router function, the only new resource;
- applies the app's redirects, forwards `/cdk-blocks/*` (and its legacy `/aws-blocks/*` alias) and the raw routes to
  the backend (same origin), serves static routes from the assets bucket (SPA
  fallback, directory index, gzip, `304`s, error pages, security headers),
  calls the image function (or, without one, serves the source image), and
  hands server routes to the framework;
- accepts the events of an ALB Lambda target, an API Gateway REST or HTTP API,
  and a Lambda Function URL, and answers in the matching shape (with
  `multiValueHeaders` when the target group enables them, as above);
- answers buffered: `origins.entry.streaming` is `false`, `serverResponse`
  is `'buffered'`, and a door that sets `serverResponse: 'streaming'` fails
  synth. `origins.entry.url` is created on first read (IAM auth, `BUFFERED`);
- is the build cutover: it switches to a new build only once the build's files
  are uploaded, so the door needs no `cutover` of its own for it.

Per framework, behind `Hosting` from `@aws-cdk-blocks/core`:

| Framework | Server | How the router reaches it |
|---|---|---|
| Next.js (OpenNext) | built with OpenNext's buffered `aws-apigw-v2` handler | called in-process with an HTTP API (payload 2.0) event |
| Nuxt / Nitro | built as Nitro's native `aws-lambda` handler (unless the app picks a preset) | called in-process the same way |
| Astro, SvelteKit, Nitro `node-server` | a Node.js HTTP server, normally run by the Lambda Web Adapter | the function runs Node.js with no Web Adapter layer; the router starts the server's start script on its port and forwards server routes to it over HTTP |

`input.app` is still present for reference, and the routes and API wiring
check doesn't apply. Synth fails, with the fix in the message, for:

- a streaming server handler (`AppRoutingNeedsBufferedServerError`), for
  example Nitro with `awsLambda.streaming: true`, or Next.js built for the
  streaming REST door when you use `HostingConstruct` directly;
- a route to a compute other than the server and the image function
  (`AppRoutingUnsupportedRouteError`), for example a Next.js
  `runtime: 'edge'` route built as a regional function;
- Lambda@Edge routes and Next.js middleware, as for every door other than
  CloudFront.

**Trade-offs.**

- Every request runs in Lambda, static files included, and is billed as
  Lambda time.
- Every response passes the door's Lambda response limit: 1 MB behind an ALB
  (text is sent as UTF-8 and compressible files gzipped, but a larger file
  fails), 6 MB otherwise. Synth warns about the files over 6 MB
  (`@aws-cdk-blocks/hosting:AssetExceedsProxyLimit`).
- An ALB has no edge cache: every request reaches the function. Put a
  CloudFront distribution in front of the door to cache at the edge.
- Skew protection doesn't apply: a tab opened before a deploy that lazily
  loads a chunk of the previous build gets a 404.
- The server sees `Host` as `x-forwarded-host` (a client-sent
  `x-forwarded-host` is replaced), as behind the ALB door.
