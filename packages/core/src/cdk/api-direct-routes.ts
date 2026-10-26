// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cr from 'aws-cdk-lib/custom-resources';
import { FORWARDED_HOST_HEADER, FORWARDED_STAGE_HEADER } from '../constants.js';
import { API_LISTENER_PORTS, type LoadBalancerIngress } from './api-vpc-link.js';

/**
 * An API path a CloudFront front door can route straight to a load-balanced
 * compute (a container) instead of through the shared API gateway: an
 * `/aws-blocks/api/{namespace}` path and the listener that serves it.
 *
 * @internal
 */
export interface ApiDirectRoute {
	readonly path: string;
	readonly ingress: LoadBalancerIngress;
}

/** The AWS-managed prefix list of CloudFront's origin-facing addresses (VPC origins included). */
const CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST = 'com.amazonaws.global.cloudfront.origin-facing';

/** How long CloudFront waits on a container for a response — the per-origin maximum without a quota increase. */
const DIRECT_ORIGIN_READ_TIMEOUT = cdk.Duration.seconds(60);

/**
 * Viewer-request function on every direct behavior: stamp the host the viewer
 * used (the distribution's or the app's custom domain) as the forwarded host, and
 * drop any forwarded stage — CloudFront serves the API from the origin root. Both
 * overwrite whatever the client sent, which is what lets the container trust
 * them (see `serveHttp`'s `trustForwardedHeaders`). The viewer host is read here,
 * at the edge: the `Host` CloudFront forwards to a VPC origin carries the origin
 * port (`<domain>:10000`).
 */
const FORWARDED_HOST_FUNCTION = `function handler(event) {
  var request = event.request;
  request.headers['${FORWARDED_HOST_HEADER}'] = { value: request.headers.host.value };
  delete request.headers['${FORWARDED_STAGE_HEADER}'];
  return request;
}`;

/** Marks a load balancer whose security group already admits CloudFront. */
const CLOUDFRONT_ADMITTED: unique symbol = Symbol.for('blocks:CloudFrontVpcOriginAdmitted');

/**
 * Route each direct API path on `distribution` straight to its compute's load
 * balancer listener through a CloudFront VPC origin, instead of through the
 * shared API gateway: no 29-second integration cap (CloudFront waits up to
 * {@link DIRECT_ORIGIN_READ_TIMEOUT}) and one hop fewer. Every other API path
 * keeps reaching the gateway through the distribution's other behaviors.
 *
 * Call before adding the `/aws-blocks/api/*` behavior: CloudFront matches
 * behaviors in the order they were added, and each direct path is an exact path
 * under that prefix.
 *
 * @param behaviorOptions the options of the distribution's other API behaviors
 *   (caching off, all methods, viewer headers forwarded except `Host`)
 * @internal
 */
export function addDirectApiBehaviors(
	distribution: cloudfront.Distribution,
	routes: readonly ApiDirectRoute[],
	behaviorOptions: cloudfront.AddBehaviorOptions,
): void {
	if (routes.length === 0) return;
	const forwardedHost = new cloudfront.Function(distribution, 'ApiForwardedHost', {
		code: cloudfront.FunctionCode.fromInline(FORWARDED_HOST_FUNCTION),
		runtime: cloudfront.FunctionRuntime.JS_2_0,
		comment: 'Blocks: stamp the viewer host for container API origins',
	});
	// One VPC origin per listener, shared by the namespaces it serves.
	const originsByListener = new Map<string, cloudfront.IOrigin>();
	for (const { path, ingress } of routes) {
		admitCloudFront(ingress.loadBalancer);
		const key = `${ingress.loadBalancer.node.addr}:${ingress.port}`;
		let origin = originsByListener.get(key);
		if (!origin) {
			origin = origins.VpcOrigin.withApplicationLoadBalancer(ingress.loadBalancer, {
				httpPort: ingress.port,
				protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
				readTimeout: DIRECT_ORIGIN_READ_TIMEOUT,
			});
			originsByListener.set(key, origin);
		}
		distribution.addBehavior(path, origin, {
			...behaviorOptions,
			functionAssociations: [{ function: forwardedHost, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
		});
	}
}

/**
 * Admit CloudFront's VPC origins to a load balancer's listener ports, once per
 * load balancer: one rule over the whole listener range, sourced from CloudFront's
 * origin-facing prefix list (VPC origin traffic keeps CloudFront's source
 * addresses). The prefix list's id differs per region, so it is looked up at
 * deploy time and the stack stays environment-agnostic.
 */
function admitCloudFront(loadBalancer: elbv2.IApplicationLoadBalancer): void {
	const marked = loadBalancer as unknown as Record<symbol, boolean | undefined>;
	if (marked[CLOUDFRONT_ADMITTED]) return;
	marked[CLOUDFRONT_ADMITTED] = true;
	const lookup = new cr.AwsCustomResource(loadBalancer, 'CloudFrontOriginFacingPrefixList', {
		onUpdate: {
			service: 'EC2',
			action: 'DescribeManagedPrefixLists',
			parameters: { Filters: [{ Name: 'prefix-list-name', Values: [CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST] }] },
			physicalResourceId: cr.PhysicalResourceId.of(CLOUDFRONT_ORIGIN_FACING_PREFIX_LIST),
			outputPaths: ['PrefixLists.0.PrefixListId'],
		},
		policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
		installLatestAwsSdk: false,
	});
	loadBalancer.connections.allowFrom(
		ec2.Peer.prefixList(lookup.getResponseField('PrefixLists.0.PrefixListId')),
		ec2.Port.tcpRange(API_LISTENER_PORTS.min, API_LISTENER_PORTS.max),
		'CloudFront VPC origins',
	);
}
