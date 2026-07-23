// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	DEFAULT_SECRET_PARAMETER_PREFIX,
	DEFAULT_SECRET_STORE,
	isSecret,
	SECRET_BRAND,
	secret,
	secretEnvVarName,
	secretFallbackEnvVarName,
	secretParameterName,
	secretStoreLocator,
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
	void it('uses a framework-neutral default prefix (no Blocks branding in the leaf)', () => {
		assert.strictEqual(DEFAULT_SECRET_PARAMETER_PREFIX, '/hosting/secrets');
		assert.strictEqual(secretParameterName('STRIPE_KEY'), '/hosting/secrets/STRIPE_KEY');
	});

	void it('accepts an injected prefix so consumers pin their own namespace', () => {
		assert.strictEqual(secretParameterName('STRIPE_KEY', '/blocks/secrets'), '/blocks/secrets/STRIPE_KEY');
	});

	void it('builds a framework-neutral, collision-safe env var name', () => {
		assert.strictEqual(secretEnvVarName('STRIPE_KEY'), 'HOSTING_SECRET_PARAM_STRIPE_KEY');
	});
});

void describe('store default + store-aware locator', () => {
	void it('defaults to Secrets Manager (AWS guidance: SM for application secrets/credentials)', () => {
		assert.strictEqual(DEFAULT_SECRET_STORE, 'secrets-manager');
	});

	void it('the no-store locator matches the DEFAULT store form (guards the default flip)', () => {
		// Assert against DEFAULT_SECRET_STORE rather than a hard-coded store, so
		// this stays correct whichever way the default points.
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY'),
			secretStoreLocator('STRIPE_KEY', { store: DEFAULT_SECRET_STORE }),
		);
	});

	void it('SM locator is the slash-free name (matches created secret + IAM ARN resource)', () => {
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { store: 'secrets-manager' }),
			'hosting/secrets/STRIPE_KEY',
		);
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { prefix: '/blocks/secrets', store: 'secrets-manager' }),
			'blocks/secrets/STRIPE_KEY',
		);
	});

	void it('SSM locator keeps the leading-slash path form', () => {
		assert.strictEqual(secretStoreLocator('STRIPE_KEY', { store: 'ssm' }), '/hosting/secrets/STRIPE_KEY');
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm' }),
			'/blocks/secrets/STRIPE_KEY',
		);
	});
});

void describe('per-stage locator', () => {
	void it('inserts the stage as a path segment between prefix and key', () => {
		// SM (slash-free)
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { store: 'secrets-manager', stage: 'prod' }),
			'hosting/secrets/prod/STRIPE_KEY',
		);
		// SSM (leading-slash path)
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { store: 'ssm', stage: 'beta' }),
			'/hosting/secrets/beta/STRIPE_KEY',
		);
		// custom prefix + stage
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { prefix: '/blocks/secrets', store: 'ssm', stage: 'prod' }),
			'/blocks/secrets/prod/STRIPE_KEY',
		);
	});

	void it('omitting stage yields the shared/flat locator (the fallback target)', () => {
		assert.strictEqual(
			secretStoreLocator('STRIPE_KEY', { store: 'secrets-manager' }),
			'hosting/secrets/STRIPE_KEY',
		);
	});

	void it('fallback env var name derives from the primary env var name', () => {
		assert.strictEqual(secretFallbackEnvVarName('STRIPE_KEY'), 'HOSTING_SECRET_PARAM_STRIPE_KEY_FALLBACK');
		assert.strictEqual(`${secretEnvVarName('X')}_FALLBACK`, secretFallbackEnvVarName('X'));
	});
});
