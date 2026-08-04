// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry-registration tests for AuthBasic.
 *
 * `Scope.getRegisteredBlocks()` only names a block whose `bbName` is in
 * OFFICIAL_BB_NAMES, and that set is generated from the umbrella's
 * `aws-blocks.vendorize` map. These tests pin the three coupled artifacts to
 * each other: the block's generated BB_NAME, its vendorize entry, and the
 * generated name set. A block that omits `bbMeta` still constructs fine and
 * every other test still passes, so that gap is only visible here.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scope } from '@aws-blocks/core';
import { AuthBasic } from './index.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * A fresh AuthBasic under a unique parent scope. AuthBasic composes KVStore and
 * AppSetting, whose mocks key their on-disk state by scope id, so each instance
 * gets its own id to stay isolated.
 */
let counter = 0;
function makeAuth(): AuthBasic {
	const scope = new Scope(`basic-telemetry-${++counter}-${Math.random().toString(36).slice(2, 6)}`);
	return new AuthBasic(scope, 'auth');
}

describe('AuthBasic telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'AuthBasic');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('an instance carries bbName and bbVersion', () => {
		const auth = makeAuth();
		assert.strictEqual(auth.bbName, BB_NAME);
		assert.strictEqual(auth.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		makeAuth();
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});
});
