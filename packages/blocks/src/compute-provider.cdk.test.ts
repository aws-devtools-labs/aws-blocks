// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared implementation behind a compute declaration.
 *
 * Covers what `provideCompute` owns on its own: resolving the parent, validating
 * the requirements, and translating them into the fulfillment's own settings.
 * Assigning a compute to a namespace is a separate surface and is covered with it.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
// `Compute` is the public compute handle (`@aws-blocks/core/cdk`); `getComputes`
// is the framework-internal registry read used to assert the compute registered.
import { LambdaCompute } from '@aws-blocks/bb-lambda-compute';
import type { Compute } from '@aws-blocks/core/cdk';
import { getComputes } from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { provideCompute } from './compute-provider.js';
import { BlocksPresets, BlocksStack, ComputeProvider } from './index.cdk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let tmpDir: string;
let handlerPath: string;
let backendPath: string;

before(() => {
	// Run under `--conditions=cdk` (see this package's test script) so the BB
	// packages resolve their CDK entries rather than the default mock stubs.
	tmpDir = mkdtempSync(join(__dirname, 'tmp-compute-provider-'));
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
	});
}

// `provideCompute` returns `unknown` so each conditional entry can promise its own
// type; the cast is this test standing in for that entry.
const provide = (id: string, requirements?: { timeoutSeconds?: number; memoryMb?: number }) =>
	provideCompute(id, requirements) as Compute;

describe('provideCompute', () => {
	test('returns a Compute the framework registers exactly once', async () => {
		const stack = await makeStack('ProvideBasic');

		const reports = provide('reports', { timeoutSeconds: 60 * 4, memoryMb: 1024 });

		// Registered exactly once. A declaration that were itself a compute would
		// register a second object for the same logical compute, doubling every
		// namespace, dashboard section and mounted route.
		const computes = getComputes(stack);
		assert.strictEqual(computes.length, 2, 'the default compute plus exactly one declared compute');
		assert.ok(computes.includes(reports), 'the provided compute is the registered one');
	});

	test('applies the requirements to the compute it provisions', async () => {
		const stack = await makeStack('ProvideRequirements');

		provide('reports', { timeoutSeconds: 240, memoryMb: 1024 });

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			MemorySize: 1024,
			Timeout: 240,
		});
	});

	test('maps the requirements onto the fulfillment, leaving unset ones at its defaults', async () => {
		// The provider owns the translation, so the compute package never learns that
		// requirements exist.
		const stack = await makeStack('ProvidePartial');

		provide('reports', { memoryMb: 512 });

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			MemorySize: 512,
			Timeout: 900,
		});
	});

	test('fails when the workload exceeds what the compute can host', async () => {
		// There is no other fulfillment that could take this workload, so clamping it
		// would ship an app that deploys and then times out.
		await makeStack('ProvideTooBig');

		assert.throws(() => provide('reports', { timeoutSeconds: 3600 }), /timeoutSeconds is 3600.*maximum is 900/s);
	});

	test('the validation error names the offending compute', async () => {
		await makeStack('ProvideNamed');

		assert.throws(() => provide('reportWorker', { memoryMb: 99999 }), /reportWorker/);
	});

	test('accepts a cdk.Duration timeout on direct construction (the "name your platform" path)', async () => {
		// `provideCompute` always maps requirements to a plain number of seconds, so the
		// `Duration`-instance branch of `LambdaComputeProps.timeout` is only reached when
		// an app constructs the compute directly — the path the changeset promotes as
		// equally valid. Exercise it so that branch is not synth-tested only by its
		// number and default arms.
		const stack = await makeStack('DirectDuration');

		new LambdaCompute(stack, 'reports', { timeout: cdk.Duration.minutes(4) });

		Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
			Timeout: 240,
		});
	});

	test('rejects a declaration made before the stack exists', () => {
		delete (globalThis as { CURRENT_BLOCKS_STACK?: unknown }).CURRENT_BLOCKS_STACK;

		// The guard lives on the `cdk` entry, not the shared `provideCompute`: only
		// under CDK does a missing parent mean a real mistake (the runtime/mock entry
		// resolves it to a stub). So assert through the public CDK `ComputeProvider`.
		assert.throws(() => ComputeProvider.provide('orphan'), /declared before the Blocks stack existed/);
	});
});
