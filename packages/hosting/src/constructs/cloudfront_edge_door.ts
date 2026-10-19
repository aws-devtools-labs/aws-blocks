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
import { HttpOrigin, VpcOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { IApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
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
    const handle = router.originHandle;
    // The headers the router requires on every request (its origin-verify secret).
    const customHeaders = handle.customHeaders ? { ...handle.customHeaders } : undefined;
    const origin = handle.privateLoadBalancer
      ? VpcOrigin.withApplicationLoadBalancer(handle.privateLoadBalancer, {
          protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
          customHeaders,
        })
      : new HttpOrigin(handle.domainName, { protocolPolicy: OriginProtocolPolicy.HTTP_ONLY, customHeaders });
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
    if (handle.privateLoadBalancer) admitVpcOrigin(scope, distribution, handle.privateLoadBalancer);
    return {
      url: `https://${distribution.distributionDomainName}`,
      originHandle: { domainName: distribution.distributionDomainName, protocol: 'https' },
      distribution,
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
 *
 * @throws Error when the balancer has no VPC (an imported balancer without one).
 */
const admitVpcOrigin = (scope: Construct, distribution: Distribution, alb: IApplicationLoadBalancer): void => {
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
      fromPort: 80,
      toPort: 80,
      description: 'CloudFront VPC origin only',
    });
  });
};
