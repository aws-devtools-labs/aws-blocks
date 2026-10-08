// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-tenant proof on BUILD HOOKS (approach two) — one shared door, three
 * independent tenant apps, per door.
 *
 * Unlike #620's POC (one construct owning every tenant's assets), each tenant
 * here is its own `Hosting` app — its own private bucket, build, and backend API
 * — and opts into the shared door with ONE line:
 *
 *   frontDoor: { kind: 'custom', door: shared.forTenant('tenant-a') }
 *
 * The platform team creates the shared door once (`SharedCloudFrontDoor` /
 * `SharedApiGatewayDoor` / `SharedAlbDoor`). The framework then drives each
 * tenant's hooks: create (claim the tenant id) → route (register the tenant's
 * bucket + build prefix) → sameOriginApi (register the tenant's API) → handle
 * (the tenant URL).
 *
 * Each tenant's backend is a tiny echo API that reports which tenant it is and
 * the `x-tenant-id` header the shared door stamped — so the proof can show the
 * call reached the RIGHT backend with the RIGHT tenant context.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hosting } from '@aws-blocks/core/cdk';
import {
	SharedAlbDoor,
	SharedApiGatewayDoor,
	SharedCloudFrontDoor,
} from '@aws-blocks/hosting/constructs';
import { App, CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'] as const;

const app = new App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2' };

/** A tenant's own backend: an echo API that names its tenant and the x-tenant-id it received. */
const echoApi = (stack: Stack, tenant: string): HttpApi => {
	const fn = new LambdaFunction(stack, `${tenant}-Echo`, {
		runtime: Runtime.NODEJS_22_X,
		handler: 'index.handler',
		environment: { TENANT: tenant },
		code: Code.fromInline(`exports.handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ backendOf: process.env.TENANT, receivedXTenantId: (event.headers || {})['x-tenant-id'] || null, path: event.rawPath }),
});`),
	});
	return new HttpApi(stack, `${tenant}-Api`, { defaultIntegration: new HttpLambdaIntegration(`${tenant}-Int`, fn) });
};

/** Three independent tenant apps on one shared door. */
const addTenants = (stack: Stack, shared: SharedCloudFrontDoor | SharedApiGatewayDoor | SharedAlbDoor) => {
	for (const tenant of TENANTS) {
		const api = echoApi(stack, tenant);
		const site = new Hosting(stack, `${tenant}-App`, {
			root: join(__dirname, 'tenants', tenant),
			framework: 'spa',
			buildOutputDir: 'dist',
			api: { apiUrl: `${api.apiEndpoint}/aws-blocks` },
			// The whole multi-tenant opt-in: one line per app.
			frontDoor: { kind: 'custom', door: shared.forTenant(tenant) },
		});
		new CfnOutput(stack, `${tenant}-Url`, { value: site.url });
	}
	Tags.of(stack).add('blocks:purpose', 'mt-hooks-poc');
};

// CloudFront — path routing (/<tenant>/…).
const cf = new Stack(app, 'mt-hooks-cf', { env });
const cfDoor = new SharedCloudFrontDoor(cf, 'SharedDoor', { routing: 'path' });
addTenants(cf, cfDoor);
new CfnOutput(cf, 'DistributionDomain', { value: cfDoor.distribution.distributionDomainName });
new CfnOutput(cf, 'DistributionId', { value: cfDoor.distribution.distributionId });
new CfnOutput(cf, 'RouterFunctionName', { value: cfDoor.router.functionName });

// CloudFront — subdomain routing (<tenant>.app.example.com). Real DNS + a
// wildcard cert are out of scope (no delegated domain in the sandbox); the
// routing is verified with `aws cloudfront test-function` against this router.
const cfSub = new Stack(app, 'mt-hooks-cf-sub', { env });
const cfSubDoor = new SharedCloudFrontDoor(cfSub, 'SharedDoor', { routing: 'subdomain', domain: 'app.example.com' });
addTenants(cfSub, cfSubDoor);
new CfnOutput(cfSub, 'DistributionDomain', { value: cfSubDoor.distribution.distributionDomainName });
new CfnOutput(cfSub, 'RouterFunctionName', { value: cfSubDoor.router.functionName });

// API Gateway HTTP API — path routing.
const apigw = new Stack(app, 'mt-hooks-apigw', { env });
const apigwDoor = new SharedApiGatewayDoor(apigw, 'SharedDoor', { routing: 'path' });
addTenants(apigw, apigwDoor);
new CfnOutput(apigw, 'ApiEndpoint', { value: apigwDoor.api.apiEndpoint });

// ALB — subdomain routing (Host header). The sandbox account's VPC quota is
// exhausted, so the ALB reuses the account's default VPC.
const alb = new Stack(app, 'mt-hooks-alb', { env });
const vpc = ec2.Vpc.fromLookup(alb, 'DefaultVpc', { isDefault: true });
const albDoor = new SharedAlbDoor(alb, 'SharedDoor', { routing: 'subdomain', domain: 'app.example.com', vpc });
addTenants(alb, albDoor);
new CfnOutput(alb, 'AlbDns', { value: albDoor.loadBalancer.loadBalancerDnsName });
