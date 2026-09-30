// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-tenant CloudFront POC — one distribution, three tenants.
 *
 * A single `MultiTenantCloudFront` composes three trivial static tenant sites
 * (`tenant-a|b|c`) behind ONE CloudFront distribution, routed by the first path
 * segment (`/tenant-a/…`). Proves the shared multi-tenant front-door mechanism:
 * one distribution + a KeyValueStore tenant route table, not one door per tenant.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, CfnOutput, Stack, Tags } from 'aws-cdk-lib';
import { MultiTenantCloudFront } from '@aws-blocks/hosting/constructs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tenantsDir = join(__dirname, 'tenants');

const app = new App();
const stack = new Stack(app, 'mt-cf-poc', {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
	},
});

const door = new MultiTenantCloudFront(stack, 'MultiTenant', {
	tenants: [
		{ tenantId: 'tenant-a', assetDir: join(tenantsDir, 'tenant-a') },
		{ tenantId: 'tenant-b', assetDir: join(tenantsDir, 'tenant-b') },
		{ tenantId: 'tenant-c', assetDir: join(tenantsDir, 'tenant-c') },
	],
});

new CfnOutput(stack, 'DistributionDomain', { value: door.domainName });
new CfnOutput(stack, 'TenantAUrl', { value: `https://${door.domainName}/tenant-a/` });
new CfnOutput(stack, 'TenantBUrl', { value: `https://${door.domainName}/tenant-b/` });
new CfnOutput(stack, 'TenantCUrl', { value: `https://${door.domainName}/tenant-c/` });

Tags.of(stack).add('blocks:purpose', 'mt-cloudfront-poc');

// Subdomain-mode variant — same three tenants, ONE distribution, but the tenant
// is taken from the Host header's first DNS label (`tenant-a.<host>`) instead of
// the path. Real per-tenant DNS + wildcard TLS is out of scope for the POC; the
// Host-based routing logic is verified by sending the Host header.
const subStack = new Stack(app, 'mt-cf-subdomain', {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
	},
});

const subDoor = new MultiTenantCloudFront(subStack, 'MultiTenant', {
	routing: 'subdomain',
	tenants: [
		{ tenantId: 'tenant-a', assetDir: join(tenantsDir, 'tenant-a') },
		{ tenantId: 'tenant-b', assetDir: join(tenantsDir, 'tenant-b') },
		{ tenantId: 'tenant-c', assetDir: join(tenantsDir, 'tenant-c') },
	],
});

new CfnOutput(subStack, 'DistributionDomain', { value: subDoor.domainName });
Tags.of(subStack).add('blocks:purpose', 'mt-cloudfront-poc');
