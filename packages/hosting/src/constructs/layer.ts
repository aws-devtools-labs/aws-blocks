// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attach point for stacking front doors.
 *
 * A URL is a fine ADDRESS but not an ATTACH POINT: to put one door in front of
 * another (CloudFront edge → ALB router → origins), the outer door must point
 * its origin at the inner one, and for that it needs a hostname + protocol, not
 * a bare string. A door's `build` may return an {@link OriginHandle}
 * (`FrontDoorResult.originHandle`); when it doesn't, one is derived from its
 * `url` by {@link originHandleFromUrl}.
 *
 * These types are CDK-aware (constructs layer) — unlike the service-neutral
 * `plan/` layer, an attach handle inevitably references the concrete edge/origin.
 */
import { Fn, Token } from 'aws-cdk-lib';
import type { IApplicationLoadBalancer } from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * How an OUTER door attaches to this door as an origin. A hostname + protocol
 * covers the common HTTP(S)-origin attach (an ALB DNS name, an API Gateway host,
 * a CloudFront domain, an S3-website endpoint); it can be extended (e.g. with a
 * VPC-origin target for a private ALB) as needed.
 *
 * A door that admits only the door in front of it says how: the headers the
 * outer door must send ({@link customHeaders}), and, for a private load
 * balancer, the balancer itself ({@link privateLoadBalancer}) so a CloudFront
 * door in front reaches it through a VPC origin. The stacked door's ALB router
 * sets both.
 */
export type OriginHandle = {
  /** Hostname WITHOUT scheme that an outer door points an HTTP(S) origin at. */
  domainName: string;
  /** Origin protocol — `http` for the S3-website endpoint, `https` otherwise. */
  protocol: 'http' | 'https';
  /**
   * Headers the outer door must send on EVERY request to this origin (e.g. an
   * origin-verify secret); the origin refuses a request without them. A
   * CloudFront door sets them as the origin's custom headers.
   */
  customHeaders?: Readonly<Record<string, string>>;
  /**
   * The origin is a private (internal) Application Load Balancer, not reachable
   * from the internet: a CloudFront door in front reaches it through a
   * CloudFront VPC origin (`VpcOrigin.withApplicationLoadBalancer`) and admits
   * that VPC origin into the balancer's security group.
   */
  privateLoadBalancer?: IApplicationLoadBalancer;
};

/**
 * Derive the {@link OriginHandle} for a door from its public `url`.
 *
 * `url` is usually a CDK token (e.g. `https://${dist.distributionDomainName}`),
 * so the host is sliced out IN-TEMPLATE with `Fn::Split`/`Fn::Select` — string
 * methods would operate on the unresolved placeholder text. The scheme is read
 * from the literal prefix when there is one (a template string keeps its
 * `https://` prefix even around a token); a fully opaque token defaults to
 * `https`.
 *
 * @param url the door's public URL (`<scheme>://<host>[/<path>]`).
 * @returns the host to point an origin at, and the protocol to reach it with.
 */
export function originHandleFromUrl(url: string): OriginHandle {
  const protocol: OriginHandle['protocol'] = url.startsWith('http://') ? 'http' : 'https';
  if (!Token.isUnresolved(url)) {
    const host = url.replace(/^[a-z]+:\/\//i, '').split('/')[0] ?? '';
    return { domainName: host, protocol };
  }
  // `https://host/path` split on '/' → ['https:', '', 'host', 'path'].
  return { domainName: Fn.select(2, Fn.split('/', url)), protocol };
}
