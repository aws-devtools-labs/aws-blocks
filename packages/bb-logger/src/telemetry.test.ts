// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry-registration tests for Logger.
 *
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 *
 * Imported through `./index.mock.js`, the package's default entry, which
 * re-exports the AWS runtime class — so both conditions resolve to the class
 * asserted here.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-blocks/core';
import { Logger } from './index.mock.js';
import { Logger as AwsLogger } from './index.aws.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Logger telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'Logger');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('the default entry re-exports the AWS runtime class', () => {
		assert.strictEqual(Logger, AwsLogger);
	});

	test('an instance carries bbName and bbVersion', () => {
		const logger = new Logger({ id: 'app' }, 'logger');
		assert.strictEqual(logger.bbName, BB_NAME);
		assert.strictEqual(logger.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		new Logger({ id: 'app' }, 'logger');
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});

	test('a child logger does not register a second time', () => {
		const logger = new Logger({ id: 'app' }, 'logger');
		logger.child({ requestId: 'r-1' });
		assert.strictEqual(
			Scope.getRegisteredBlocks().blocks.filter(b => b.name === BB_NAME).length,
			1,
		);
	});
});
