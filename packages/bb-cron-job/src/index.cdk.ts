// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncJob } from '@aws-blocks/bb-async-job';
import { ContainerCompute } from '@aws-blocks/bb-container-compute/cdk';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import { blocksError, getOrCreateOnRoot, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { CronJobErrors } from './errors.js';
import { CRON_RUNNER_ID, toCronJobEvent } from './runner.js';
import { validateSchedule, validateTimezone } from './schedule.js';
import type { CronJobEvent, CronJobOptions } from './types.js';
import { BB_NAME } from './version.js';

export { CronJobErrors } from './errors.js';
export type { CronJobEvent, CronJobOptions } from './types.js';

export class CronJob<T = void> extends Scope {
	public readonly schedule: scheduler.CfnSchedule;

	constructor(scope: ScopeParent, id: string, options: CronJobOptions<T>) {
		super(id, { parent: scope, bbName: BB_NAME });

		// Fail fast at synth: an invalid schedule/timezone otherwise passes synth
		// and is only rejected by EventBridge minutes into the deploy. Mirrors the
		// validation the mock already runs, so local dev and deploy agree.
		validateSchedule(options.schedule);
		if (options.timezone !== undefined) validateTimezone(options.timezone);

		// Assign the requested compute (if any) before anything reads
		// `this.compute`. `resolve()` returns the concrete compute the framework
		// wires against (a backing resolves to itself; the `Compute` block resolves
		// to the backing it owns). The internal runner job below inherits it
		// through the scope chain.
		if (options.compute) {
			this._compute = options.compute.resolve();
		}

		// On a Lambda compute the scheduler invokes the function directly. On a
		// container compute it sends each tick to an internal AsyncJob's queue,
		// which the container drains like any container AsyncJob. Any other
		// compute type has no delivery path. The brand checks (not `instanceof`)
		// survive duplicate compute-package copies in one dependency tree.
		const compute = this.compute;
		const onLambda = LambdaCompute.isLambdaCompute(compute);
		const onContainer = ContainerCompute.isContainerCompute(compute);
		if (!onLambda && !onContainer) {
			throw blocksError(
				CronJobErrors.UnsupportedCompute,
				`CronJob "${this.fullId}" supports only a Lambda or container compute.`,
			);
		}

		const schedulerRole = getOrCreateSchedulerRole(this);
		let targetArn: string;
		let targetInput: string;

		if (onLambda) {
			// Claim the key the Lambda runtime registers this job's handler under, so
			// two jobs with the same `fullId` fail synth instead of on cold start.
			this.registerLambdaEventHandler('blocks.cronjob', this.fullId);
			targetArn = compute.fn.functionArn;
			// One statement per target function. Identical statements (several jobs
			// on one compute) are merged when the policy renders.
			schedulerRole.addToPrincipalPolicy(
				new iam.PolicyStatement({
					actions: ['lambda:InvokeFunction'],
					resources: [targetArn],
				}),
			);
			// The payload EventBridge sends to the Lambda.
			// <aws.scheduler.scheduled-time> is resolved by EventBridge at invocation time.
			targetInput = JSON.stringify({
				source: 'blocks.cronjob',
				jobName: this.fullId,
				scheduledTime: '<aws.scheduler.scheduled-time>',
				input: options.input,
			});
		} else {
			// The runner is a plain AsyncJob on this job's compute (inherited from
			// `_compute` above). It owns the queue, DLQ, owner-matched container
			// poller, enforced timeout, and queue-depth autoscaling registration.
			// The runtime entry constructs the same child, so its handler resolves.
			new AsyncJob<CronJobEvent<T>>(this, CRON_RUNNER_ID, {
				handler: async (event) => options.handler(toCronJobEvent(event)),
				timeoutSeconds: options.timeoutSeconds,
				logger: options.logger,
			});
			// The AsyncJob's queue is its `queue` child. Found by id (the composed
			// AsyncJob is typed by its default entry, which has no CDK members);
			// `instanceof` narrows it without a cast and fails loud if the child
			// ever moves.
			const queue = this.node.findChild(CRON_RUNNER_ID).node.tryFindChild('queue');
			if (!(queue instanceof Queue)) {
				throw new Error(`CronJob "${this.fullId}": internal AsyncJob runner has no queue.`);
			}
			targetArn = queue.queueArn;
			queue.grantSendMessages(schedulerRole);
			// The message body the runner's handler receives. Same fields the Lambda
			// path sends, minus the Lambda event-routing `source`.
			targetInput = JSON.stringify({
				jobName: this.fullId,
				scheduledTime: '<aws.scheduler.scheduled-time>',
				input: options.input,
			});
		}

		this.schedule = new scheduler.CfnSchedule(this, 'Schedule', {
			name: `${this.fullId}`.substring(0, 64),
			scheduleExpression: options.schedule,
			scheduleExpressionTimezone: options.timezone ?? 'UTC',
			state: options.enabled === false ? 'DISABLED' : 'ENABLED',
			description: options.description,
			flexibleTimeWindow: { mode: 'OFF' },
			target: {
				arn: targetArn,
				roleArn: schedulerRole.roleArn,
				input: targetInput,
			},
		});
	}
}

// ── Shared Scheduler Role (one per backend root) ─────────────────────────────

const SCHEDULER_ROLE_KEY = Symbol.for('BLOCKS_SCHEDULER_ROLE');

// Keyed on (and parented under) the owning backend root, so two BlocksBackends in
// one cdk.Stack each get their own scheduler role. Each CronJob grants the role
// access to its own target (a function or a queue), so jobs on different
// computes in one backend each get a working target.
function getOrCreateSchedulerRole(scope: Construct): iam.Role {
	return getOrCreateOnRoot(scope, SCHEDULER_ROLE_KEY, (root) => {
		// The trust is limited to EventBridge Scheduler schedules in this account and region.
		// Scheduler reports the schedule GROUP ARN (not the individual schedule ARN) as aws:SourceArn,
		// so the ArnLike pattern matches `schedule-group/*`. Same shape as the AgentCore Runtime trust
		// in bb-agent/src/agentcore-runtime.cdk.ts.
		const stack = cdk.Stack.of(root);
		return new iam.Role(root, 'BlocksSchedulerRole', {
			assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
				conditions: {
					StringEquals: { 'aws:SourceAccount': stack.account },
					ArnLike: {
						'aws:SourceArn': `arn:${stack.partition}:scheduler:${stack.region}:${stack.account}:schedule-group/*`,
					},
				},
			}),
		});
	});
}
