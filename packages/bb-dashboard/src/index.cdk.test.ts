// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-synth tests for the Dashboard construct against a real compute.
 *
 * The per-compute Dashboard behavior (organize the body by compute; render the
 * health + logs sections always, and the traces section only when the compute
 * is traced) is otherwise only exercised by unit tests over
 * `buildDashboardWidgets` with hand-built section stubs. These tests build a
 * real `Dashboard` on a `BlocksStack`'s default `LambdaCompute` and assert the
 * synthesized `AWS::CloudWatch::Dashboard` body, covering the construct ↔
 * compute seam (the dashboard enumerating computes and calling
 * `compute.dashboardSection(region)`) end to end, plus the `logs` / `traces`
 * display toggles and the `computes` selector.
 *
 * Tracing turns on via the compute's public `enableTracing()` seam — which the
 * framework calls on every compute when the app contains a Tracer. We drive
 * that seam directly on the real cdk `LambdaCompute`: the bb-tracer package
 * exports its cdk variant only under the `cdk` condition, which cannot be
 * activated at ESM import time from inside this shared mock-conditioned test
 * process, so importing it here would resolve its local-mock variant and never
 * touch the compute. Calling the seam directly is the faithful equivalent.
 * (Logging has no enable seam — it is always on.)
 */

import assert from 'node:assert';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute/cdk';
import { BlocksPresets, BlocksStack, finalizeDashboards } from '@aws-blocks/core/cdk';
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
	test('renders the compute header plus logs (always) + traces (when traced)', async () => {
		const stack = await makeStack('DashboardComputeFull');

		// Enable tracing on the stack's default compute via the exact public seam
		// the framework calls when the app contains a Tracer. Logging needs no
		// enable — it is always on.
		const compute = stack._defaultCompute as LambdaCompute;
		compute.enableTracing();

		// routePath:false — the redirect route uses a process-global registry that
		// would collide across the stacks these sibling tests each build; the route
		// is not what this test asserts.
		new Dashboard(stack, 'dashboard', { routePath: false });
		// The widget body is deferred; create() already ran for this stack, so
		// finalize dashboards explicitly to build it before asserting.
		finalizeDashboards(stack);

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'body has the compute header');
		assert.ok(body.includes('📋 Logs'), 'body has the logs section (logs are always on)');
		assert.ok(body.includes('🔍 Traces'), 'body has the traces section (tracing enabled)');
	});

	test('renders logs (always) but omits traces when the app has no Tracer', async () => {
		const stack = await makeStack('DashboardComputeBare');

		new Dashboard(stack, 'dashboard', { routePath: false });
		finalizeDashboards(stack);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'body has the compute header (health always renders)');
		assert.ok(body.includes('📋 Logs'), 'logs section renders (logs are always on)');
		assert.ok(!body.includes('🔍 Traces'), 'no traces section without a Tracer');
	});

	test('logs:false hides the logs section (logs are still captured)', async () => {
		const stack = await makeStack('DashboardLogsOff');

		new Dashboard(stack, 'dashboard', { routePath: false, logs: false });
		finalizeDashboards(stack);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'compute header still renders');
		assert.ok(!body.includes('📋 Logs'), 'logs section suppressed by logs:false');
	});

	test('traces:false hides the traces section even when tracing is enabled', async () => {
		const stack = await makeStack('DashboardTracesOff');
		const compute = stack._defaultCompute as LambdaCompute;
		compute.enableTracing();

		new Dashboard(stack, 'dashboard', { routePath: false, traces: false });
		finalizeDashboards(stack);

		const body = dashboardBody(stack);
		assert.ok(body.includes('📋 Logs'), 'logs section still renders');
		assert.ok(!body.includes('🔍 Traces'), 'traces section suppressed by traces:false');
	});

	test('defaults to every compute in the app, resolved at finalize', async () => {
		const stack = await makeStack('DashboardDefaultCompute');

		// No `computes` option — the default selection is every compute in the
		// app, resolved at finalize.
		new Dashboard(stack, 'dashboard', { routePath: false });
		finalizeDashboards(stack);

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔧 DefaultCompute'), 'default compute section renders');
		assert.ok(body.includes('📋 Logs'), 'its logs section renders (logs are always on)');
	});

	test('renders traces when the Dashboard is constructed BEFORE tracing is enabled (order-independent via finalize)', async () => {
		const stack = await makeStack('DashboardBeforeTracer');
		const compute = stack._defaultCompute as LambdaCompute;

		// Construct the Dashboard first, then enable tracing. Because the widget
		// body is deferred to a finalizer (built after the whole app is
		// constructed), the traces section still appears despite the order.
		new Dashboard(stack, 'dashboard', { routePath: false });
		compute.enableTracing();
		finalizeDashboards(stack);

		const body = dashboardBody(stack);
		assert.ok(body.includes('🔍 Traces'), 'traces section renders despite Dashboard-before-Tracer order');
	});

});

