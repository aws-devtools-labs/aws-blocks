// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CloudFront EDGE of the stacked door (`{ kind: 'stacked', edge: 'cloudfront',
 * router: 'alb' }`), written as a free-form door.
 *
 * A distribution in front of the door it stacks on — the ALB router, handed
 * over as `input.upstream`: its default behavior forwards to the router, and
 * the router routes to the rest of the infra; the static routes are its own S3
 * behaviors (below). The viewer hop is HTTPS at the edge. The edge → router hop
 * follows the router: HTTPS :443 when it has a certificate (and a domain the
 * certificate covers), else plain HTTP :80 — unencrypted, on the AWS network
 * through a VPC origin (internal router), to the ALB's public addresses
 * otherwise.
 *
 * Except the static routes: the edge serves those itself, straight from the
 * private assets bucket (origin access control, the `cf` helpers' S3 origin
 * and asset behavior), so only the API and the dynamic routes reach the
 * router (see `planEdgeBehaviors`). A site without a server is served from S3
 * entirely, but for its API.
 *
 * The router admits only this edge: it hands over (in its `originHandle`) the
 * origin-verify header every request must carry, which the edge sets as the
 * origin's custom headers, and — for an internal ALB — the balancer itself,
 * which the edge reaches through a CloudFront VPC origin and admits into the
 * balancer's security group (the VPC origin's `CloudFront-VPCOrigins-Service-SG`,
 * looked up after the distribution, since CloudFormation doesn't return it).
 *
 * `build` creates:
 *   - for the dynamic routes (SSR) and the default, a cache policy that HONORS
 *     the router's origin `Cache-Control` (no `Cache-Control`, no caching),
 *     with cookies forwarded and keyed so cookie auth works through the edge;
 *     a viewer-request function copies the viewer `Host` into
 *     `x-forwarded-host`, so the server builds absolute URLs on the public
 *     host, not the router's;
 *   - for the API paths, no caching at all (as on the CloudFront door);
 *   - for static and image routes the router serves (beyond the behavior
 *     budget, or image optimization), the origin's TTLs with no cookies in the
 *     key, so visitors with different cookies share one cached object;
 *   - the security headers (HSTS, X-Frame-Options, …) the ALB can't inject;
 *   - the BYO CLOUDFRONT-scoped web ACL (`webAclArn`), when the app brings one —
 *     the router carries its own regional WAF separately. Building a web ACL and
 *     custom domain/TLS on the edge are follow-ons.
 *
 * The router still sees `x-forwarded-proto: http` on the edge → router hop
 * when that hop is plain HTTP (the ALB sets the header from its listener).
 */
import { Annotations, Duration } from 'aws-cdk-lib';
import { AWS_DEFAULT_QUOTAS } from './quota_budget.js';
import { ALB_LAMBDA_RESPONSE_LIMIT, warnOversizedProxyAssets } from './proxy_limits.js';
import {
  AllowedMethods,
  type BehaviorOptions,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  type Function as CloudFrontFunction,
  FunctionEventType,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, VpcOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { IApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { ASSET_BEHAVIOR_OPTIONS, assetsS3Origin, cf, inlineFunction, trimSlashes } from './cf_helpers.js';
import { customErrorResponses } from './error_responses.js';
import { type DoorInput, type DoorUpstream, defineFrontDoor, type FrontDoorResult } from './front_door.js';
import { proxyRulesJs } from './proxy_rules.js';
import { createSecurityHeadersPolicy } from './security_headers.js';

/** The edge's input: the {@link DoorInput} plus the router it fronts (`upstream`) and internal-only edge settings. */
export type CloudFrontEdgeDoorInput = DoorInput & {
  /** The door this edge sits in front of — the ALB router of the stacked door. */
  upstream: DoorUpstream;
  /** CSP for the edge's security-headers policy. */
  contentSecurityPolicy?: string;
  /** BYO CLOUDFRONT-scoped web ACL ARN for the edge. */
  webAclArn?: string;
};

/** The edge's result: the {@link FrontDoorResult} plus the distribution it built. */
export type CloudFrontEdgeDoorResult = FrontDoorResult & {
  /** The edge distribution. */
  distribution: Distribution;
  /**
   * The viewer-request function of the S3 behaviors, when the edge has any. It
   * carries the build id, so it is the edge's build cutover: the caller makes
   * it wait for the build's asset uploads.
   */
  staticFunction?: CloudFrontFunction;
};

/** The built-in CloudFront edge of the stacked door. */
export const cloudFrontEdgeDoor = defineFrontDoor<CloudFrontEdgeDoorInput, CloudFrontEdgeDoorResult>({
  service: 'cloudfront-edge',

  /** @throws Error when there is no `upstream` door to front. */
  build(scope, input) {
    const router = input.upstream;
    if (!router) {
      throw new Error('cloudfront-edge door: the stacked edge needs the router door it fronts as `upstream`.');
    }
    const handle = router.originHandle;
    // The headers the router requires on every request (its origin-verify secret).
    const customHeaders = handle.customHeaders ? { ...handle.customHeaders } : undefined;
    // The edge → router hop uses the router listener's protocol and port: HTTP
    // :80, or HTTPS :443 when the router has a certificate. (For HTTPS, the
    // certificate must cover the name CloudFront connects to.)
    const https = handle.protocol === 'https';
    const protocolPolicy = https ? OriginProtocolPolicy.HTTPS_ONLY : OriginProtocolPolicy.HTTP_ONLY;
    const routerPort = https ? 443 : 80;
    const origin = handle.privateLoadBalancer
      ? VpcOrigin.withApplicationLoadBalancer(handle.privateLoadBalancer, {
          protocolPolicy,
          customHeaders,
          // Over HTTPS, the name the router's certificate covers (not the ALB's own).
          ...(https ? { domainName: handle.domainName } : {}),
        })
      : new HttpOrigin(handle.domainName, {
          protocolPolicy,
          customHeaders,
        });
    const cachePolicy = new CachePolicy(scope, 'CfAlbCache', {
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      cookieBehavior: CacheCookieBehavior.all(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const securityHeaders = createSecurityHeadersPolicy(scope, 'CfOverAlbSecurityHeaders', {
      contentSecurityPolicy: input.contentSecurityPolicy,
    });
    const { app, origins } = input;
    // The app's header rules, at the edge on every behavior (as on the
    // CloudFront door): a response served from S3 never passes the router.
    const headerFunctions = cf.headers(scope, app.headers);
    // The router's origin Host is the ALB's; the server reads the public host
    // from `x-forwarded-host` (as behind the CloudFront door's KVS router).
    const forwardedHost = inlineFunction(scope, 'CfOverAlbForwardedHost', 'stacked edge', FORWARDED_HOST_CODE);
    const routerBase = {
      origin,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: securityHeaders,
      functionAssociations: [{ function: forwardedHost, eventType: FunctionEventType.VIEWER_REQUEST }, ...headerFunctions],
    } satisfies BehaviorOptions;
    const routerBehavior: BehaviorOptions = { ...routerBase, cachePolicy };
    // The API: never cached at the edge (as on the CloudFront door).
    const apiBehavior: BehaviorOptions = { ...routerBase, cachePolicy: CachePolicy.CACHING_DISABLED };
    // Static and image routes the router serves: the origin's TTLs, no cookies
    // in the key (the response doesn't vary by visitor).
    let assetCachePolicy: CachePolicy | undefined;
    const routerAssetBehavior = (): BehaviorOptions => {
      assetCachePolicy ??= new CachePolicy(scope, 'CfAlbAssetCache', {
        defaultTtl: Duration.seconds(0),
        minTtl: Duration.seconds(0),
        maxTtl: Duration.days(365),
        cookieBehavior: CacheCookieBehavior.none(),
        headerBehavior: CacheHeaderBehavior.allowList('accept'),
        queryStringBehavior: CacheQueryStringBehavior.all(),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      });
      return { ...routerBase, cachePolicy: assetCachePolicy };
    };

    // Static routes are served straight from the private bucket (Origin Access
    // Control, at the build prefix, as on the CloudFront door); a viewer-request
    // function resolves the path exactly as the router's asset proxy would.
    const plan = planEdgeBehaviors(input);
    let s3Behavior: BehaviorOptions | undefined;
    let staticFn: CloudFrontFunction | undefined;
    if (plan.usesS3) {
      staticFn = inlineFunction(scope, 'CfOverAlbStatic', 'stacked edge', staticRequestCode(input));
      s3Behavior = {
        ...ASSET_BEHAVIOR_OPTIONS,
        // `listable`: a missing file is S3's 404, not its 403. At the bucket
        // root: the function writes the build prefix into the URI, so the
        // build id is in the cache key (a new build never hits the previous
        // build's cached objects), as on the CloudFront door.
        origin: assetsS3Origin(origins.assets, { listable: true, bucketRoot: true }),
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [{ function: staticFn, eventType: FunctionEventType.VIEWER_REQUEST }, ...headerFunctions],
      };
    }
    const behaviorFor = (target: EdgeTarget): BehaviorOptions => {
      if (target === 's3' && s3Behavior) return s3Behavior;
      if (target === 'api') return apiBehavior;
      if (target === 'routerAsset') return routerAssetBehavior();
      return routerBehavior;
    };
    if (plan.truncated) {
      Annotations.of(scope).addWarningV2(
        '@aws-blocks/hosting:StackedEdgeBehaviorLimit',
        `The stacked door's edge needs ${plan.wanted} cache behaviors to serve every static route from S3; ` +
          `a CloudFront distribution allows ${MAX_EDGE_BEHAVIORS} besides its default by default. The edge keeps ` +
          `${plan.behaviors.length}; the remaining static routes are served through the ALB router (correct, but not ` +
          'edge-direct, and subject to its 1 MB response limit). Group static routes under fewer prefixes, or move ' +
          'raw backend routes under `/aws-blocks/`.',
      );
    }
    // What reaches the router's asset proxy (the ALB's 1 MB Lambda response
    // limit): with the router as the default, every static file no S3
    // behavior serves. With S3 as the default, no static file goes there.
    if (plan.defaultTarget === 'router') {
      warnOversizedProxyAssets(scope, {
        door: 'stacked (ALB router)',
        limitBytes: ALB_LAMBDA_RESPONSE_LIMIT,
        limitLabel: '1 MB',
        staticDir: origins.assets.sourceDir,
        urlPrefix: app.basePath ?? '',
        servedElsewhere: plan.behaviors.filter(([, t]) => t === 's3').map(([p]) => p),
      });
    }

    // The app's error pages, as on the CloudFront door: every 404 / 500 from
    // any origin answers with the page (served from S3).
    const errorResponses = customErrorResponses(app.errorPages, {
      pathPrefix: buildPrefix(input),
      hasCompute: Boolean(origins.server),
    });

    const additionalBehaviors: Record<string, BehaviorOptions> = {};
    for (const [pattern, target] of plan.behaviors) additionalBehaviors[pattern] = behaviorFor(target);
    const distribution = new Distribution(scope, 'CfOverAlb', {
      comment: 'Blocks composed CF → ALB edge (static from S3, the rest through the ALB router)',
      defaultBehavior: behaviorFor(plan.defaultTarget),
      // The S3 default (a site without a server) is listable; the function
      // turns every path into a file key (a trailing `/` gets `index.html`), and
      // the root object keeps the bare `/` off the bucket listing too.
      ...(plan.defaultTarget === 's3' ? { defaultRootObject: 'index.html' } : {}),
      ...(Object.keys(additionalBehaviors).length > 0 ? { additionalBehaviors } : {}),
      ...(errorResponses.length > 0 ? { errorResponses } : {}),
      webAclId: input.webAclArn,
    });
    if (s3Behavior) {
      // LIST only turns a missing file into a 404: the static function maps
      // every request to a file key under the build prefix, so no request
      // reaches a bucket listing.
      Annotations.of(distribution).acknowledgeWarning(
        '@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk',
        "The stacked edge's viewer-request function maps every path to a file key under /builds/<buildId>/.",
      );
    }
    if (handle.privateLoadBalancer) admitVpcOrigin(scope, distribution, handle.privateLoadBalancer, routerPort);
    return {
      url: `https://${distribution.distributionDomainName}`,
      originHandle: { domainName: distribution.distributionDomainName, protocol: 'https' },
      distribution,
      ...(staticFn ? { staticFunction: staticFn } : {}),
    };
  },
});

