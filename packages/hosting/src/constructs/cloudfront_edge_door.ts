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
 * `build` creates:
 *   - a cache policy that HONORS the router's origin `Cache-Control`
 *     (`immutable` hashed assets edge-cached; `no-cache` HTML/API not), with
 *     cookies forwarded and keyed so cookie auth works through the edge;
 *   - the security headers (HSTS, X-Frame-Options, …) the ALB can't inject;
 *   - the BYO CLOUDFRONT-scoped web ACL (`webAclArn`), when the app brings one —
 *     the router carries its own regional WAF separately. Building a web ACL and
 *     custom domain/TLS on the edge are follow-ons.
 */
import { Duration } from 'aws-cdk-lib';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { type DoorInput, type DoorUpstream, defineFrontDoor, type FrontDoorResult } from './front_door.js';
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
    const origin = new HttpOrigin(router.originHandle.domainName, { protocolPolicy: OriginProtocolPolicy.HTTP_ONLY });
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
    const distribution = new Distribution(scope, 'CfOverAlb', {
      comment: 'Blocks composed CF → ALB edge (single origin: the ALB router)',
      defaultBehavior: {
        origin,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
      },
      webAclId: input.webAclArn,
    });
    return {
      url: `https://${distribution.distributionDomainName}`,
      originHandle: { domainName: distribution.distributionDomainName, protocol: 'https' },
      distribution,
    };
  },
});