describe('Dashboard synth ids', () => {
	test('logical id, construct path and dashboard name are stable', async () => {
		const stack = await makeStack('DashboardIds');
		const dash = new Dashboard(stack, 'dashboard', { routePath: false });
		finalizeDashboards(stack);
		const resources = Template.fromStack(stack).findResources('AWS::CloudWatch::Dashboard');
		assert.deepStrictEqual(
			{ path: dash.node.path, logicalIds: Object.keys(resources), names: Object.values(resources).map((r: any) => r.Properties.DashboardName) },
			{ path: 'DashboardIds/dashboard', logicalIds: ['dashboardE8F903B5'], names: ['DashboardIds-dashboard'] },
		);
	});
});

// ── defaults.permissionsBoundary guard ───────────────────────────────────────
// Every AWS::IAM::Role in every synthesized template (custom-resource provider
// roles and any other stack or helper stack's roles included) must carry the
// configured boundary and be listed in the synth-time IAM report.
//
// Keep in sync: the same helper is copied in the bb-auth (`boundary.cdk.test.ts`), bb-compute, bb-container-compute and bb-cron-job
// cdk test files, and mirrors core's `assertEveryRoleBounded` in
// `packages/core/src/cdk/permissions-boundary.test.ts`. A fix to one copy
// belongs in all of them.

const GUARD_BOUNDARY = 'blocks-guard-boundary';
const GUARD_EXPECTED = {
	'Fn::Join': [
		'',
		['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:policy/${GUARD_BOUNDARY}`],
	],
};

/**
 * Read every top-level template and the IAM report in `outdir`; fail on a role
 * without the boundary or missing from the report. Returns the checked roles as
 * `<artifact>/<logicalId>` (for asserting a block's own roles were reached).
 *
 * Only the top level of the cloud assembly is read: templates from a CDK `Stage`
 * (written under `assembly-*` folders) are not. No block tested here creates a Stage.
 */
function assertEveryRoleBoundedAndReported(outdir: string, reportFile: string): string[] {
	const report = JSON.parse(readFileSync(join(outdir, reportFile), 'utf8')) as {
		roles: { stack: string; logicalId: string; permissionsBoundary: unknown }[];
	};
	const reported = new Set(report.roles.map((r) => `${r.stack}/${r.logicalId}`));
	const checked: string[] = [];
	const problems: string[] = [];
	for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
		const artifact = file.slice(0, -'.template.json'.length);
		const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
			Resources?: Record<string, { Type: string; Properties?: { PermissionsBoundary?: unknown } }>;
		};
		for (const [id, r] of Object.entries(Resources)) {
			if (r.Type !== 'AWS::IAM::Role') continue;
			const key = `${artifact}/${id}`;
			checked.push(key);
			if (JSON.stringify(r.Properties?.PermissionsBoundary) !== JSON.stringify(GUARD_EXPECTED)) {
				problems.push(`${key}: boundary ${JSON.stringify(r.Properties?.PermissionsBoundary ?? 'NONE')}`);
			}
			if (!reported.has(key)) problems.push(`${key}: missing from ${reportFile}`);
		}
	}
	assert.ok(checked.length > 0, 'synth should produce at least one role');
	assert.deepStrictEqual(
		problems,
		[],
		`roles not covered by defaults.permissionsBoundary:\n  ${problems.join('\n  ')}`,
	);
	return checked;
}

describe('Dashboard under defaults.permissionsBoundary', () => {
	test('every role in the stack carries the boundary and is in blocks-iam.json', async () => {
		const outdir = mkdtempSync(join(tmpdir(), 'dashboard-boundary-'));
		try {
			const app = new cdk.App({ outdir });
			const stack = await BlocksStack.create(app, 'DashboardBoundary', {
				backendHandlerPath: handlerPath,
				backendCDKPath: backendPath,
				defaults: { ...BlocksPresets.production, permissionsBoundary: GUARD_BOUNDARY },
				defaultComputeFactory: lambdaFactory,
			});
			(stack._defaultCompute as LambdaCompute).enableTracing();
			new Dashboard(stack, 'dashboard', { routePath: false });
			finalizeDashboards(stack);
			app.synth();

			const checked = assertEveryRoleBoundedAndReported(outdir, `${stack.artifactId}.blocks-iam.json`);
			// Dashboard owns no IAM roles today, and `BlocksRole` is the shared execution role every
			// BlocksStack has, so this check doesn't prove Dashboard was reached. The test is a guard:
			// a role Dashboard adds later must carry the boundary and be reported.
			assert.ok(
				checked.some((r) => r.includes('BlocksRole')),
				`the shared execution role was checked: ${checked}`,
			);
		} finally {
			rmSync(outdir, { recursive: true, force: true });
		}
	});
});
