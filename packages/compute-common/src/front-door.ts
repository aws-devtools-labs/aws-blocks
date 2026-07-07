// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { BLOCKS_RPC_PREFIX } from '@aws-blocks/core';

export interface FrontDoorDomain {
  /** Custom domain to serve the API on. */
  readonly domainName: string;
  /** ACM certificate (us-east-1) for the domain. */
  readonly certificate: acm.ICertificate;
}

export interface CloudFrontFrontDoorProps {
  /** The HTTP origin the containers are reachable through (VPC origin, ALB origin, ...). */
  readonly origin: cloudfront.IOrigin;
  /** Optional custom domain. Without it the *.cloudfront.net domain is used. */
  readonly domain?: FrontDoorDomain;
  readonly comment?: string;
}

/**
 * HTTPS front door for a container-served Blocks backend.
 *
 * CloudFront in front of the load balancer gives the same properties the API
 * Gateway front door gives Lambda deployments with zero configuration: HTTPS
 * (so `Secure` auth cookies and OIDC redirects work), a stable public domain,
 * and a place to attach a custom domain later. Caching is disabled — this is
 * an API front door, not a CDN cache.
 */
export class CloudFrontFrontDoor extends Construct {
  public readonly distribution: cloudfront.Distribution;
  /** Full RPC URL: `https://{domain}/aws-blocks/api`. */
  public readonly apiUrl: string;
  /** Structured origin for Hosting (stage-less container URL). */
  public readonly apiOrigin: { readonly hostname: string; readonly originPath: string };
  /** Public origin (`https://{domain}`) — injected as BLOCKS_PUBLIC_ORIGIN so backend-built absolute URLs are browser-reachable. */
  public readonly publicOrigin: string;

  constructor(scope: Construct, id: string, props: CloudFrontFrontDoorProps) {
    super(scope, id);

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: props.comment ?? 'AWS Blocks backend front door',
      defaultBehavior: {
        origin: props.origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      ...(props.domain
        ? { domainNames: [props.domain.domainName], certificate: props.domain.certificate }
        : {}),
    });

    const domain = props.domain?.domainName ?? this.distribution.domainName;
    this.publicOrigin = `https://${domain}`;
    this.apiUrl = `${this.publicOrigin}${BLOCKS_RPC_PREFIX}`;
    this.apiOrigin = { hostname: domain, originPath: '' };
  }
}
