// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { secretStoreLocator } from '@aws-blocks/hosting/secret';
import {
	BLOCKS_CONFIG_PARAMETER_PREFIX,
	BLOCKS_SECRET_PARAMETER_PREFIX,
	blocksConfigParameterName,
	blocksSecretParameterName,
	blocksStoreConfig,
} from './secret-naming.js';

void describe('Blocks value namespaces', () => {
	void it('pins /blocks/secrets (Secrets Manager) and /blocks/config (SSM)', () => {
		assert.strictEqual(BLOCKS_SECRET_PARAMETER_PREFIX, '/blocks/secrets');
		assert.strictEqual(BLOCKS_CONFIG_PARAMETER_PREFIX, '/blocks/config');
		// Secrets Manager names are slash-free at the root; SSM keeps the leading slash.
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY'), 'blocks/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS'), '/blocks/config/FEATURE_FLAGS');
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

	void it('blocksStoreConfig() wires both pinned prefixes for the shared engine', () => {
		assert.deepStrictEqual(blocksStoreConfig(), {
			secretStore: { prefix: '/blocks/secrets' },
			configStore: { prefix: '/blocks/config' },
		});
	});
});
