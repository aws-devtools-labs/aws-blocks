// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	isSecret,
	SECRET_BRAND,
	SECRET_PARAMETER_PREFIX,
	secret,
	secretEnvVarName,
	secretParameterName,
} from './secret.js';

void describe('secret() marker', () => {
	void it('returns a branded marker carrying the key', () => {
		const s = secret('STRIPE_KEY');
		assert.strictEqual(s.key, 'STRIPE_KEY');
		assert.strictEqual(s.exposeAsEnv, false);
		assert.strictEqual(s[SECRET_BRAND], true);
	});

	void it('honors exposeAsEnv', () => {
		assert.strictEqual(secret('K', { exposeAsEnv: true }).exposeAsEnv, true);
		assert.strictEqual(secret('K', { exposeAsEnv: false }).exposeAsEnv, false);
	});

	void it('rejects invalid keys', () => {
		assert.throws(() => secret(''), /invalid key/);
		assert.throws(() => secret('1ABC'), /invalid key/); // can't start with digit
		assert.throws(() => secret('a-b'), /invalid key/); // no dashes
		assert.throws(() => secret('a b'), /invalid key/); // no spaces
		assert.throws(() => secret('a/b'), /invalid key/); // no slashes
		// valid keys do not throw
		assert.ok(secret('_x'));
		assert.ok(secret('DOMAIN_PROD'));
		assert.ok(secret('a1_b2'));
	});
});

void describe('isSecret()', () => {
	void it('accepts only real markers', () => {
		assert.ok(isSecret(secret('K')));
		assert.ok(!isSecret({ key: 'K', exposeAsEnv: false })); // look-alike, no brand
		assert.ok(!isSecret(null));
		assert.ok(!isSecret('K'));
		assert.ok(!isSecret(undefined));
	});
});

void describe('secret path + env naming', () => {
	void it('builds the flat /blocks/secrets/<KEY> path', () => {
		assert.strictEqual(secretParameterName('STRIPE_KEY'), '/blocks/secrets/STRIPE_KEY');
		assert.strictEqual(SECRET_PARAMETER_PREFIX, '/blocks/secrets');
	});

	void it('builds a collision-safe env var name for the injected param name', () => {
		assert.strictEqual(secretEnvVarName('STRIPE_KEY'), 'BLOCKS_SECRET_PARAM_STRIPE_KEY');
	});
});
