// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The end-to-end multi-compute mechanism at synth: assigning a namespace to a
 * distinct compute makes the managed front door fan out a per-namespace behavior
 * to that compute's origin, while unassigned namespaces stay on the default.
 *
 * This is the "zero-rewrite" verification the rollout plan calls for. Nothing in
 * `api-front-door.ts` changes between the no-fan-out state and this one: the same
 * `addRouteBehaviors` over the same route registry emits a second origin purely
 * because a namespace's routing entry now carries a non-default `endpoint`. The
 * only new machinery is the internal assignment hook (`ScopeOptions.compute` →
 * `Scope._compute`), exercised here by parenting a namespace under a `Scope` that
 * was given a provided compute.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import { BLOCKS_RPC_PREFIX, clearRouteRegistry } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const __dirname = dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let handlerPath: string;

before(() => {
	tmpDir = mkdtempSync(join(__dirname, 'tmp-fanout-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** A backend module that assigns `reportsApi` to a distinct compute; `publicApi` stays on the default. */
function writeBackend(): string {
	const backendPath = join(tmpDir, `backend-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(
		backendPath,
		`
		import { ApiNamespace, Scope } from '@aws-blocks/core';
		import { ComputeProvider } from '@aws-blocks/blocks/cdk';
		export default (stack) => {
			const scope = new Scope('app', { parent: stack });
			// Unassigned: routes to the stack's default compute via the catch-all.
			new ApiNamespace(scope, 'publicApi', () => ({ run: () => 1 }));
			// Declared by need, then assigned to a namespace by parenting the namespace
			// under a scope that carries it — the internal hook PR5's option forwards to.
			const reports = ComputeProvider.provide('reports', { timeoutSeconds: 240, memoryMb: 1024 });
			const reportsScope = new Scope('reportsScope', { parent: stack, compute: reports });
			new ApiNamespace(reportsScope, 'reportsApi', () => ({ run: () => 1 }));
		};
		`,
	);
	return backendPath;
}

/**
 * The same fan-out, but through the customer-facing `{ compute }` option on
 * `ApiNamespace` directly — no scope-wrapping. This is exactly what an app author
 * writes: declare a compute by need, then hand it to the namespace.
 */
function writeBackendDirectOption(): string {
	const backendPath = join(tmpDir, `backend-direct-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(
		backendPath,
		`
		import { ApiNamespace, Scope } from '@aws-blocks/core';
		import { ComputeProvider } from '@aws-blocks/blocks/cdk';
		export default (stack) => {
			const scope = new Scope('app', { parent: stack });
			// Unassigned: routes to the stack's default compute via the catch-all.
			new ApiNamespace(scope, 'publicApi', () => ({ run: () => 1 }));
			// Assigned via the public option — no wrapping Scope needed.
			const reports = ComputeProvider.provide('reports', { timeoutSeconds: 240, memoryMb: 1024 });
			new ApiNamespace(scope, 'reportsApi', () => ({ run: () => 1 }), { compute: reports });
		};
		`,
	);
	return backendPath;
}

/**
 * A backend that puts a `RawRoute` under a scope carrying a compute with no HTTP
 * endpoint (a worker-only compute, simulated by an inert `{ fullId }` handle — no
 * public API mints one yet). The RawRoute CDK guard must reject this at synth.
 */
function writeBackendWorkerRawRoute(): string {
	const backendPath = join(tmpDir, `backend-worker-${Math.random().toString(36).slice(2)}.mjs`);
	writeFileSync(
		backendPath,
		`
		import { RawRoute, Scope } from '@aws-blocks/core';
		export default (stack) => {
			// An endpoint-less compute: only \`fullId\`, no HTTP ingress.
			const workerScope = new Scope('workerScope', { parent: stack, compute: { fullId: 'worker' } });
			new RawRoute(workerScope, 'hook', { method: 'GET', path: '/hook', handler: async () => {} });
		};
		`,
	);
	return backendPath;
}

async function synth(id: string, backendCDKPath: string = writeBackend()): Promise<Template> {
	// A clean registry per synth, so the fan-out assertion is isolated from routes
	// registered by other tests in this process.
	clearRouteRegistry();
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath,
		defaults: BlocksPresets.production,
	});
	return Template.fromStack(stack);
}

function soleDistribution(template: Template): {
	DefaultCacheBehavior: { TargetOriginId: string };
	CacheBehaviors?: Array<{ PathPattern: string; TargetOriginId: string }>;
	Origins: Array<{ DomainName: unknown }>;
} {
	const found = template.findResources('AWS::CloudFront::Distribution');
	assert.strictEqual(Object.keys(found).length, 1, 'expected exactly one distribution');
	return Object.values(found)[0]?.Properties?.DistributionConfig;
}

describe('multi-compute front-door fan-out', () => {
	test('an assigned namespace gets its own origin; the default namespace stays on the default', async () => {
		const config = soleDistribution(await synth('FanoutAssigned'));

		// Two origins now: the default compute and the assigned `reports` compute.
		// Before assignment (see api-front-door.test.ts) there is exactly one.
		assert.strictEqual(config.Origins.length, 2, 'expected the default origin plus the assigned compute origin');

		const behaviors = config.CacheBehaviors ?? [];
		const behaviorFor = (pattern: string) => behaviors.find((b) => b.PathPattern === pattern);

		const reportsBehavior = behaviorFor(`${BLOCKS_RPC_PREFIX}/reportsApi`);
		assert.ok(reportsBehavior, `expected a behavior for the assigned namespace, got ${behaviors.map((b) => b.PathPattern).join(', ')}`);

		const defaultTarget = config.DefaultCacheBehavior.TargetOriginId;
		assert.notStrictEqual(
			reportsBehavior.TargetOriginId,
			defaultTarget,
			'the assigned namespace must target its own origin, not the default compute',
		);

		// The unassigned namespace still gets an explicit behavior (full redundancy),
		// but it must target the default origin — not a distinct compute. Assert the
		// behavior is present rather than guarding on it, so a regression that drops
		// the unassigned namespace's behavior fails here instead of skipping silently.
		const publicBehavior = behaviorFor(`${BLOCKS_RPC_PREFIX}/publicApi`);
		assert.ok(publicBehavior, 'the unassigned namespace should still have an explicit CacheBehavior');
		assert.strictEqual(
			publicBehavior.TargetOriginId,
			defaultTarget,
			'the unassigned namespace must stay on the default origin',
		);
	});

	test('the public `{ compute }` option on ApiNamespace fans out the same way', async () => {
		// PR5's customer surface: `new ApiNamespace(scope, name, handler, { compute })`
		// must produce the identical topology as the internal scope-wrapping hook —
		// the option just forwards the compute into the namespace's routing entry.
		const config = soleDistribution(await synth('FanoutDirectOption', writeBackendDirectOption()));

		assert.strictEqual(config.Origins.length, 2, 'expected the default origin plus the assigned compute origin');

		const behaviors = config.CacheBehaviors ?? [];
		const reportsBehavior = behaviors.find((b) => b.PathPattern === `${BLOCKS_RPC_PREFIX}/reportsApi`);
		assert.ok(reportsBehavior, `expected a behavior for the assigned namespace, got ${behaviors.map((b) => b.PathPattern).join(', ')}`);
		assert.notStrictEqual(
			reportsBehavior.TargetOriginId,
			config.DefaultCacheBehavior.TargetOriginId,
			'the assigned namespace must target its own origin, not the default compute',
		);
	});

	test('a RawRoute assigned an ingress-less compute fails synth, naming the path', async () => {
		// The RawRoute CDK guard is the non-subtree counterpart to the namespace
		// routability guard: a route served by a worker-only compute has no origin to
		// route to and must fail loudly rather than silently answer from the default.
		await assert.rejects(
			() => synth('WorkerRawRoute', writeBackendWorkerRawRoute()),
			/RawRoute "\/hook".*no HTTP endpoint/s,
		);
	});
});
