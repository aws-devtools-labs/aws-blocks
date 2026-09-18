// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/**
 * CDK-side tests for CronJob: compute targeting + synth-time schedule validation.
 *
 * CronJob points its EventBridge Scheduler target at `this.compute`'s function
 * rather than the stack's shared handler. By default `this.compute` resolves to
 * the stack's default LambdaCompute, so the schedule targets the same function
 * as before. When a nearer scope assigns a different compute (internal
 * `_compute`, the seam a future customer-facing option will drive), the
 * schedule target follows it to that compute's function.
 *
 * It also validates the schedule/timezone at synth (before resolving the
 * compute), so an invalid expression fails fast rather than minutes into the
 * deploy.
 */
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { isBlocksError } from '@aws-blocks/core';
import { BlocksPresets, BlocksStack, Scope } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import { Compute } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { CronJob, CronJobErrors } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

/** A non-Lambda compute, to exercise the "unsupported compute" synth guard. */
class FakeCompute extends Compute {
	setEnv(_key: string, _value: string): void {}
	// Observability hooks are irrelevant here — stub them to satisfy Compute.
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-cron-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStack(id: string): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults: BlocksPresets.production,
		defaultComputeFactory: lambdaFactory,
	});
}

function fnLogicalId(stack: BlocksStack, compute: LambdaCompute): string {
	return stack.getLogicalId(compute.fn.node.defaultChild as cdk.CfnElement);
}

function scheduleTargets(template: Template, logicalId: string): boolean {
	return JSON.stringify(template.findResources('AWS::Scheduler::Schedule')).includes(logicalId);
}

describe('CronJob compute targeting', () => {
	test('default: schedule target is the stack default compute function', async () => {
		const stack = await makeStack('CronDefault');
		new CronJob(stack, 'nightly', { schedule: 'rate(1 day)', handler: async () => {} });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Scheduler::Schedule', 1);
		assert.ok(
			scheduleTargets(template, fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'schedule targets the default compute function',
		);
	});

	test('targeted: schedule target follows an ancestor scope _compute to that function', async () => {
		const stack = await makeStack('CronTargeted');
		const lambdaB = new LambdaCompute(stack, 'LambdaB');
		const scoped = new Scope('scoped', { parent: stack });
		scoped._compute = lambdaB;
		new CronJob(scoped, 'nightly', { schedule: 'rate(1 day)', handler: async () => {} });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Scheduler::Schedule', 1);
		assert.ok(scheduleTargets(template, fnLogicalId(stack, lambdaB)), 'schedule targets lambdaB');
		assert.ok(
			!scheduleTargets(template, fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'schedule does NOT target the default compute',
		);
	});

	test('targeted via the public { compute } option: schedule follows it (no wrapping scope)', async () => {
		const stack = await makeStack('CronDirectOption');
		const lambdaB = new LambdaCompute(stack, 'LambdaB');
		// PR5's customer surface: the compute is handed to the constructor directly,
		// not inherited from a wrapping scope's internal `_compute` seam.
		new CronJob(stack, 'nightly', { schedule: 'rate(1 day)', handler: async () => {}, compute: lambdaB });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::Scheduler::Schedule', 1);
		assert.ok(scheduleTargets(template, fnLogicalId(stack, lambdaB)), 'schedule targets lambdaB');
		assert.ok(
			!scheduleTargets(template, fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'schedule does NOT target the default compute',
		);
	});

	test('two jobs on different computes: the shared scheduler role can invoke BOTH functions', async () => {
		const stack = await makeStack('CronTwoComputes');
		const lambdaB = new LambdaCompute(stack, 'LambdaB');
		const scoped = new Scope('scoped', { parent: stack });
		scoped._compute = lambdaB;
		// One job on the default compute, one on lambdaB. The scheduler role is shared
		// per stack; before the per-compute grant it only reached the first job's
		// function, so the second job's schedule would fail at runtime with AccessDenied.
		new CronJob(stack, 'onDefault', { schedule: 'rate(1 day)', handler: async () => {} });
		new CronJob(scoped, 'onB', { schedule: 'rate(1 day)', handler: async () => {} });

		const template = Template.fromStack(stack);
		const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
		assert.ok(
			policies.includes(fnLogicalId(stack, stack._defaultCompute as LambdaCompute)),
			'scheduler role policy grants invoke on the default compute function',
		);
		assert.ok(policies.includes(fnLogicalId(stack, lambdaB)), 'scheduler role policy grants invoke on lambdaB');
	});
});

describe('CronJob synth-time schedule validation', () => {
	test('rejects an invalid schedule at synth (rate(10 seconds))', async () => {
		const stack = await makeStack('CronInvalidSchedule');
		assert.throws(
			() => new CronJob(stack, 'job', { schedule: 'rate(10 seconds)', handler: async () => {} }),
			(e: unknown) => isBlocksError(e, CronJobErrors.InvalidSchedule),
		);
	});

	test('rejects an invalid timezone at synth', async () => {
		const stack = await makeStack('CronInvalidTz');
		assert.throws(
			() =>
				new CronJob(stack, 'job', {
					schedule: 'rate(5 minutes)',
					timezone: 'Mars/Phobos',
					handler: async () => {},
				}),
			(e: unknown) => isBlocksError(e, CronJobErrors.InvalidTimezone),
		);
	});

	test('accepts a valid schedule and synthesizes a CfnSchedule', async () => {
		const stack = await makeStack('CronValid');
		assert.doesNotThrow(() => new CronJob(stack, 'job', { schedule: 'rate(5 minutes)', handler: async () => {} }));
		Template.fromStack(stack).resourceCountIs('AWS::Scheduler::Schedule', 1);
	});

	test('rejects a non-Lambda compute at synth', async () => {
		const stack = await makeStack('CronUnsupportedCompute');
		const scoped = new Scope('scoped', { parent: stack });
		scoped._compute = new FakeCompute('fake', { parent: stack });
		assert.throws(
			() => new CronJob(scoped, 'job', { schedule: 'rate(5 minutes)', handler: async () => {} }),
			(e: unknown) => isBlocksError(e, CronJobErrors.UnsupportedCompute),
		);
	});
});
