// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as cdk from 'aws-cdk-lib';
import { CfnAccount } from 'aws-cdk-lib/aws-apigateway';
import { ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';

/**
 * Global registry key for the per-stack API Gateway CloudWatch Logs account
 * resource. Deliberately a `Symbol.for(...)` string key so the SAME symbol is
 * shared across packages (core, hosting) — each package can carry its own copy
 * of {@link ensureApiGatewayAccount} yet still find and reuse the one account a
 * sibling package already created on the stack, instead of emitting a second
 * `AWS::ApiGateway::Account` (which is account/region-level and would clash).
 */
const ACCOUNT_KEY = Symbol.for('BLOCKS_APIGATEWAY_ACCOUNT');

/**
 * Ensure the account-level API Gateway CloudWatch Logs role exists on `stack`,
 * creating it at most once per stack.
 *
 * API Gateway access logging — for both REST (v1) and WebSocket (v2) stages —
 * requires an `AWS::ApiGateway::Account` whose `cloudWatchRoleArn` points at a
 * role trusted by `apigateway.amazonaws.com` and carrying
 * `AmazonAPIGatewayPushToCloudWatchLogs`. Nothing else in a Blocks stack
 * provisions it, so a clean-account first deploy of any access-logging stage
 * otherwise fails at CreateStage with "CloudWatch Logs role ARN must be set in
 * account settings to enable logging".
 *
 * Callers should add their stage's dependency on the returned account so the
 * account setting is applied before the stage is created.
 *
 * ⚠️ Single-Blocks-stack-per-region assumption. `AWS::ApiGateway::Account` is an
 * account/region-level singleton (one effective `cloudWatchRoleArn` per region),
 * but this provisions one per Blocks stack. If two Blocks stacks in the same
 * account+region both enable access logging:
 *   - on deploy, the later stack's role wins (overwrites the account setting); and
 *   - on teardown of that later stack, its role is deleted and the account
 *     setting is left pointing at a now-deleted role — silently breaking access
 *     logging (or blocking `CreateStage`) for the surviving stack until it
 *     redeploys.
 * Enabling `accessLogging` is therefore safe for one Blocks stack per region.
 * Multi-stack support (a shared/imported account) is deferred; if you run
 * multiple Blocks stacks per region, manage the account role out-of-band and
 * leave `accessLogging` to a single owner.
 */
export function ensureApiGatewayAccount(stack: cdk.Stack): CfnAccount {
	const existing = (stack as unknown as Record<symbol, CfnAccount | undefined>)[ACCOUNT_KEY];
	if (existing) return existing;

	const role = new Role(stack, 'BlocksApiGatewayCloudWatchRole', {
		assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
		managedPolicies: [
			ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonAPIGatewayPushToCloudWatchLogs'),
		],
	});

	const account = new CfnAccount(stack, 'BlocksApiGatewayAccount', {
		cloudWatchRoleArn: role.roleArn,
	});
	account.node.addDependency(role);

	(stack as unknown as Record<symbol, CfnAccount | undefined>)[ACCOUNT_KEY] = account;
	return account;
}
