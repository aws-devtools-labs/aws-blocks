// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
/**
 * The managed API front door, through a real synth.
 *
 * Whether a distribution appears at all is a posture decision made during
 * `create()` and acted on at synth, so it can only be checked end to end: the
 * pieces that build it are unit-tested in `core`'s `api-front-door.test.ts`, but
 * the wiring — preset default, per-app override, and the aspect firing once the
 * tree is complete — needs the umbrella's real `create()` with `LambdaCompute`
 * injected.
 *
 * Must run under `--conditions=cdk`.
 */
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BlocksBackend, type BlocksDefaults, BlocksPresets, BlocksStack, Hosting } from '@aws-blocks/blocks/cdk';
import { BLOCKS_AUTH_PREFIX, BLOCKS_RPC_PREFIX, clearRouteRegistry } from '@aws-blocks/core';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const __dirname = dirname(fileURLToPath(import.meta.url));
let handlerPath: string;
let backendPath: string;
let tmpDir: string;

before(() => {
	tmpDir = mkdtempSync(join(__dirname, 'tmp-front-door-'));
	handlerPath = join(tmpDir, 'handler.mjs');
	writeFileSync(handlerPath, "export const handler = async () => ({ statusCode: 200, body: '{}' });\n");
	backendPath = join(tmpDir, 'backend.mjs');
	writeFileSync(
		backendPath,
		`
		import { ApiNamespace, RawRoute, Scope } from '@aws-blocks/core';
		export default (stack) => {
			const scope = new Scope('app', { parent: stack });
			new ApiNamespace(scope, 'reportsApi', () => ({ run: () => 1 }));
			new RawRoute(scope, 'health', { method: 'GET', path: '/health', handler: async () => {} });
		};
		`,
	);
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

async function synth(
	id: string,
	defaults: BlocksDefaults,
	apiFrontDoor?: 'cloudfront' | 'none',
): Promise<{ stack: BlocksStack; template: Template }> {
	clearRouteRegistry();
	const app = new cdk.App();
	const stack = await BlocksStack.create(app, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backendPath,
		defaults,
		...(apiFrontDoor ? { apiFrontDoor } : {}),
	});
	// `Template.fromStack` runs synth, which is when the front-door aspect fires.
	return { stack, template: Template.fromStack(stack) };
}

/** The single distribution's config, asserting there is exactly one. */
function soleDistribution(template: Template): {
	DefaultCacheBehavior: { TargetOriginId: string };
	CacheBehaviors?: Array<{ PathPattern: string; TargetOriginId: string }>;
	Origins: Array<{ DomainName: unknown; OriginPath: unknown }>;
	Comment?: string;
} {
	const found = template.findResources('AWS::CloudFront::Distribution');
	assert.strictEqual(Object.keys(found).length, 1, 'expected exactly one distribution');
	return Object.values(found)[0]?.Properties?.DistributionConfig;
}

describe('managed API front door', () => {
	test('production provisions one distribution: all API behaviors on the single default origin (no fan-out yet)', async () => {
		const { template } = await synth('FrontDoorProd', BlocksPresets.production);
		const config = soleDistribution(template);

		// Every API path resolves to the default compute today, so the managed front
		// door emits an explicit behavior per API path (redundant with the default
		// behavior, and inert) — but they all target the one default origin. Fan-out
		// becomes load-bearing only once a namespace is assigned a distinct compute,
		// which is when a second origin appears.
		assert.ok(config.DefaultCacheBehavior, 'expected a default behavior');
		assert.strictEqual(config.Origins.length, 1, 'expected a single origin (the default compute) — no fan-out');
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		for (const expected of [BLOCKS_RPC_PREFIX, `${BLOCKS_RPC_PREFIX}/*`, `${BLOCKS_AUTH_PREFIX}/*`]) {
			assert.ok(patterns.includes(expected), `expected a behavior for ${expected}, got ${patterns.join(', ')}`);
		}
	});

	test('production emits an ApiFrontDoorUrl output carrying the distribution domain', async () => {
		const { template } = await synth('FrontDoorOutputs', BlocksPresets.production);

		const outputs = template.findOutputs('*');
		assert.ok(outputs.ApiFrontDoorUrl, 'expected an ApiFrontDoorUrl output');
		assert.ok(
			JSON.stringify(outputs.ApiFrontDoorUrl.Value).includes('DomainName'),
			'ApiFrontDoorUrl should carry the distribution domain',
		);
	});

	test('sandbox provisions no distribution', async () => {
		// A sandbox reaches API Gateway directly; a distribution would add CloudFront
		// propagation delay to every deploy/test cycle.
		const { template } = await synth('FrontDoorSandbox', BlocksPresets.sandbox);
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
		assert.deepStrictEqual(Object.keys(template.findOutputs('ApiFrontDoorUrl')), []);
	});

	test("apiFrontDoor: 'cloudfront' provisions one even in a sandbox", async () => {
		const { template } = await synth('FrontDoorOptIn', BlocksPresets.sandbox, 'cloudfront');
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
	});

	test("apiFrontDoor: 'none' suppresses it even in production", async () => {
		// The opt-out for an app that fronts its own API (an ALB, a custom domain, an
		// existing CDN).
		const { template } = await synth('FrontDoorOptOut', BlocksPresets.production, 'none');
		template.resourceCountIs('AWS::CloudFront::Distribution', 0);
	});

	test('the front door is built once, not once per construct visited', async () => {
		// The aspect is invoked for every construct in the stack. Without the one-shot
		// guard this would emit a distribution per node and fail on a duplicate output.
		const { template } = await synth('FrontDoorOnce', BlocksPresets.production);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
		assert.strictEqual(Object.keys(template.findOutputs('ApiFrontDoorUrl')).length, 1);
	});
});

describe('the ApiUrl output', () => {
	test('resolves to the managed front door when one is provisioned', async () => {
		// The whole point of provisioning a front door: clients must actually go
		// through it. `deploy.ts` and `sandbox.ts` hand this output straight to a
		// client as `BLOCKS_API_URL`, so it has to be the front door's RPC URL, not
		// the gateway's.
		const { template } = await synth('ApiUrlFrontDoor', BlocksPresets.production);

		const apiUrl = JSON.stringify(template.findOutputs('ApiUrl').ApiUrl.Value);
		assert.ok(apiUrl.includes('DomainName'), `expected the distribution domain, got ${apiUrl}`);
		assert.ok(!apiUrl.includes('execute-api'), 'ApiUrl must not point at the gateway');
		assert.ok(apiUrl.includes(BLOCKS_RPC_PREFIX), 'ApiUrl must carry the RPC path');
	});

	test('falls back to the gateway when no front door is provisioned', async () => {
		// A sandbox reaches API Gateway directly. The output is composed from the
		// default compute's endpoint plus the RPC prefix — not a stored URL — so the
		// prefix is present either way.
		const { template } = await synth('ApiUrlNoFrontDoor', BlocksPresets.sandbox);

		const apiUrl = JSON.stringify(template.findOutputs('ApiUrl').ApiUrl.Value);
		assert.ok(apiUrl.includes('execute-api'), `expected the gateway host, got ${apiUrl}`);
		assert.ok(apiUrl.includes(BLOCKS_RPC_PREFIX), 'ApiUrl must carry the RPC path');
	});
});

describe('Hosting reuse', () => {
	test('a Hosting distribution fronts the API instead of a second managed one', async () => {
		// An app with a CloudFront-hosted frontend must not get two distributions: the
		// API belongs on the same one as the frontend, so it is reachable on the same
		// domain with no CORS and no extra hop. Hosting claims the role during
		// construction; the backend's aspect runs later at synth and stands down.
		clearRouteRegistry();
		const root = mkdtempSync(join(tmpDir, 'site-'));
		mkdirSync(join(root, 'dist'), { recursive: true });
		writeFileSync(join(root, 'dist', 'index.html'), '<!doctype html><title>t</title>');

		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'FrontDoorHostingReuse', {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});
		new Hosting(stack, 'Hosting', {
			root,
			framework: 'spa',
			buildOutputDir: 'dist',
			api: stack,
		});

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 1);
		// No managed front door was built, so it published no URL of its own.
		assert.deepStrictEqual(Object.keys(template.findOutputs('ApiFrontDoorUrl')), []);

		// Hosting proxies the API on its own distribution: a behavior for the
		// `reportsApi` namespace subtree and for each app RawRoute (here the built-in
		// console routes and `/health`), plus the reserved RPC and auth subtrees added
		// last. Every path resolves to the default compute today, so these are all
		// redundant with the default behavior and target one origin — but each is
		// emitted explicitly (no mode flag).
		const config = soleDistribution(template);
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		for (const expected of [
			BLOCKS_RPC_PREFIX,
			`${BLOCKS_RPC_PREFIX}/*`,
			`${BLOCKS_AUTH_PREFIX}/*`,
			'/aws-blocks/resources',
			'/health',
		]) {
			assert.ok(patterns.includes(expected), `expected a behavior for ${expected}, got ${patterns.join(', ')}`);
		}

		// And the client is pointed at that distribution, not the gateway.
		const apiUrl = JSON.stringify(template.findOutputs('ApiUrl').ApiUrl.Value);
		assert.ok(apiUrl.includes('DomainName'), `expected the distribution domain, got ${apiUrl}`);
		assert.ok(apiUrl.includes(BLOCKS_RPC_PREFIX), 'ApiUrl must carry the RPC path');
	});
});

