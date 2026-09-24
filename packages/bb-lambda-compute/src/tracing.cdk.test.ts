// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth tests for presence-gated, fleet-wide tracing.
 *
 * Tracing is driven by core's `registerTracer` (called by a `Tracer`'s
 * constructor) + `finalizeTracing` (run at the end of `create()`), which enables
 * X-Ray on every compute in the stack. We drive those core seams
 * directly rather than constructing a real `Tracer`: bb-tracer exports its cdk
 * variant only under the `cdk` condition, which can't be activated at ESM import
 * time from this shared mock-conditioned test process, so importing it would
 * resolve the local-mock variant and never touch the compute. Calling
 * `registerTracer(...)` is the faithful equivalent of what the Tracer does — the
 * same approach the dashboard cdk test takes for `enableTracing`.
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BlocksDefaults } from '@aws-blocks/core/cdk';
import { BlocksPresets, BlocksStack, finalizeTracing, registerTracer } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { LambdaCompute } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-tracing-cdk-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(backendPath, 'export default () => {};\n');
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function makeStack(id: string, defaults: BlocksDefaults = BlocksPresets.production): Promise<BlocksStack> {
	const app = new cdk.App();
	return BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults,
		defaultComputeFactory: lambdaFactory,
	});
}

/** Lambda functions synthesized with X-Ray Active tracing. */
function activeFunctions(template: Template): unknown[] {
	return Object.values(
		template.findResources('AWS::Lambda::Function', {
			Properties: { TracingConfig: { Mode: 'Active' } },
		}),
	);
}

describe('presence-gated tracing (registerTracer + finalizeTracing)', () => {
	test('a registered Tracer flips the compute to X-Ray Active + grants the role X-Ray publish', async () => {
		const stack = await makeStack('TracingOn');
		registerTracer(stack); // stands in for `new Tracer(scope, id)`
		finalizeTracing(stack, stack.executionRole);

		const template = Template.fromStack(stack);
		assert.strictEqual(activeFunctions(template).length, 1, 'the compute is traced');
		template.hasResourceProperties(
			'AWS::IAM::Policy',
			Match.objectLike({
				PolicyDocument: {
					Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['xray:PutTraceSegments']) })]),
				},
			}),
		);
	});

	test('no Tracer → no compute is traced', async () => {
		const stack = await makeStack('TracingOff');
		finalizeTracing(stack, stack.executionRole); // no registerTracer

		assert.strictEqual(activeFunctions(Template.fromStack(stack)).length, 0, 'nothing is traced without a Tracer');
	});

	test('fleet-wide: one Tracer traces every compute in the app', async () => {
		const stack = await makeStack('TracingFleet');
		// A second compute in the same app (multi-compute path).
		new LambdaCompute(stack, 'worker');
		registerTracer(stack);
		finalizeTracing(stack, stack.executionRole);

		assert.strictEqual(activeFunctions(Template.fromStack(stack)).length, 2, 'both computes are traced');
	});
});
