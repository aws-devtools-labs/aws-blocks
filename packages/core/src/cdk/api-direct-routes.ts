// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { BLOCKS_RPC_PREFIX, FORWARDED_HOST_HEADER, FORWARDED_STAGE_HEADER } from '../constants.js';
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

/**
 * How long CloudFront waits on a container for a response: the load balancer's
 * (default) 60 s idle timeout, which ends a longer call anyway — raise both
 * together (CloudFront allows up to 120 s per origin by default).
 */
const DIRECT_ORIGIN_READ_TIMEOUT = cdk.Duration.seconds(60);

/** Synth-warning id emitted when a distribution routes container namespaces directly but has no web ACL. */
export const DIRECT_ROUTES_WITHOUT_WAF_WARNING = 'blocks:api:direct-routes-without-waf';

/** Synth-warning id emitted when container namespaces stay on the gateway because their VPC has no public subnets. */
export const DIRECT_ROUTES_WITHOUT_PUBLIC_SUBNETS_WARNING = 'blocks:api:direct-routes-without-public-subnets';

/**
 * CloudFront's default quota of cache behaviors per distribution, the default
 * behavior included ("Cache behaviors per distribution", 75, adjustable).
 */
export const DEFAULT_CACHE_BEHAVIOR_LIMIT = 75;

/**
 * The cache-behavior quota a distribution's direct routes are checked against,
 * and who built the distribution — which decides the remedy synth names.
 *
 * @internal
 */
export interface DirectRouteBehaviorQuota {
	/** The quota, the default behavior included. Default: {@link DEFAULT_CACHE_BEHAVIOR_LIMIT}. */
	readonly limit?: number;
	/**
	 * `hosting`: Hosting's distribution, whose `frontDoor.features.quotas.cacheBehaviors`
	 * sets `limit`. `managed`: the backend's managed distribution, which has no
	 * setting for it and uses CloudFront's default.
	 */
	readonly source: 'hosting' | 'managed';
}

/**
 * Viewer-request function on every direct behavior: stamp the host the viewer
 * used (the distribution's or the app's custom domain) as the forwarded host, and
 * drop any forwarded stage — CloudFront serves the API from the origin root. Both
 * overwrite whatever the client sent, which is what lets the container trust
 * them (see `serveHttp`'s `trustForwardedHeaders`). It also drops the client's
 * `X-Forwarded-Host`: the container takes a loopback value of it ahead of the
 * stamped host (the local-dev path), and nothing between the edge and the
 * container sets one. The viewer host is read here,
 * at the edge: the `Host` CloudFront forwards to a VPC origin carries the origin
 * port (`<domain>:10000`).
 */
const FORWARDED_HOST_FUNCTION = `function handler(event) {
  var request = event.request;
  request.headers['${FORWARDED_HOST_HEADER}'] = { value: request.headers.host.value };
  delete request.headers['${FORWARDED_STAGE_HEADER}'];
  delete request.headers['x-forwarded-host'];
  return request;
}`;

/** Construct id, under the load balancer, of the prefix-list lookup that admits CloudFront. */
const PREFIX_LIST_LOOKUP_ID = 'CloudFrontOriginFacingPrefixList';

/** The namespace name of a direct route (`/aws-blocks/api/{name}` → `name`). */
function namespaceOf(route: ApiDirectRoute): string {
	return route.path.slice(BLOCKS_RPC_PREFIX.length + 1);
}

/**
 * The direct routes a CloudFront front door can take: those whose load balancer
 * is in a VPC with public subnets. A CloudFront VPC origin needs the VPC to have
 * an internet gateway, and public subnets are how CDK models one — for a VPC the
 * stack owns and a looked-up one alike. The other routes stay on the gateway,
 * which reaches them through its VPC link on every tier, and synth warns
 * (on `scope`) naming them.
 *
 * @internal
 */