/** The security group CloudFront creates for the VPC origins in a VPC. */
const VPC_ORIGINS_SERVICE_SG = 'CloudFront-VPCOrigins-Service-SG';

/**
 * Admit the distribution's VPC origin into a private ALB's security group:
 * CloudFront reaches the balancer from ENIs in its VPC that carry the
 * `CloudFront-VPCOrigins-Service-SG` security group. CloudFormation doesn't
 * return that group's id, so it is looked up (by name, in the balancer's VPC)
 * once the distribution — and so its VPC origin — exists.
 * The ingress opens `port`, the router listener's port (80, or 443 with a certificate).
 *
 * @throws Error when the balancer has no VPC (an imported balancer without one).
 */
const admitVpcOrigin = (
  scope: Construct,
  distribution: Distribution,
  alb: IApplicationLoadBalancer,
  port: number,
): void => {
  const vpcId = alb.vpc?.vpcId;
  if (!vpcId) throw new Error('cloudfront-edge door: the private ALB has no VPC to admit the VPC origin from.');
  const lookup = new AwsCustomResource(scope, 'CfVpcOriginSg', {
    onUpdate: {
      service: 'EC2',
      action: 'describeSecurityGroups',
      parameters: {
        Filters: [
          { Name: 'vpc-id', Values: [vpcId] },
          { Name: 'group-name', Values: [VPC_ORIGINS_SERVICE_SG] },
        ],
      },
      physicalResourceId: PhysicalResourceId.of(VPC_ORIGINS_SERVICE_SG),
      outputPaths: ['SecurityGroups.0.GroupId'],
    },
    policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
    installLatestAwsSdk: false,
  });
  // The group appears with the VPC origin, so look it up after the distribution.
  lookup.node.addDependency(distribution);
  // A standalone ingress rule (not inline on the group): the group is the
  // balancer's, which the VPC origin — and so the lookup — waits for.
  const sourceSecurityGroupId = lookup.getResponseField('SecurityGroups.0.GroupId');
  alb.connections.securityGroups.forEach((group, i) => {
    new ec2.CfnSecurityGroupIngress(scope, `CfVpcOriginIngress${i === 0 ? '' : i + 1}`, {
      groupId: group.securityGroupId,
      sourceSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: port,
      toPort: port,
      description: 'CloudFront VPC origin only',
    });
  });
};

