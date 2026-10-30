// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Scope, blocksError, getOrCreateOnRoot } from '@aws-blocks/core/cdk';
import { foreignComputeProblem } from '@aws-blocks/core/cdk/internal';
import type { ScopeParent } from '@aws-blocks/core';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import type { Construct } from 'constructs';
import type {
	CronJobEvent,
	CronJobOptions,
} from './types.js';
import { validateSchedule, validateTimezone } from './schedule.js';
import { CronJobErrors } from './errors.js';
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

		// Assign the requested compute (if any) before anything reads `this.compute`;
		// without one the job runs on its scope's compute (else the default).
		if (options.compute) {
			this._compute = options.compute.resolve();
		}

		// The scheduler invokes the compute's function directly, so a CronJob
		// currently requires a Lambda compute. Other compute types need a
		// different scheduler target (e.g. EventBridge → ECS) — not yet supported.
		// The brand check (not `instanceof`) survives duplicate bb-lambda-compute
		// copies in one dependency tree.
		const compute = this.compute;
		const foreign = foreignComputeProblem(this, compute);
		if (foreign) throw blocksError(CronJobErrors.UnsupportedCompute, `CronJob "${this.fullId}" ${foreign}`);
		if (!LambdaCompute.isLambdaCompute(compute)) {
			throw blocksError(
				CronJobErrors.UnsupportedCompute,
				`CronJob "${this.fullId}" runs only on a serverless compute, but resolves to ${compute.type} compute ` +
					`'${compute.node.path}' (its own \`compute\`, or its scope's).`,
			);
		}
		// Claim the key the Lambda runtime registers this job's handler under, so
		// two jobs with the same `fullId` fail synth instead of on cold start.
		this.registerLambdaEventHandler('blocks.cronjob', this.fullId);
		const lambdaArn = compute.fn.functionArn;
		const schedulerRole = getOrCreateSchedulerRole(this);
		allowSchedulerToInvoke(schedulerRole, compute.fn);

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

// ── Shared Scheduler Role (one per backend root) ─────────────────────────────

const SCHEDULER_ROLE_KEY = Symbol.for('BLOCKS_SCHEDULER_ROLE');

// Keyed on (and parented under) the owning backend root, so two BlocksBackends in
// one cdk.Stack each get their own scheduler role — the role grants invoke on that
// backend's handlers, so sharing A's role would let B's schedules invoke A's Lambdas.
function getOrCreateSchedulerRole(scope: Construct): iam.Role {
	return getOrCreateOnRoot(scope, SCHEDULER_ROLE_KEY, (root) => {
		// The trust is limited to EventBridge Scheduler schedules in this account and region.
		// Scheduler reports the schedule GROUP ARN (not the individual schedule ARN) as aws:SourceArn,
		// so the ArnLike pattern matches `schedule-group/*`. Same shape as the AgentCore Runtime trust
		// in bb-agent/src/agentcore-runtime.cdk.ts.
		const stack = cdk.Stack.of(root);
		const role = new iam.Role(root, 'BlocksSchedulerRole', {
			assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
				conditions: {
					StringEquals: { 'aws:SourceAccount': stack.account },
					ArnLike: {
						'aws:SourceArn': `arn:${stack.partition}:scheduler:${stack.region}:${stack.account}:schedule-group/*`,
					},
				},
			}),
		});
		return role;
	});
}

// The functions (by construct address) each scheduler role may already invoke,
// so a compute shared by several jobs is granted once.
const invokableBySchedulerRole = new WeakMap<iam.Role, Set<string>>();

// Grant the shared scheduler role invoke on one job's function. Jobs on different
// computes target different functions, so every target is granted — not just the
// first job's.
function allowSchedulerToInvoke(role: iam.Role, fn: { readonly node: Construct['node']; readonly functionArn: string }): void {
	let granted = invokableBySchedulerRole.get(role);
	if (!granted) {
		granted = new Set();
		invokableBySchedulerRole.set(role, granted);
	}
	if (granted.has(fn.node.addr)) return;
	granted.add(fn.node.addr);
	role.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [fn.functionArn] }));
}
