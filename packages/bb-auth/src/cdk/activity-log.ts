// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AuthOptions.activityLog` → Cognito's own user-activity log, exported to a
 * log group this stack owns.
 *
 * Cognito writes these logs (`userAuthEvents`, `INFO`) only for a pool on the
 * Plus feature plan with threat protection active, so the option sets
 * threat protection to audit-only (it scores sign-ins but never blocks or
 * challenges one) and adds an `AWS::Cognito::LogDeliveryConfiguration`.
 * {@link assertActivityLog} refuses, at synth, a configuration where Cognito
 * would write nothing; {@link provisionActivityLog} adds the log group and the
 * delivery.
 *
 * Neither `UserPoolAddOns` nor the delivery is a service-immutable pool
 * property (CloudFormation: "Update requires: No interruption"), so turning
 * the option on or off later updates the pool in place
 * (`activity-log.cdk.test.ts`).
 *
 * @internal
 */

import type * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { ResolvedAuthOptions } from '../resolve-options.js';

/** Construct ids under the block. */
export const ACTIVITY_LOG_IDS = { logGroup: 'activity-log', delivery: 'activity-log-delivery' } as const;

/**
 * The log group's name. CloudWatch Logs authorizes delivery to a group under
 * `/aws/vendedlogs/` without adding it to the account's log resource policy,
 * which is capped at 5120 characters, so many pools in one account still fit.
 * A character a log-group name can't hold becomes `-`.
 */
export function activityLogGroupName(fullId: string): string {
	return `/aws/vendedlogs/cognito/${fullId.replace(/[^A-Za-z0-9._#/-]/g, '-')}/user-activity`;
}

/**
 * Refuse, at synth, an `activityLog` that would export nothing: without the
 * Plus plan, or on a pool this block doesn't create. (A `store: 'builtin'`
 * block, the only one with no pool, refuses the option before synth.)
 */
export function assertActivityLog(fullId: string, options: ResolvedAuthOptions): void {
	if (options.activityLog !== true) return;
	const fail = (reason: string): never => {
		throw new Error(`Auth '${fullId}': ${reason}`);
	};
	if (options.userPool) {
		fail(
			'`activityLog` turns on threat protection and log export for a user pool this block creates, but `userPool` ' +
				'wraps an existing pool (`Auth.fromExisting`), whose settings belong to its owner. Configure log export on ' +
				'that pool directly, or remove `activityLog`.',
		);
	}
	if (options.featurePlan !== 'plus') {
		const got = options.featurePlan === undefined ? "the default 'essentials'" : `'${options.featurePlan}'`;
		fail(
			`\`activityLog\` needs \`featurePlan: 'plus'\` (got ${got}): Cognito writes user-activity logs only on the ` +
				'Plus plan, with threat protection on. Plus is billed per monthly active user; see ' +
				'https://aws.amazon.com/cognito/pricing/.',
		);
	}
}

/** The pool's threat-protection mode: audit-only with `activityLog`, else unset (no `UserPoolAddOns`). */
export function mapThreatProtection(options: ResolvedAuthOptions): cognito.StandardThreatProtectionMode | undefined {
	return options.activityLog === true ? cognito.StandardThreatProtectionMode.AUDIT_ONLY : undefined;
}

/**
 * Add the log group and the delivery of the pool's `userAuthEvents` to it.
 * Retention follows the stack's `logRetention`, like the block's other log
 * groups, and removal follows the pool's resolved removal policy.
 */
export function provisionActivityLog(
	scope: Construct,
	pool: cognito.UserPool,
	fullId: string,
	settings: { retention: logs.RetentionDays; removalPolicy: cdk.RemovalPolicy },
): logs.LogGroup {
	const logGroup = new logs.LogGroup(scope, ACTIVITY_LOG_IDS.logGroup, {
		logGroupName: activityLogGroupName(fullId),
		retention: settings.retention,
		// Explicit, not CDK's RETAIN default: a retained group keeps its fixed name,
		// so the next deploy of a destroyed sandbox would fail to create it.
		removalPolicy: settings.removalPolicy,
	});
	new cognito.CfnLogDeliveryConfiguration(scope, ACTIVITY_LOG_IDS.delivery, {
		userPoolId: pool.userPoolId,
		logConfigurations: [
			{
				eventSource: 'userAuthEvents',
				logLevel: 'INFO',
				cloudWatchLogsConfiguration: { logGroupArn: logGroup.logGroupArn },
			},
		],
	});
	return logGroup;
}
