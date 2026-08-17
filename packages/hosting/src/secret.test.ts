// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	config,
	configEnvVarName,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isSecret,
	MANAGED_BRAND,
	parameterName,
	secret,
	secretEnvVarName,
	secretStoreLocator,
	storeForKind,
} from './secret.js';

void describe('secret() / config() markers', () => {
	void it('secret() → branded marker, kind "secret"', () => {
		const s = secret('STRIPE_KEY');
		assert.strictEqual(s.key, 'STRIPE_KEY');
		assert.strictEqual(s.kind, 'secret');
		assert.strictEqual(s[MANAGED_BRAND], true);
	});

	void it('config() → branded marker, kind "config"', () => {
		const c = config('FEATURE_FLAGS');
		assert.strictEqual(c.key, 'FEATURE_FLAGS');
		assert.strictEqual(c.kind, 'config');
		assert.strictEqual(c[MANAGED_BRAND], true);
	});

	void it('rejects invalid keys (both functions)', () => {
		for (const fn of [secret, config]) {
			assert.throws(() => fn(''), /invalid key/);
			assert.throws(() => fn('1ABC'), /invalid key/);
			assert.throws(() => fn('a-b'), /invalid key/);
			assert.throws(() => fn('a/b'), /invalid key/);
		}
		assert.ok(secret('_x'));
		assert.ok(config('a1_b2'));
	});
});

void describe('type guards', () => {
	void it('isSecret / isConfig / isManagedValue', () => {
		assert.ok(isSecret(secret('K')));
		assert.ok(!isSecret(config('K')));
		assert.ok(isConfig(config('K')));
		assert.ok(!isConfig(secret('K')));
		assert.ok(isManagedValue(secret('K')));
		assert.ok(isManagedValue(config('K')));
		assert.ok(!isManagedValue({ key: 'K', kind: 'secret' })); // look-alike, no brand
		assert.ok(!isManagedValue(null));
		assert.ok(!isManagedValue('K'));
	});
});

void describe('storeForKind — kind → store (single source of truth)', () => {
	void it('secret → Secrets Manager, config → SSM', () => {
		assert.strictEqual(storeForKind('secret'), 'secrets-manager');
		assert.strictEqual(storeForKind('config'), 'ssm');
	});
});

void describe('paths, prefixes, env naming', () => {
	void it('separate default prefixes per kind', () => {
		assert.strictEqual(DEFAULT_SECRET_PARAMETER_PREFIX, '/hosting/secrets');
		assert.strictEqual(DEFAULT_CONFIG_PARAMETER_PREFIX, '/hosting/config');
		assert.strictEqual(parameterName('K', '/blocks/secrets'), '/blocks/secrets/K');
	});

	void it('secret locator (Secrets Manager) is slash-free; config locator (SSM) keeps the slash', () => {
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { prefix: '/blocks/secrets', store: 'secrets-manager' }),
			'blocks/secrets/STRIPE_KEY',
		);
		assert.strictEqual(
			secretStoreLocator('FLAGS', { prefix: '/blocks/config', store: 'ssm' }),
			'/blocks/config/FLAGS',
		);
	});

	void it('stage inserts a segment between prefix and key', () => {
		assert.strictEqual(
			secretStoreLocator('K', { prefix: '/p', store: 'secrets-manager', stage: 'prod' }),
			'p/prod/K',
		);
		assert.strictEqual(secretStoreLocator('K', { prefix: '/p', store: 'ssm', stage: 'beta' }), '/p/beta/K');
	});

	void it('separate env var prefixes per kind + fallback', () => {
		assert.strictEqual(secretEnvVarName('K'), 'HOSTING_SECRET_PARAM_K');
		assert.strictEqual(configEnvVarName('K'), 'HOSTING_CONFIG_PARAM_K');
		assert.strictEqual(fallbackEnvVarName(secretEnvVarName('K')), 'HOSTING_SECRET_PARAM_K_FALLBACK');
	});
});
