// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import { FORWARDED_HOST_HEADER, FORWARDED_STAGE_HEADER } from '../constants.js';
import type { ComputeApiIngress } from './compute/compute.js';
import { getOrCreateOnRoot } from './root-registry.js';

/** A compute reached through an internal load balancer. @internal */
export type LoadBalancerIngress = Extract<ComputeApiIngress, { kind: 'load-balancer' }>;

/**
 * The ports a load-balanced compute's listeners use. The API namespaces of every
 * load-balanced compute share one listener on the range's first port; the rest
 * is reserved for listeners a single compute owns. A contiguous range lets one
 * security group rule per source cover every listener on the load balancer — a
 * rule per port would exhaust the group's rule quota (a managed prefix list
 * source alone weighs ~55 rules).
 *
 * @internal
 */
export const API_LISTENER_PORTS = { min: 10_000, max: 10_999 } as const;

interface ApiVpcLink {
	readonly vpcLink: apigateway.IVpcLink;
	readonly securityGroup: ec2.ISecurityGroup;
}

/**
 * The VPC link (v2) the shared REST API reaches load-balanced computes through —
 * one per backend, in the load balancers' VPC, with a security group of its own
 * that only the load balancer listeners it reaches admit.
 */
function apiVpcLink(scope: Construct, ingress: LoadBalancerIngress): ApiVpcLink {
	return getOrCreateOnRoot(scope, Symbol.for('BLOCKS_API_VPC_LINK'), (root) => {
		const securityGroup = new ec2.SecurityGroup(root, 'ApiVpcLinkSg', {
			vpc: ingress.vpc,
			description: 'Blocks API gateway VPC link to container computes',
			allowAllOutbound: false,
		});
		const link = new apigwv2.CfnVpcLink(root, 'ApiVpcLink', {
			name: `${cdk.Names.uniqueResourceName(root, { maxLength: 110 })}-api-link`,
			subnetIds: ingress.vpc.selectSubnets(ingress.subnets).subnetIds,
			securityGroupIds: [securityGroup.securityGroupId],
		});
		return { vpcLink: apigateway.VpcLink.fromVpcLinkId(root, 'ApiVpcLinkRef', link.ref), securityGroup };
	});
}

/**
 * Add an `ANY` method on `resource` that proxies to a load-balanced compute's
 * HTTP server at `path`, through the backend's VPC link, cut off after `timeout`
 * (the shared gateway's integration timeout).
 *
 * The request reaches the container with the load balancer's host and no stage,
 * so the integration stamps the gateway's public host and stage on it
 * ({@link FORWARDED_HOST_HEADER} / {@link FORWARDED_STAGE_HEADER}, overwriting
 * any client-sent value); the container builds `ctx.request.url` from them,
 * exactly as the Lambda handler does from its API Gateway event.
 *
 * @internal
 */
export function addLoadBalancerMethod(
	resource: apigateway.IResource,
	ingress: LoadBalancerIngress,
	path: string,
	timeout: cdk.Duration,
): apigateway.Method {
	const { vpcLink, securityGroup } = apiVpcLink(resource, ingress);
	ingress.loadBalancer.connections.allowFrom(
		securityGroup,
		ec2.Port.tcpRange(API_LISTENER_PORTS.min, API_LISTENER_PORTS.max),
		'Blocks API gateway VPC link',
	);
	const integration = new apigateway.Integration({
		type: apigateway.IntegrationType.HTTP_PROXY,
		integrationHttpMethod: 'ANY',
		uri: `http://${ingress.loadBalancer.loadBalancerDnsName}:${ingress.port}${path}`,
		options: {
			connectionType: apigateway.ConnectionType.VPC_LINK,
			vpcLink,
			timeout,
			requestParameters: {
				[`integration.request.header.${FORWARDED_HOST_HEADER}`]: 'context.domainName',
				[`integration.request.header.${FORWARDED_STAGE_HEADER}`]: 'context.stage',
			},
		},
	});
	const method = resource.addMethod('ANY', integration);
	ingress.routePath(path);
	// A VPC link v2 integration names its load balancer in `IntegrationTarget`,
	// which the L2 has no property for. API Gateway wants the load balancer's ARN
	// (a listener ARN is rejected); the URI's port selects the listener.
	(method.node.defaultChild as apigateway.CfnMethod).addPropertyOverride(
		'Integration.IntegrationTarget',
		ingress.loadBalancer.loadBalancerArn,
	);
	return method;
}
