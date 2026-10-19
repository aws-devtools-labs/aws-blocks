// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The CloudFront EDGE of the stacked door (`{ kind: 'stacked', edge: 'cloudfront',
 * router: 'alb' }`), written as a free-form door.
 *
 * A thin distribution whose single default behavior forwards EVERYTHING to the
 * door it sits in front of — the ALB router, handed over as `input.upstream`:
 * CloudFront's one origin is the router, and the router routes to the rest of
 * the infra. The internal edge → router hop is HTTP; the viewer hop is HTTPS at
 * the edge.
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
 *   - a cache policy that HONORS the router's origin `Cache-Control`
 *     (`immutable` hashed assets edge-cached; `no-cache` HTML/API not), with
 *     cookies forwarded and keyed so cookie auth works through the edge;
 *   - the security headers (HSTS, X-Frame-Options, …) the ALB can't inject;
 *   - the BYO CLOUDFRONT-scoped web ACL (`webAclArn`), when the app brings one —
 *     the router carries its own regional WAF separately. Building a web ACL and
 *     custom domain/TLS on the edge are follow-ons.
 */
import { Annotations, Duration } from 'aws-cdk-lib';
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
import { ASSET_BEHAVIOR_OPTIONS, assetsS3Origin, cf, inlineFunction } from './cf_helpers.js';
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
    const routerBehavior: BehaviorOptions = {
      origin,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: securityHeaders,
      ...(headerFunctions.length > 0 ? { functionAssociations: headerFunctions } : {}),
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
    const behaviorFor = (target: EdgeTarget): BehaviorOptions =>
      target === 's3' && s3Behavior ? s3Behavior : routerBehavior;
    if (plan.truncated) {
      Annotations.of(scope).addWarningV2(
        '@aws-blocks/hosting:StackedEdgeBehaviorLimit',
        `The stacked door's edge needs ${plan.wanted} cache behaviors to serve every static route from S3; ` +
          `CloudFront allows ${MAX_EDGE_BEHAVIORS} per distribution by default. The edge keeps ${plan.behaviors.length}; ` +
          'the remaining static routes are served through the ALB router (correct, but not edge-direct). ' +
          'Group static routes under fewer prefixes, or raise the quota.',
      );
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

/** Where an edge behavior sends a request: the private bucket, or the ALB router. */
type EdgeTarget = 's3' | 'router';

/** CloudFront's default quota of cache behaviors per distribution. */
export const MAX_EDGE_BEHAVIORS = 25;

/** The path-pattern characters CloudFront accepts (and at most 255 of them). */
const CLOUDFRONT_PATH_PATTERN = /^[A-Za-z0-9_\-.*$/~"'@:+&]{1,255}$/;

const CATCH_ALL_PATTERNS = new Set(['*', '/*']);

/**
 * The edge's behaviors, in the router's order of precedence (the ALB rules:
 * the API first, then the routes most-specific first), so a request reaches
 * the same origin through the edge as through the router alone:
 *
 * - the API paths → the router;
 * - the error-page paths → S3;
 * - each route: a static (assets) route → S3, any other → the router;
 * - the default: S3 when the implicit catch-all is static (a site without a
 *   server), else the router.
 *
 * Trailing behaviors that go where the default goes are dropped (they change
 * nothing). Over CloudFront's {@link MAX_EDGE_BEHAVIORS}, the default becomes
 * the router (which serves everything correctly) and the list is cut to a
 * prefix — still correct, since the edge evaluates it in the router's order.
 */
const planEdgeBehaviors = (
  input: DoorInput,
): {
  behaviors: Array<[string, EdgeTarget]>;
  defaultTarget: EdgeTarget;
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
  for (const path of origins.api?.paths ?? []) add(path, 'router');
  for (const r of customErrorResponses(app.errorPages, { pathPrefix: buildPrefix(input), hasCompute: Boolean(origins.server) })) {
    if (r.responsePagePath) add(r.responsePagePath, 's3');
  }
  // The catch-all is implicit in the route table: the server when there is
  // one, else the static assets (the router's default target, too).
  const catchAll: EdgeTarget = origins.server ? 'router' : 's3';
  for (const route of app.routes) add(route.pattern, route.origin.kind === 'assets' ? 's3' : 'router');
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
    behaviors = trim(trim(wanted, 'router').slice(0, MAX_EDGE_BEHAVIORS), 'router');
  }
  const usesS3 = defaultTarget === 's3' || behaviors.some(([, t]) => t === 's3');
  return { behaviors, defaultTarget, usesS3, truncated, wanted: trim(wanted, catchAll).length };
};

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
  request.uri = BUILD_PREFIX + resolveIndex(stripBasePath(request.uri, STRIP_PREFIX), SPA_FALLBACK);
  return request;
}`;
};

/** The build's key prefix in the bucket, as a URI path (`/builds/<buildId>`). */
const buildPrefix = (input: DoorInput): string => `/${input.origins.assets.prefix.replace(/^\/+|\/+$/g, '')}`;
