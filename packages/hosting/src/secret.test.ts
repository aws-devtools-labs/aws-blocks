// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	config,
	configEnvVarName,
	DEFAULT_CONFIG_PARAMETER_PREFIX,
	DEFAULT_SECRET_PARAMETER_PREFIX,
	decodeManagedValue,
	encodeManagedValue,
	fallbackEnvVarName,
	isConfig,
	isManagedValue,
	isManagedValueJSON,
	isSecret,
	MANAGED_BRAND,
	MANAGED_VALUE_JSON_TAG,
	managedValueReplacer,
	managedValueReviver,
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

void describe('managed value JSON codec', () => {
	void it('a raw JSON round-trip loses the brand (motivates the codec)', () => {
		const roundTripped = JSON.parse(JSON.stringify(secret('TOKEN')));
		assert.strictEqual(isManagedValue(roundTripped), false);
	});

	void it('encode → decode restores a branded secret marker', () => {
		const restored = decodeManagedValue(encodeManagedValue(secret('TOKEN')));
		assert.ok(isSecret(restored));
		assert.strictEqual(restored.key, 'TOKEN');
		assert.strictEqual(restored.kind, 'secret');
	});

	void it('encode → decode restores a branded config marker', () => {
		const restored = decodeManagedValue(encodeManagedValue(config('DOMAIN')));
		assert.ok(isConfig(restored));
		assert.strictEqual(restored.key, 'DOMAIN');
	});

	void it('encoded form is tagged and JSON-safe', () => {
		const encoded = encodeManagedValue(config('DOMAIN'));
		assert.deepStrictEqual(encoded, { [MANAGED_VALUE_JSON_TAG]: { kind: 'config', key: 'DOMAIN' } });
		assert.ok(isManagedValueJSON(JSON.parse(JSON.stringify(encoded))));
	});

	void it('replacer + reviver survive a full JSON.stringify/parse round-trip in a nested object', () => {
		const original = {
			domain: config('DOMAIN'),
			apiKey: secret('API_KEY'),
			plain: 'literal',
			nested: { flags: config('FLAGS') },
		};
		const wire = JSON.stringify(original, managedValueReplacer);
		const restored = JSON.parse(wire, managedValueReviver) as typeof original;

		assert.ok(isConfig(restored.domain) && restored.domain.key === 'DOMAIN');
		assert.ok(isSecret(restored.apiKey) && restored.apiKey.key === 'API_KEY');
		assert.strictEqual(restored.plain, 'literal');
		assert.ok(isConfig(restored.nested.flags) && restored.nested.flags.key === 'FLAGS');
	});

	void it('reviver leaves non-marker values untouched', () => {
		const restored = JSON.parse(JSON.stringify({ a: 1, b: 'x', c: [1, 2] }), managedValueReviver);
		assert.deepStrictEqual(restored, { a: 1, b: 'x', c: [1, 2] });
	});

	void it('isManagedValueJSON rejects malformed shapes', () => {
		assert.strictEqual(isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { kind: 'nope', key: 'K' } }), false);
		assert.strictEqual(isManagedValueJSON({ [MANAGED_VALUE_JSON_TAG]: { kind: 'secret' } }), false);
		assert.strictEqual(isManagedValueJSON({ kind: 'secret', key: 'K' }), false);
		assert.strictEqual(isManagedValueJSON(null), false);
	});
});
