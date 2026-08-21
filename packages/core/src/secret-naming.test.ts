// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { secretStoreLocator } from '@aws-blocks/hosting/secret';
import {
	BLOCKS_CONFIG_PARAMETER_PREFIX,
	BLOCKS_SECRET_PARAMETER_PREFIX,
	blocksConfigParameterName,
	blocksConfigPrefix,
	blocksSecretParameterName,
	blocksSecretPrefix,
	blocksStoreConfig,
} from './secret-naming.js';

// These run with no `.blocks/config.json` in cwd, so they exercise the UNSCOPED
// fallback. A real Blocks app has the file, so it gets the `stackId`-scoped path
// (covered by the explicit-stackId cases below).
void describe('Blocks value namespaces — fallback (no .blocks/config.json)', () => {
	void it('falls back to the unscoped /blocks/secrets and /blocks/config bases', () => {
		assert.strictEqual(BLOCKS_SECRET_PARAMETER_PREFIX, '/blocks/secrets');
		assert.strictEqual(BLOCKS_CONFIG_PARAMETER_PREFIX, '/blocks/config');
		// Secrets Manager names are slash-free at the root; SSM keeps the leading slash.
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY'), 'blocks/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS'), '/blocks/config/FEATURE_FLAGS');
		assert.deepStrictEqual(blocksStoreConfig(), {
			secretStore: { prefix: '/blocks/secrets' },
			configStore: { prefix: '/blocks/config' },
		});
	});

	void it('matches the store locator the CLI/grant/runtime actually use (no divergent name)', () => {
		assert.strictEqual(
			blocksSecretParameterName('K'),
			secretStoreLocator('K', { prefix: BLOCKS_SECRET_PARAMETER_PREFIX, store: 'secrets-manager' }),
		);
		assert.strictEqual(
			blocksConfigParameterName('K'),
			secretStoreLocator('K', { prefix: BLOCKS_CONFIG_PARAMETER_PREFIX, store: 'ssm' }),
		);
	});
});

void describe('Blocks value namespaces — stackId-scoped (B5)', () => {
	void it('scopes the prefix by stackId so two apps in one account never collide', () => {
		assert.strictEqual(blocksSecretPrefix('myapp'), '/blocks/myapp/secrets');
		assert.strictEqual(blocksConfigPrefix('myapp'), '/blocks/myapp/config');
		assert.deepStrictEqual(blocksStoreConfig('myapp'), {
			secretStore: { prefix: '/blocks/myapp/secrets' },
			configStore: { prefix: '/blocks/myapp/config' },
		});
	});

	void it('scoped store names match secretStoreLocator (SM slash-free, SSM leading-slash)', () => {
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY', 'myapp'), 'blocks/myapp/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS', 'myapp'), '/blocks/myapp/config/FEATURE_FLAGS');
	});
});
