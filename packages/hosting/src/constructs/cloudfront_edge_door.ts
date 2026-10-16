/**
 * The CloudFront EDGE of the stacked door (`{ kind: 'stacked', edge: 'cloudfront',
 * router: 'alb' }`), defined with hooks.
 *
 * A thin distribution whose single default behavior forwards EVERYTHING to the
 * child router layer (the ALB, passed as the `'/*'` child): CloudFront's one
 * origin is the router, and the router routes to the rest of the infra. The
 * internal edge → router hop is HTTP; the viewer hop is HTTPS at the edge.
 *
 *   - `route` — a cache policy that HONORS the router's origin `Cache-Control`
 *     (`immutable` hashed assets edge-cached; `no-cache` HTML/API not), with
 *     cookies forwarded and keyed so cookie auth works through the edge; plus
 *     the security headers (HSTS, X-Frame-Options, …) the ALB can't inject.
 *     Reports edge caching and response headers.
 *   - `waf` — a BYO CLOUDFRONT-scoped web ACL (`webAclArn`); the router carries
 *     its own regional WAF separately. Building a web ACL and custom domain/TLS
 *     on the edge are follow-ons — no `customDomain` hook yet.
 */
import { Duration } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  type IResponseHeadersPolicy,
  type IOrigin,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import type { AdapterContext } from '../plan/types.js';
import { defineFrontDoor } from './door_hooks.js';
import { createSecurityHeadersPolicy } from './security_headers.js';

/** Context the edge reads. */
export type CloudFrontEdgeContext = AdapterContext & {
  /** CSP for the edge's security-headers policy. */
  contentSecurityPolicy?: string;
  /** BYO CLOUDFRONT-scoped web ACL ARN for the edge. */
  webAclArn?: string;
};

/** The edge's state: the pieces the hooks build, assembled into the distribution by `handle`. */
export type CloudFrontEdgeState = {
  scope: Construct;
  origin: IOrigin;
  cachePolicy?: CachePolicy;
  securityHeaders?: IResponseHeadersPolicy;
  webAclId?: string;
  /** Set by `handle`. */
  distribution?: Distribution;
};

export const cloudFrontEdgeDoor = defineFrontDoor<CloudFrontEdgeState, CloudFrontEdgeContext>({
  service: 'cloudfront-edge',

  create(scope, _ctx, children) {
    const router = children?.get('/*');
    if (!router) {
      throw new Error("cloudfront-edge door: the stacked edge needs a router layer as its '/*' child.");
    }
    return {
      scope,
      origin: new HttpOrigin(router.originHandle.domainName, { protocolPolicy: OriginProtocolPolicy.HTTP_ONLY }),
    };
  },

  route(door, _plan, ctx) {
    door.cachePolicy = new CachePolicy(door.scope, 'CfAlbCache', {
      defaultTtl: Duration.seconds(0),
      minTtl: Duration.seconds(0),
      maxTtl: Duration.days(365),
      cookieBehavior: CacheCookieBehavior.all(),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    door.securityHeaders = createSecurityHeadersPolicy(door.scope, 'CfOverAlbSecurityHeaders', {
      contentSecurityPolicy: ctx.contentSecurityPolicy,
    });
    return { cache: true, responseHeaders: true };
  },

  handle(door) {
    const distribution = new Distribution(door.scope, 'CfOverAlb', {
      comment: 'Blocks composed CF → ALB edge (single origin: the ALB router)',
      defaultBehavior: {
        origin: door.origin,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: door.cachePolicy,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: door.securityHeaders,
      },
      webAclId: door.webAclId,
    });
    door.distribution = distribution;
    return {
      url: `https://${distribution.distributionDomainName}`,
      originHandle: { domainName: distribution.distributionDomainName, protocol: 'https' },
    };
  },

  waf(door, ctx) {
    door.webAclId = ctx.webAclArn;
    return 'edge';
  },
});
