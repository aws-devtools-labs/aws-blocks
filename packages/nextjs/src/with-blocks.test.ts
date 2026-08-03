// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BLOCKS_SERVER_EXTERNAL_PACKAGES } from './external-packages.js';
import { withBlocks } from './with-blocks.js';

describe('withBlocks', () => {
	it('adds the Blocks external packages to an empty config', () => {
		const config = withBlocks();
		assert.deepEqual(config.serverExternalPackages, [...BLOCKS_SERVER_EXTERNAL_PACKAGES]);
	});

	it('is a no-op when schema sync is disabled', () => {
		// Also the guard that keeps the rest of this suite free of side effects.
		const config = withBlocks({}, { schema: false });
		assert.deepEqual(config.serverExternalPackages, [...BLOCKS_SERVER_EXTERNAL_PACKAGES]);
	});

	it('does not throw when no migrations directory exists', () => {
		// Schema sync is opt-out, so the common "app with no database" case must be safe.
		assert.doesNotThrow(() => withBlocks({}, { schema: { migrationsPath: './does-not-exist' } }));
	});

	it('preserves every other config key', () => {
		const config = withBlocks({ output: 'standalone', basePath: '/app' });
		assert.equal(config.output, 'standalone');
		assert.equal(config.basePath, '/app');
	});

	it("merges rather than replaces the caller's serverExternalPackages", () => {
		// Replacing the array would silently drop a user's own native dependency.
		const config = withBlocks({ serverExternalPackages: ['my-native-dep'] });
		assert.ok(config.serverExternalPackages?.includes('my-native-dep'));
		for (const pkg of BLOCKS_SERVER_EXTERNAL_PACKAGES) {
			assert.ok(config.serverExternalPackages?.includes(pkg), `missing ${pkg}`);
		}
	});

	it("keeps the caller's entries first", () => {
		const config = withBlocks({ serverExternalPackages: ['a', 'b'] });
		assert.deepEqual(config.serverExternalPackages?.slice(0, 2), ['a', 'b']);
	});

	it('accepts extra externals via options', () => {
		const config = withBlocks({}, { serverExternalPackages: ['extra-dep'] });
		assert.ok(config.serverExternalPackages?.includes('extra-dep'));
	});

	it('deduplicates when a Blocks package is already listed', () => {
		const config = withBlocks({ serverExternalPackages: ['@aws-blocks/bb-data'] });
		const occurrences = config.serverExternalPackages?.filter((p) => p === '@aws-blocks/bb-data');
		assert.equal(occurrences?.length, 1);
	});

	it('does not mutate the input config', () => {
		const input = { serverExternalPackages: ['only-mine'] };
		withBlocks(input);
		assert.deepEqual(input.serverExternalPackages, ['only-mine']);
	});
});
