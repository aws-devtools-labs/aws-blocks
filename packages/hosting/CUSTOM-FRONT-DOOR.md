# Bring your own front door

For `frontDoor: { kind: 'custom', door }` on `HostingConstruct` or on `Hosting` from `@aws-blocks/core`. The built-in doors, the settings each takes and the rules for switching doors are in the [README](./README.md#front-doors).

A door is one function. `defineFrontDoor` types it:

```ts
// aws-blocks/my-door.ts
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { cf, defineFrontDoor } from '@aws-blocks/hosting/constructs';

export const myDoor = defineFrontDoor({
  // A name for this door, used in error messages.
  service: 'my-cdn',

  // Called ONCE at synth, after AWS Blocks has created the bucket, the compute
  // and the API, and before it declares the asset uploads.
  build(scope, { app, origins, features }) {
    const pages = cf.errorPages(app.errorPages, origins); // the app's 404/500 pages
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
        // the app's redirects (viewer request) and per-pattern headers (viewer response)
        functionAssociations: [...cf.redirects(scope, app.redirects), ...cf.headers(scope, app.headers)],
      },
      // A static site: `/` serves the index (the assets origin sits at the build prefix).
      ...(origins.server ? {} : { defaultRootObject: 'index.html' }),
      additionalBehaviors: {
        ...cf.behaviors(app.routes), // each route → its origin
        ...cf.apiBehaviors(origins.api), // /aws-blocks/* and raw routes → the API
        ...pages.behaviors, // the error pages, from the assets
      },
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
// aws-blocks/index.cdk.ts
new Hosting(stack, 'Hosting', { root: '..', api: stack, frontDoor: { kind: 'custom', door: myDoor } });
```

This door doesn't do two things the built-in CloudFront door does:

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

**Streaming or buffered.** A door that invokes the server without streaming
(an ALB Lambda target, an API Gateway HTTP API integration, a `BUFFERED`
Function URL) declares `serverResponse: 'buffered'`, and AWS Blocks builds the
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
  a multi-page static site with no 404 page, AWS Blocks' default
  `_not_found.html`).
- `origins`: what AWS Blocks provisioned.
  - `assets`: `{ bucket, prefix, sourceDir }`. The private bucket and the
    `builds/<buildId>/` prefix.
  - `server`: `{ fn, url, streaming }`. `streaming` says whether the server
    streams its response (see `serverResponse`). The Function URL is created on
    first read, in the matching invoke mode.
  - `image`: `{ fn, url }`. Its routes are in `app.routes`.
  - `api`: `{ url, host, stagePath, paths }`. `paths` is `/aws-blocks/*` (RPC
    and sign-in) plus every raw route.
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

**The wiring check.** AWS Blocks checks one thing about a bring-your-own door:
its routing, from what the `cf.*` helpers recorded.

- If nothing reaches the static assets, synth fails with `ServeStaticAsset`.
- If the app has an API and none of `origins.api.paths` were wired, synth fails
  with `ProxySameOriginApi`.
- If some API paths (for example a raw route) were left unwired, synth warns.
- If the app has redirects, per-pattern headers or error pages and the door
  wired none of them (`cf.redirects`, `cf.headers`, `cf.errorPages`), synth
  warns (`FrontDoorRuleUnwired`).
- If `cf.behaviors` and `cf.apiBehaviors` handed out more than the 24
  behaviors a distribution allows besides its default, synth warns
  (`FrontDoorBehaviorLimit`).

It does not check features. If a door ignores `features.waf`, the app deploys
without a WAF.

**Redirects, headers and error pages.** `cf.redirects(scope, app.redirects)`
and `cf.headers(scope, app.headers)` return CloudFront Function associations
(viewer request and viewer response) that run the same matcher as the built-in
CloudFront door, with the rules inline (a CloudFront Function holds at most
10 KB, so synth fails above that). `cf.errorPages(app.errorPages, origins)`
returns the distribution's `errorResponses` and the behaviors that serve the
pages from the assets. Each returns an empty value when the app has none, so it
can be spread unconditionally. `cf.behaviors` gives an image-optimization
route a cache policy that honors the image function's `Cache-Control` (one per
stack), and `cf.invalidate` grants `cloudfront:CreateInvalidation` on that
distribution only.