// ── Which behaviors the edge needs ──────────────────────────────────────────

/**
 * Where an edge behavior sends a request: the private bucket, or the ALB
 * router — for the API (never cached), a static or image route (the origin's
 * TTLs, no cookies in the key), or anything else (the origin's TTLs, cookies
 * keyed).
 */
type EdgeTarget = 's3' | 'router' | 'api' | 'routerAsset';

/**
 * CloudFront's default quota of cache behaviors per distribution, less the
 * default behavior: the additional behaviors an edge can have (as the
 * CloudFront door counts them, see `quota_budget.ts`).
 */
export const MAX_EDGE_BEHAVIORS = AWS_DEFAULT_QUOTAS.cacheBehaviors - 1;

/** The path-pattern characters CloudFront accepts (and at most 255 of them). */
const CLOUDFRONT_PATH_PATTERN = /^[A-Za-z0-9_\-.*$/~"'@:+&]{1,255}$/;

const CATCH_ALL_PATTERNS = new Set(['*', '/*']);

/** A pattern's literal prefix (before its first wildcard). */
const literalPrefix = (pattern: string): string => {
  const star = pattern.indexOf('*');
  return star === -1 ? pattern : pattern.substring(0, star);
};

/**
 * Whether a request under `apiPattern` could match `s3Pattern` (so the API
 * behavior must stay ahead of it): either literal prefix extends the other.
 */
const mayOverlap = (apiPattern: string, s3Pattern: string): boolean => {
  const a = literalPrefix(apiPattern);
  const b = literalPrefix(s3Pattern);
  return a.startsWith(b) || b.startsWith(a);
};

/**
 * The edge's behaviors, in the router's order of precedence (the ALB rules:
 * the API first, then the routes most-specific first), so a request reaches
 * the same origin through the edge as through the router alone:
 *
 * - the API paths → the router, uncached;
 * - the error-page paths → S3;
 * - each route: a static (assets) route → S3, an image route → the router
 *   (cookies not keyed), any other → the router;
 * - the default: S3 when the implicit catch-all is static (a site without a
 *   server), else the router.
 *
 * Trailing behaviors that go where the default goes are dropped (they change
 * nothing). Over {@link MAX_EDGE_BEHAVIORS}, the default becomes the router
 * (which serves everything correctly); the API behaviors no kept S3 pattern
 * can shadow are dropped first (the router default reaches them, and without
 * a `Cache-Control` it does not cache them), then the list is cut to a prefix
 * — still correct, since the edge evaluates it in the router's order.
 */
const planEdgeBehaviors = (
  input: DoorInput,
): {
  behaviors: Array<[string, EdgeTarget]>;
  defaultTarget: 's3' | 'router';
  usesS3: boolean;
  truncated: boolean;
  wanted: number;
} => {
  const { app, origins } = input;
  const wanted: Array<[string, EdgeTarget]> = [];
  const seen = new Set<string>();
  const add = (pattern: string, target: EdgeTarget) => {
    if (seen.has(pattern) || CATCH_ALL_PATTERNS.has(pattern) || pattern === '/') return;
    if (!CLOUDFRONT_PATH_PATTERN.test(pattern)) return; // not a CloudFront pattern: the default serves it
    seen.add(pattern);
    wanted.push([pattern, target]);
  };
  for (const path of origins.api?.paths ?? []) add(path, 'api');
  for (const r of customErrorResponses(app.errorPages, { pathPrefix: buildPrefix(input), hasCompute: Boolean(origins.server) })) {
    if (r.responsePagePath) add(r.responsePagePath, 's3');
  }
  // The catch-all is implicit in the route table: the server when there is
  // one, else the static assets (the router's default target, too).
  const catchAll: 's3' | 'router' = origins.server ? 'router' : 's3';
  for (const route of app.routes) {
    const kind = route.origin.kind;
    add(route.pattern, kind === 'assets' ? 's3' : kind === 'image' ? 'routerAsset' : 'router');
  }
  const trim = (list: Array<[string, EdgeTarget]>, dflt: EdgeTarget) => {
    const out = [...list];
    while (out.length > 0 && out[out.length - 1][1] === dflt) out.pop();
    return out;
  };
  let defaultTarget = catchAll;
  let behaviors = trim(wanted, defaultTarget);
  let truncated = false;
  if (behaviors.length > MAX_EDGE_BEHAVIORS) {
    truncated = true;
    defaultTarget = 'router';
    const s3Patterns = wanted.filter(([, t]) => t === 's3').map(([p]) => p);
    const kept = wanted.filter(([p, t]) => t !== 'api' || s3Patterns.some((s) => mayOverlap(p, s)));
    behaviors = trim(trim(kept, 'router').slice(0, MAX_EDGE_BEHAVIORS), 'router');
  }
  const usesS3 = defaultTarget === 's3' || behaviors.some(([, t]) => t === 's3');
  return { behaviors, defaultTarget, usesS3, truncated, wanted: trim(wanted, catchAll).length };
};

/**
 * The viewer-request function of the router behaviors (CloudFront Functions,
 * JS 2.0): the viewer's `Host` as `x-forwarded-host` (the origin request
 * carries the router's host).
 */
const FORWARDED_HOST_CODE = `function handler(event) {
  var request = event.request;
  var host = request.headers.host && request.headers.host.value;
  if (host) { request.headers['x-forwarded-host'] = { value: host }; }
  return request;
}`;

/**
 * The viewer-request function of the edge's S3 behaviors (CloudFront
 * Functions, JS 2.0): the app's redirects first (an S3 behavior never reaches
 * the router that would answer them), then the router's static path
 * resolution — strip the basePath / assetPrefix, then the directory index or
 * the single-page-app fallback — and prefix the build (`/builds/<buildId>`),
 * so the build id is in the edge cache key.
 * The same rule and resolution code as the router's asset proxy
 * (`proxy_rules.ts`).
 */
const staticRequestCode = (input: DoorInput): string => {
  const { app, origins } = input;
  const strip = app.basePath ?? app.assetPrefix ?? '';
  const spa = app.spaFallback && !origins.server;
  return `${proxyRulesJs({ redirects: app.redirects })}
var STRIP_PREFIX = ${JSON.stringify(strip)};
var SPA_FALLBACK = ${spa ? 'true' : 'false'};
var BUILD_PREFIX = ${JSON.stringify(buildPrefix(input))};
function handler(event) {
  var request = event.request;
  var redirect = blocksRedirectResponse(request.uri);
  if (redirect) return redirect;
  // The viewer's URI, for the header rules at viewer-response (see VIEWER_URI_HEADER).
  request.headers['x-blocks-viewer-uri'] = { value: request.uri };
  request.uri = BUILD_PREFIX + resolveIndex(stripBasePath(request.uri, STRIP_PREFIX), SPA_FALLBACK);
  return request;
}`;
};

/** The build's key prefix in the bucket, as a URI path (`/builds/<buildId>`). */
const buildPrefix = (input: DoorInput): string => `/${trimSlashes(input.origins.assets.prefix)}`;
