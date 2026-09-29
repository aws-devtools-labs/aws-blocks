// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Multi-tenant ALB POC — one Application Load Balancer fronting three tenants.
 *
 * Builds ONE stack with ONE `MultiTenantAlb` composing three tenant static
 * sites (tenant-a/b/c). The shared ALB routes `/<tenantId>/…` to each tenant's
 * assets under `t/<tenantId>/` in one bucket via a single router Lambda — no new
 * ALB, listener, or rule per tenant. Sibling to the CloudFront POC (#620) and
 * the API Gateway POC (#641).
 */
import { join } from 'node:path';
import { App, Stack, Tags } from 'aws-cdk-lib';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { MultiTenantAlb } from '@aws-blocks/hosting/constructs';

const app = new App();
const stackName = process.env.MT_ALB_STACK || 'mt-alb-poc';
const stack = new Stack(app, stackName, {
	env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

// Reuse the account's default VPC rather than create a new one — the sandbox is
// at its VPC quota, and the POC only needs public subnets for the ALB.
const vpc = Vpc.fromLookup(stack, 'DefaultVpc', { isDefault: true });

const tenantsDir = join(import.meta.dirname, 'tenants');
new MultiTenantAlb(stack, 'Door', {
	routing: 'path',
	vpc,
	tenants: [
		{ tenantId: 'tenant-a', assetDir: join(tenantsDir, 'tenant-a') },
		{ tenantId: 'tenant-b', assetDir: join(tenantsDir, 'tenant-b') },
		{ tenantId: 'tenant-c', assetDir: join(tenantsDir, 'tenant-c') },
	],
});

Tags.of(stack).add('blocks:purpose', 'mt-alb-poc');
