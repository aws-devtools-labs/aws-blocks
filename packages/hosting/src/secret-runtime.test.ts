// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { configEnvVarName, secretEnvVarName } from './secret.js';
import { _resetSecretCache, _setSecretFetcher, getConfig, getSecret } from './secret-runtime.js';

void describe('getSecret() / getConfig() runtime resolvers', () => {
	const envBackup = { ...process.env };
	beforeEach(() => _resetSecretCache());
	afterEach(() => {
		process.env = { ...envBackup };
		_resetSecretCache();
	});

	void it('resolves from process.env first (local dev)', async () => {
		process.env.STRIPE_KEY = 'sk_local';
		_setSecretFetcher(async () => {
			throw new Error('should not fetch when env is present');
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'sk_local');
	});

	void it('getSecret fetches from Secrets Manager via HOSTING_SECRET_PARAM_*', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = 'blocks/secrets/STRIPE_KEY';
		const seen: Array<[string, string]> = [];
		_setSecretFetcher(async (loc, store) => {
			seen.push([loc, store]);
			return 'sk_live';
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'sk_live');
		assert.deepStrictEqual(seen, [['blocks/secrets/STRIPE_KEY', 'secrets-manager']]);
	});

	void it('getConfig fetches from SSM via HOSTING_CONFIG_PARAM_*', async () => {
		delete process.env.FLAGS;
		process.env[configEnvVarName('FLAGS')] = '/blocks/config/FLAGS';
		const seen: Array<[string, string]> = [];
		_setSecretFetcher(async (loc, store) => {
			seen.push([loc, store]);
			return '{"a":1}';
		});
		assert.strictEqual(await getConfig('FLAGS'), '{"a":1}');
		assert.deepStrictEqual(seen, [['/blocks/config/FLAGS', 'ssm']]);
	});

	void it('secret and config namespaces are independent (same key, different stores)', async () => {
		delete process.env.K;
		process.env[secretEnvVarName('K')] = 'p/secrets/K';
		process.env[configEnvVarName('K')] = '/p/config/K';
		_setSecretFetcher(async (_loc, store) => (store === 'secrets-manager' ? 'the-secret' : 'the-config'));
		assert.strictEqual(await getSecret('K'), 'the-secret');
		assert.strictEqual(await getConfig('K'), 'the-config');
	});

	void it('caches (second call does not re-fetch)', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = 'blocks/secrets/STRIPE_KEY';
		let calls = 0;
		_setSecretFetcher(async () => {
			calls += 1;
			return 'v';
		});
		await getSecret('STRIPE_KEY');
		await getSecret('STRIPE_KEY');
		assert.strictEqual(calls, 1);
	});

	void it('throws an actionable error naming the function + getter when unwired', async () => {
		delete process.env.MISSING;
		delete process.env[secretEnvVarName('MISSING')];
		await assert.rejects(getSecret('MISSING'), /getSecret\("MISSING"\): no secret reference found/);
		await assert.rejects(getConfig('MISSING'), /getConfig\("MISSING"\): no config reference found/);
	});

	void it('falls back to the shared locator on a stage not-found', async () => {
		delete process.env.STRIPE_KEY;
		const env = secretEnvVarName('STRIPE_KEY');
		process.env[env] = 'p/secrets/prod/STRIPE_KEY';
		process.env[`${env}_FALLBACK`] = 'p/secrets/STRIPE_KEY';
		const seen: string[] = [];
		_setSecretFetcher(async (loc) => {
			seen.push(loc);
			if (loc === 'p/secrets/prod/STRIPE_KEY') {
				const e = new Error('missing');
				e.name = 'ResourceNotFoundException';
				throw e;
			}
			return 'shared';
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'shared');
		assert.deepStrictEqual(seen, ['p/secrets/prod/STRIPE_KEY', 'p/secrets/STRIPE_KEY']);
	});

	void it('re-fetches after the per-kind TTL elapses', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = 'p/secrets/STRIPE_KEY';
		process.env.HOSTING_SECRET_CACHE_TTL = '1';
		let calls = 0;
		_setSecretFetcher(async () => {
			calls += 1;
			return `v${calls}`;
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'v1');
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'v1');
		await new Promise((r) => setTimeout(r, 1100));
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'v2');
		assert.strictEqual(calls, 2);
	});
});