export function cloudFrontReachableRoutes(
	scope: Construct,
	routes: readonly ApiDirectRoute[],
): readonly ApiDirectRoute[] {
	const reachable = routes.filter((route) => route.ingress.vpc.publicSubnets.length > 0);
	if (reachable.length < routes.length) {
		const kept = routes.filter((route) => !reachable.includes(route)).map((route) => `'${namespaceOf(route)}'`);
		cdk.Annotations.of(scope).addWarningV2(
			DIRECT_ROUTES_WITHOUT_PUBLIC_SUBNETS_WARNING,
			`CloudFront reaches the container API namespaces ${kept.join(', ')} through the API gateway, not ` +
				"directly: their load balancer's VPC has no public subnets, and a CloudFront VPC origin needs the VPC " +
				"to have an internet gateway. Their calls keep the gateway's ~29-second limit. Give the VPC public " +
				'subnets (an internet gateway) to route them straight to the load balancer. For an imported VPC ' +
				"(`Vpc.fromVpcAttributes`), list its `publicSubnetIds`: this check reads the VPC's public subnets.",
		);
	}
	return reachable;
}

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
 * A direct call skips the gateway's stage throttling and access logs, so the
 * distribution's web ACL is its only rate control: synth warns when it has none.
 *
 * Each route is a cache behavior of its own, added after the distribution was
 * built, so a construction-time behavior count doesn't see it: synth fails when
 * the distribution's behaviors, the default included, exceed `quota.limit`,
 * naming the container namespaces and a remedy that fits `quota.source`.
 *
 * @param behaviorOptions the options of the distribution's other API behaviors
 *   (caching off, all methods, viewer headers forwarded except `Host`)
 * @param quota the distribution's cache-behavior quota, the default behavior
 *   included (Hosting's `quotas.cacheBehaviors` where Hosting builds it), and
 *   which front door built the distribution
 * @internal
 */
export function addDirectApiBehaviors(
	distribution: cloudfront.Distribution,
	routes: readonly ApiDirectRoute[],
	behaviorOptions: cloudfront.AddBehaviorOptions,
	quota: DirectRouteBehaviorQuota,
): void {
	if (routes.length === 0) return;
	validateCacheBehaviorCount(distribution, routes, quota);
	if (!hasWebAcl(distribution)) {
		cdk.Annotations.of(distribution).addWarningV2(
			DIRECT_ROUTES_WITHOUT_WAF_WARNING,
			'CloudFront routes container API namespaces straight to their load balancer, past the API gateway, so its ' +
				'throttling and access logs do not apply to them, and this distribution has no web ACL to rate-limit ' +
				"them. Turn on a WAF: `apiWaf` for the backend's managed distribution, `frontDoor: { features: { waf: " +
				'{ enabled: true } } }` on Hosting.',
		);
	}
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
 * Fail synth when `distribution` ends up with more cache behaviors than
 * `quota.limit`. Counted once, from the rendered distribution, after every
 * behavior (construction-time or added later) is in.
 */
function validateCacheBehaviorCount(
	distribution: cloudfront.Distribution,
	routes: readonly ApiDirectRoute[],
	quota: DirectRouteBehaviorQuota,
): void {
	const limit = quota.limit ?? DEFAULT_CACHE_BEHAVIOR_LIMIT;
	distribution.node.addValidation({
		validate: (): string[] => {
			const cfn = distribution.node.defaultChild as cloudfront.CfnDistribution;
			const config = cfn.distributionConfig as cloudfront.CfnDistribution.DistributionConfigProperty;
			// Only the behavior list: the rest of the config needn't resolve here.
			const behaviors: unknown = cdk.Stack.of(distribution).resolve(config.cacheBehaviors);
			const additional = Array.isArray(behaviors) ? behaviors.length : 0;
			const total = 1 + additional;
			if (total <= limit) return [];
			const namespaces = routes.map((route) => `'${namespaceOf(route)}'`).join(', ');
			const remedy =
				quota.source === 'hosting'
					? 'Move some of those namespaces onto a Lambda compute (the gateway serves them), or, if AWS raised ' +
						'your account\'s "Cache behaviors per distribution" quota, set Hosting\'s ' +
						'`frontDoor.features.quotas.cacheBehaviors` to it.'
					: "The backend's managed distribution is checked against CloudFront's default quota and has no " +
						'setting to raise it. Move some of those namespaces onto a Lambda compute (the gateway serves them), ' +
						'or request a higher "Cache behaviors per distribution" quota and serve the API through Hosting, ' +
						'with `frontDoor.features.quotas.cacheBehaviors` set to it.';
			return [
				`This CloudFront distribution needs ${total} cache behaviors (the default and ${additional} more, ` +
					`${routes.length} of them for the container API namespaces ${namespaces}), exceeding the limit of ` +
					`${limit} per distribution. ${remedy}`,
			];
		},
	});
}

/** Whether `distribution` has a web ACL — set at construction, as the managed distribution and Hosting do. */
function hasWebAcl(distribution: cloudfront.Distribution): boolean {
	const cfn = distribution.node.defaultChild as cloudfront.CfnDistribution;
	const config = cfn.distributionConfig as cloudfront.CfnDistribution.DistributionConfigProperty;
	return cdk.Stack.of(distribution).resolve(config.webAclId) !== undefined;
}

/**
 * Admit CloudFront's VPC origins to a load balancer's listener ports, once per
 * load balancer: one rule over the whole listener range, sourced from CloudFront's
 * origin-facing prefix list (VPC origin traffic keeps CloudFront's source
 * addresses). The prefix list's id differs per region, so it is looked up at
 * deploy time and the stack stays environment-agnostic.
 *
 * The gateway build calls it for every direct route, so the lookup's provider
 * role (a stack-level singleton) is created during the backend's `create()` and
 * gets the backend's role settings (its permissions boundary) like the rest;
 * {@link addDirectApiBehaviors} calling it again is a no-op.
 *
 * @internal
 */
export function admitCloudFront(loadBalancer: elbv2.IApplicationLoadBalancer): void {
	// The lookup is the load balancer's child, so its presence marks the rule as added.
	if (loadBalancer.node.tryFindChild(PREFIX_LIST_LOOKUP_ID)) return;
	const lookup = new cr.AwsCustomResource(loadBalancer, PREFIX_LIST_LOOKUP_ID, {
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