describe('BlocksBackend', () => {
	/** A `BlocksBackend` inside a stack it does not own — the embedding use case. */
	async function backendIn(backendId: string, stack: cdk.Stack) {
		return BlocksBackend.create(stack, backendId, {
			backendHandlerPath: handlerPath,
			backendCDKPath: backendPath,
			defaults: BlocksPresets.production,
		});
	}

	test('provisions its own front door when embedded in a foreign stack', async () => {
		// A BlocksBackend is a construct inside someone else's stack. The distribution
		// and its output hang off the backend (not the stack), so the aspect scoped to
		// the backend still fires and provisions exactly one front door.
		clearRouteRegistry();
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'BackendHost');
		await backendIn('Backend', stack);

		const config = soleDistribution(Template.fromStack(stack));
		assert.ok(config.DefaultCacheBehavior, 'expected a default behavior');
		assert.strictEqual(config.Origins.length, 1, 'expected a single origin (the default compute) — no fan-out');
		const patterns = (config.CacheBehaviors ?? []).map((b) => b.PathPattern);
		for (const expected of [BLOCKS_RPC_PREFIX, `${BLOCKS_RPC_PREFIX}/*`, `${BLOCKS_AUTH_PREFIX}/*`]) {
			assert.ok(patterns.includes(expected), `expected a behavior for ${expected}, got ${patterns.join(', ')}`);
		}
	});

	test('two backends in one stack get independent front doors', async () => {
		// Both the distribution and the output hang off the backend, not the stack, so
		// siblings do not collide on a construct id — each gets its own front door.
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TwoBackends');
		// The RawRoute registry is process-wide, so a second backend re-registering the
		// same app RawRoute (`/health`) would collide. The managed front door reads the
		// backend's `defaultEndpoint`, not the registry, so clearing between the two is
		// safe here and keeps this test to what it asserts: one distribution per backend.
		clearRouteRegistry();
		await backendIn('BackendA', stack);
		clearRouteRegistry();
		await backendIn('BackendB', stack);

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CloudFront::Distribution', 2);
	});
});
