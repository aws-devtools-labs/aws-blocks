// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { secretParameterName } from '@aws-blocks/hosting/secret';
import { BLOCKS_SECRET_PARAMETER_PREFIX, blocksSecretParameterName } from './secret-naming.js';

void describe('Blocks secret namespace', () => {
	void it('pins the Blocks /blocks/secrets prefix (unchanged behavior for Blocks users)', () => {
		assert.strictEqual(BLOCKS_SECRET_PARAMETER_PREFIX, '/blocks/secrets');
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY'), '/blocks/secrets/STRIPE_KEY');
	});

	void it('is exactly the neutral engine + the Blocks prefix (no divergent logic)', () => {
		assert.strictEqual(
			blocksSecretParameterName('DOMAIN_PROD'),
			secretParameterName('DOMAIN_PROD', BLOCKS_SECRET_PARAMETER_PREFIX),
		);
	});
});
