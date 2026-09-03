// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Scope } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import type {
	CronJobEvent,
	CronJobOptions,
} from './types.js';
import { validateSchedule, validateTimezone } from './schedule.js';
import { CronJobErrors } from './errors.js';

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

export class CronJob<T = void> extends Scope {
	public readonly schedule: scheduler.CfnSchedule;

	constructor(scope: ScopeParent, id: string, options: CronJobOptions<T>) {
		super(id, { parent: scope });

		// Fail fast at synth: an invalid schedule/timezone otherwise passes synth
		// and is only rejected by EventBridge minutes into the deploy. Mirrors the
		// validation the mock already runs, so local dev and deploy agree.
		validateSchedule(options.schedule);
		if (options.timezone !== undefined) validateTimezone(options.timezone);

		// The scheduler invokes the compute's function directly, so a CronJob
		// currently requires a Lambda compute. Other compute types need a
		// different scheduler target (e.g. EventBridge → ECS) — not yet supported.
		const compute = this.compute;
		if (!(compute instanceof LambdaCompute)) {
			// Match the inline typed-error pattern used by schedule.ts (new Error +
			// err.name) so this is assertable via isBlocksError.
			const err = new Error(
				`${CronJobErrors.UnsupportedCompute}: CronJob "${this.fullId}" currently supports only a Lambda compute.`,
			);
			err.name = CronJobErrors.UnsupportedCompute;
			throw err;
		}
		const lambdaArn = compute.fn.functionArn;
		const schedulerRole = getOrCreateSchedulerRole(cdk.Stack.of(this), lambdaArn);

		// The payload EventBridge sends to the Lambda.
		// <aws.scheduler.scheduled-time> is resolved by EventBridge at invocation time.
		const targetInput = JSON.stringify({
			source: 'blocks.cronjob',
			jobName: this.fullId,
			scheduledTime: '<aws.scheduler.scheduled-time>',
			input: options.input,
		});

		this.schedule = new scheduler.CfnSchedule(this, 'Schedule', {
			name: `${this.fullId}`.substring(0, 64),
			scheduleExpression: options.schedule,
			scheduleExpressionTimezone: options.timezone ?? 'UTC',
			state: options.enabled === false ? 'DISABLED' : 'ENABLED',
			description: options.description,
			flexibleTimeWindow: { mode: 'OFF' },
			target: {
				arn: lambdaArn,
				roleArn: schedulerRole.roleArn,
				input: targetInput,
			},
		});
	}
}

// ── Shared Scheduler Role (one per stack) ───────────────────────────────────

const SCHEDULER_ROLE_KEY = Symbol.for('BLOCKS_SCHEDULER_ROLE');

function getOrCreateSchedulerRole(stack: cdk.Stack, handlerArn: string): iam.Role {
	const existing = (stack as any)[SCHEDULER_ROLE_KEY] as iam.Role | undefined;
	if (existing) return existing;

	const role = new iam.Role(stack, 'BlocksSchedulerRole', {
		assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
	});
	role.addToPolicy(new iam.PolicyStatement({
		actions: ['lambda:InvokeFunction'],
		resources: [handlerArn],
	}));

	(stack as any)[SCHEDULER_ROLE_KEY] = role;
	return role;
}
