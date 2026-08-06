// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telemetry-registration tests for AuthBearerJwt.
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
import { AuthBearerJwt } from './index.js';
import { createLocalJwt } from './index.mock.js';
import { BB_NAME, BB_VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Minimal valid block. HS256 keeps construction offline and key-free. */
function createAuth(id = 'auth'): AuthBearerJwt {
	return new AuthBearerJwt({ id: 'app' }, id, {
		issuer: 'https://issuer.example.com',
		hmacSecret: 'local-test-secret',
	});
}

describe('AuthBearerJwt telemetry registration', () => {
	beforeEach(() => {
		Scope._resetRegistry();
	});

	test('BB_NAME is the name the vendorize map and OFFICIAL_BB_NAMES carry', () => {
		assert.strictEqual(BB_NAME, 'AuthBearerJwt');
	});

	test('BB_VERSION tracks the package version', () => {
		const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
		assert.strictEqual(BB_VERSION, pkg.version);
	});

	test('an instance carries bbName and bbVersion', () => {
		const auth = createAuth();
		assert.strictEqual(auth.bbName, BB_NAME);
		assert.strictEqual(auth.bbVersion, BB_VERSION);
	});

	test('registers as an official block, so telemetry is allowed to name it', () => {
		createAuth();
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.filter(b => b.name === BB_NAME),
			[{ name: BB_NAME, version: BB_VERSION }],
		);
		assert.strictEqual(customBlocksCount, 0, 'must not be filtered out as an unnamed custom block');
	});

	test('the local-dev mock registers the same block', () => {
		createLocalJwt({ id: 'app' }, 'auth');
		const { blocks, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.ok(
			blocks.some(b => b.name === BB_NAME && b.version === BB_VERSION),
			`expected ${BB_NAME} in ${JSON.stringify(blocks)}`,
		);
		assert.strictEqual(customBlocksCount, 0);
	});
});
