// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that importing the umbrella registers the Lambda default compute
 * exactly once, so CLI telemetry reports it for apps that never construct it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Scope } from './index.js';

const require = createRequire(import.meta.url);
const lambdaComputeEntry = require.resolve('@aws-blocks/bb-lambda-compute');
const lambdaComputeVersion: string = JSON.parse(
	readFileSync(join(dirname(lambdaComputeEntry), '..', 'package.json'), 'utf-8'),
).version;

describe('umbrella default compute telemetry registration', () => {
	test('reports LambdaCompute with its package version', () => {
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === 'LambdaCompute'),
			[{ name: 'LambdaCompute', version: lambdaComputeVersion }],
		);
		assert.strictEqual(customBlocksCount, 0);
	});

	test('registers a single instance, even when re-imported', async () => {
		await import('./index.js');
		assert.strictEqual(Scope.getRegisteredBlocks().totalCount, 1);
	});
});
