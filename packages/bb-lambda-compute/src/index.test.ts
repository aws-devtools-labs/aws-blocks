// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifies that the default entry preserves LambdaCompute metadata and official
 * telemetry registration, which construction alone does not validate.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-blocks/core';
import { LambdaCompute } from './index.mock.js';
import { LambdaCompute as AwsLambdaCompute } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let counter = 0;
function makeCompute(): LambdaCompute {
	const scope = new Scope(`lambda-compute-telemetry-${++counter}`);
	return new LambdaCompute(scope, 'compute');
}

describe('LambdaCompute telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name OFFICIAL_BB_NAMES carries', () => {
		assert.strictEqual(BB_NAME, 'LambdaCompute');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('the default entry re-exports the AWS runtime class', () => {
		assert.strictEqual(LambdaCompute, AwsLambdaCompute);
	});

	test('an instance carries bbName and bbVersion', () => {
		const compute = makeCompute();
		assert.strictEqual(compute.bbName, BB_NAME);
		assert.strictEqual(compute.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		makeCompute();
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
