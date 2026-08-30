// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth tests for the Dashboard construct against a real compute.
 *
 * The per-compute Dashboard behavior (organize the body by compute, render a
 * logs / traces section only when a Logger / Tracer is attached to that
 * compute) is otherwise only exercised by unit tests over `buildDashboardWidgets`
 * with hand-built section stubs. These tests build a real `Dashboard` on a
 * `BlocksStack`'s default `LambdaCompute` and assert the synthesized
 * `AWS::CloudWatch::Dashboard` body, covering the construct ↔ compute seam
 * (the dashboard resolving `this.compute` and calling
 * `compute.dashboardSection(region)`) end to end.
 *
 * A Logger / Tracer attaches to a compute purely by calling its public
 * `enableLogging()` / `enableTracing()` seam (that is all the cdk Logger /
 * Tracer constructs do to the compute). We drive that seam directly on the real
 * cdk `LambdaCompute`: the bb-logger / bb-tracer packages export their cdk
 * variant only under the `cdk` condition, which cannot be activated at ESM
 * import time from inside this shared mock-conditioned test process, so
 * importing them here would resolve their local-mock variant and never touch
 * the compute. Calling the seam directly is the faithful equivalent.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { BlocksPresets, BlocksStack } from '@aws-blocks/core/cdk';
import type { DefaultComputeFactory } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Dashboard } from './index.cdk.js';

const lambdaFactory: DefaultComputeFactory = (root) => new LambdaCompute(root as never, 'DefaultCompute');

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	// Satisfies assertCdkConditionActive() (reads process.env.NODE_OPTIONS),
	// which BlocksStack.create() calls.
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
	tmpDir = mkdtempSync(join(__dirname, 'tmp-dashboard-cdk-'));
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

/** The synthesized CloudWatch Dashboard body, as a searchable string. */
function dashboardBody(stack: BlocksStack): string {
	const dashboards = Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard');
	return JSON.stringify(dashboards);
}

describe('Dashboard against a real compute (synth)', () => {
	test('renders the compute header plus logs + traces sections when logging + tracing are enabled', async () => {
		const stack = await makeStack('DashboardComputeFull');

		// Attach a Logger + Tracer to the stack's default compute via the exact
		// public seam their cdk constructs use.
		const compute = stack._defaultCompute as LambdaCompute;
		compute.enableLogging();
		compute.enableTracing();

		// routePath:false — the redirect route uses a process-global registry that
		// would collide across the stacks these sibling tests each build; the route
		// is not what this test asserts.
		new Dashboard(stack, 'dashboard', { routePath: false });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'body has the compute header');
		assert.ok(body.includes('📋 Logs'), 'body has the logs section (logging enabled)');
		assert.ok(body.includes('🔍 Traces'), 'body has the traces section (tracing enabled)');
	});

	test('omits logs/traces sections when no Logger/Tracer is attached', async () => {
		const stack = await makeStack('DashboardComputeBare');

		new Dashboard(stack, 'dashboard', { routePath: false });

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'body still has the compute header (health always renders)');
		assert.ok(!body.includes('📋 Logs'), 'no logs section without a Logger');
		assert.ok(!body.includes('🔍 Traces'), 'no traces section without a Tracer');
	});

	test('covers the app default compute (no compute selector is exposed yet)', async () => {
		const stack = await makeStack('DashboardDefaultCompute');
		const compute = stack._defaultCompute as LambdaCompute;
		compute.enableLogging();

		// There's no `computes` option — the dashboard always renders the app's
		// single default compute. A second compute isn't customer-reachable yet.
		new Dashboard(stack, 'dashboard', { routePath: false });

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'default compute section renders');
		assert.ok(body.includes('📋 Logs'), 'its logs section renders once logging is enabled');
	});
});
