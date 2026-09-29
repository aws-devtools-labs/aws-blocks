// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-tenant API Gateway POC — one HTTP API, three tenants.
 *
 * A single `MultiTenantApiGateway` composes three trivial static tenant sites
 * (`tenant-a|b|c`) behind ONE Amazon API Gateway (HTTP API v2), routed by the
 * first path segment (`/tenant-a/…`). The API-Gateway sibling of the CloudFront
 * POC: one API (`$default` → one router Lambda) + a tenant route table, not one
 * door per tenant.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import { MultiTenantApiGateway } from '@aws-blocks/hosting/constructs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tenantsDir = join(__dirname, 'tenants');

const app = new App();
const stack = new Stack(app, 'mt-apigw-poc', {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
	},
});

const door = new MultiTenantApiGateway(stack, 'MultiTenant', {
	routing: 'path',
	tenants: [
		{ tenantId: 'tenant-a', assetDir: join(tenantsDir, 'tenant-a') },
		{ tenantId: 'tenant-b', assetDir: join(tenantsDir, 'tenant-b') },
		{ tenantId: 'tenant-c', assetDir: join(tenantsDir, 'tenant-c') },
	],
});

new CfnOutput(stack, 'ApiUrl', { value: door.url });
new CfnOutput(stack, 'TenantAUrl', { value: `${door.url}/tenant-a/` });
new CfnOutput(stack, 'TenantBUrl', { value: `${door.url}/tenant-b/` });
new CfnOutput(stack, 'TenantCUrl', { value: `${door.url}/tenant-c/` });

Tags.of(stack).add('blocks:purpose', 'mt-apigw-poc');
