// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { parameterName } from '@aws-blocks/hosting/secret';
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
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY'), '/blocks/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS'), '/blocks/config/FEATURE_FLAGS');
	});

	void it('is exactly the neutral engine + the Blocks prefixes (no divergent logic)', () => {
		assert.strictEqual(blocksSecretParameterName('K'), parameterName('K', BLOCKS_SECRET_PARAMETER_PREFIX));
		assert.strictEqual(blocksConfigParameterName('K'), parameterName('K', BLOCKS_CONFIG_PARAMETER_PREFIX));
	});

	void it('blocksStoreConfig() wires both pinned prefixes for the shared engine', () => {
		assert.deepStrictEqual(blocksStoreConfig(), {
			secretStore: { prefix: '/blocks/secrets' },
			configStore: { prefix: '/blocks/config' },
		});
	});
});