**Known limit.** The check sees only what the helpers recorded, so a door that
wires correctly with raw CDK gets a false alarm. Declare hand-wired origins with
`cf.recordWired(origins.assets)` and `cf.recordWired(origins.api)` (optionally
with the paths you wired), hand-wired rules with `cf.recordWired(app.redirects)`
(likewise `app.headers`, `app.errorPages`), or turn the check off with
`frontDoor: { kind: 'custom', door, wiringCheck: false }`.

**Testing a door.** Use `assertDoorConformance(door)` from
`@aws-blocks/hosting/constructs` in the door's own tests. It builds the door
against a sample SPA with an API and runs the same checks: the shape, a
non-empty `url`, and the wiring.

The built-in doors (`cloudFrontDoor`, `albDoor`, `apiGatewayDoor`,
`s3WebsiteDoor`, `cloudFrontEdgeDoor`) are written the same way, and the pieces
they share are exported for your own doors: `generateAlbAssetProxyCode` and
`generateApiGwAssetProxyCode` (pass `app.redirects`, `app.headers` and the
error pages to apply the app's rules; see `AssetProxyOptions`; set
`environment: assetProxyEnvironment(origins.assets)` on the function and
`origins.assets.bucket.grantRead(fn)`),
`generateAlbApiProxyCode` (the ALB's same-origin API forwarder),
`backendBaseUrl`, `coalesceRoutes`, `routeSpecificity`,
`createSecurityHeadersPolicy`, and `ORIGIN_VERIFY_HEADER` /
`CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST`.

**A door that stacks CloudFront over its own ALB.** Lock the ALB to the
distribution the same way the stacked door does: admit only CloudFront in the
ALB's security group, and require a secret header that only the distribution
sends.

```ts
import { OriginProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST, ORIGIN_VERIFY_HEADER } from '@aws-blocks/hosting/constructs';

// In build(scope, input): `alb` is your ApplicationLoadBalancer, `target` its target group.
// A random value (alphanumeric: an ALB header condition treats `*` and `?` as
// wildcards), read by both sides through a dynamic reference.
const secret = new Secret(scope, 'OriginVerify', {
  generateSecretString: { passwordLength: 64, excludePunctuation: true, includeSpace: false },
}).secretValue.unsafeUnwrap();
const listener = alb.addListener('Http', {
  port: 80,
  open: false, // no 0.0.0.0/0 ingress
  defaultAction: elbv2.ListenerAction.fixedResponse(403, { contentType: 'text/plain', messageBody: 'Forbidden' }),
});
listener.addTargetGroups('FromCloudFront', {
  priority: 1,
  conditions: [elbv2.ListenerCondition.httpHeader(ORIGIN_VERIFY_HEADER, [secret])],
  targetGroups: [target],
});
const cloudFront = ec2.PrefixList.fromLookup(scope, 'CloudFront', { prefixListName: CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST });
alb.connections.allowFrom(ec2.Peer.prefixList(cloudFront.prefixListId), ec2.Port.tcp(80));
const origin = new HttpOrigin(alb.loadBalancerDnsName, {
  protocolPolicy: OriginProtocolPolicy.HTTP_ONLY, // the listener above is HTTP :80 (HttpOrigin defaults to HTTPS)
  customHeaders: { [ORIGIN_VERIFY_HEADER]: secret },
});
```

`PrefixList.fromLookup` needs the stack's `env` (account and region); the
built-in door looks the list up at deploy time instead. For an internal ALB,
use `VpcOrigin.withApplicationLoadBalancer(alb)` and admit the VPC origin's
`CloudFront-VPCOrigins-Service-SG` security group (see the CDK
`aws-cloudfront-origins` documentation).
