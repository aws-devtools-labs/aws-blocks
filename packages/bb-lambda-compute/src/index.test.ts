// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-blocks/core';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('LambdaCompute telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is LambdaCompute', () => {
		assert.strictEqual(BB_NAME, 'LambdaCompute');
	});

	test('BB_VERSION matches package.json', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('the default entry re-exports the aws-runtime class', async () => {
		const { LambdaCompute: mock } = await import('./index.mock.js');
		const { LambdaCompute: aws } = await import('./index.aws.js');
		assert.strictEqual(mock, aws);
	});

	test('sets bbName/bbVersion', async () => {
		const { LambdaCompute } = await import('./index.mock.js');
		const compute = new LambdaCompute({ id: 'root' }, 'compute');
		assert.strictEqual(compute.bbName, BB_NAME);
		assert.strictEqual(compute.bbVersion, BB_VERSION);
	});

	test('registers as an official block', async () => {
		const { LambdaCompute } = await import('./index.mock.js');
		new LambdaCompute({ id: 'root' }, 'compute');
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter((b) => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
