// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { secretEnvVarName } from './secret.js';
import { _resetSecretCache, _setSecretFetcher, getSecret } from './secret-runtime.js';

void describe('getSecret() runtime resolver', () => {
	const envBackup = { ...process.env };

	beforeEach(() => {
		_resetSecretCache();
	});

	afterEach(() => {
		process.env = { ...envBackup };
		_resetSecretCache();
	});

	void it('resolves from process.env first (local dev / exposeAsEnv)', async () => {
		process.env.STRIPE_KEY = 'sk_local_123';
		// Even if a fetcher is set, the env value wins and no fetch happens.
		_setSecretFetcher(async () => {
			throw new Error('should not fetch when env is present');
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'sk_local_123');
	});

	void it('fetches + decrypts via SSM using the injected parameter name', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = '/blocks/secrets/STRIPE_KEY';
		const seen: string[] = [];
		_setSecretFetcher(async (name) => {
			seen.push(name);
			return 'sk_live_decrypted';
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'sk_live_decrypted');
		assert.deepStrictEqual(seen, ['/blocks/secrets/STRIPE_KEY']);
	});

	void it('caches: a second call does not re-fetch', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = '/blocks/secrets/STRIPE_KEY';
		let calls = 0;
		_setSecretFetcher(async () => {
			calls += 1;
			return 'v';
		});
		await getSecret('STRIPE_KEY');
		await getSecret('STRIPE_KEY');
		assert.strictEqual(calls, 1);
	});

	void it('coalesces concurrent calls into one fetch', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = '/blocks/secrets/STRIPE_KEY';
		let calls = 0;
		_setSecretFetcher(async () => {
			calls += 1;
			await new Promise((r) => setTimeout(r, 10));
			return 'v';
		});
		const [a, b] = await Promise.all([getSecret('STRIPE_KEY'), getSecret('STRIPE_KEY')]);
		assert.strictEqual(a, 'v');
		assert.strictEqual(b, 'v');
		assert.strictEqual(calls, 1);
	});

	void it('throws an actionable error when the secret was never wired', async () => {
		delete process.env.MISSING;
		delete process.env[secretEnvVarName('MISSING')];
		await assert.rejects(getSecret('MISSING'), /no secret reference found/);
	});

	void it('passes the store hint to the fetcher (default ssm)', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = '/blocks/secrets/STRIPE_KEY';
		delete process.env[`${secretEnvVarName('STRIPE_KEY')}_STORE`];
		let seenStore = '';
		_setSecretFetcher(async (_locator, store) => {
			seenStore = store;
			return 'v';
		});
		await getSecret('STRIPE_KEY');
		assert.strictEqual(seenStore, 'ssm');
	});

	void it('routes to secrets-manager when the _STORE hint is set', async () => {
		delete process.env.STRIPE_KEY;
		process.env[secretEnvVarName('STRIPE_KEY')] = '/blocks/secrets/STRIPE_KEY';
		process.env[`${secretEnvVarName('STRIPE_KEY')}_STORE`] = 'secrets-manager';
		let seenStore = '';
		_setSecretFetcher(async (_locator, store) => {
			seenStore = store;
			return 'v';
		});
		await getSecret('STRIPE_KEY');
		assert.strictEqual(seenStore, 'secrets-manager');
		delete process.env[`${secretEnvVarName('STRIPE_KEY')}_STORE`];
	});

	// ── per-stage two-try fallback ──────────────────────────────────────────
	void it('falls back to the shared locator when the stage value is not found', async () => {
		delete process.env.STRIPE_KEY;
		const env = secretEnvVarName('STRIPE_KEY');
		process.env[env] = '/blocks/secrets/prod/STRIPE_KEY'; // primary (stage)
		process.env[`${env}_FALLBACK`] = '/blocks/secrets/STRIPE_KEY'; // shared
		const seen: string[] = [];
		_setSecretFetcher(async (locator) => {
			seen.push(locator);
			if (locator === '/blocks/secrets/prod/STRIPE_KEY') {
				const e = new Error('missing');
				e.name = 'ParameterNotFound';
				throw e;
			}
			return 'shared_value';
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'shared_value');
		assert.deepStrictEqual(seen, ['/blocks/secrets/prod/STRIPE_KEY', '/blocks/secrets/STRIPE_KEY']);
		delete process.env[`${env}_FALLBACK`];
	});

	void it('uses the stage value directly when present (no fallback fetch)', async () => {
		delete process.env.STRIPE_KEY;
		const env = secretEnvVarName('STRIPE_KEY');
		process.env[env] = '/blocks/secrets/prod/STRIPE_KEY';
		process.env[`${env}_FALLBACK`] = '/blocks/secrets/STRIPE_KEY';
		const seen: string[] = [];
		_setSecretFetcher(async (locator) => {
			seen.push(locator);
			return 'stage_value';
		});
		assert.strictEqual(await getSecret('STRIPE_KEY'), 'stage_value');
		assert.deepStrictEqual(seen, ['/blocks/secrets/prod/STRIPE_KEY']); // fallback never called
		delete process.env[`${env}_FALLBACK`];
	});

	void it('does NOT fall back on a non-not-found error (surfaces the real error)', async () => {
		delete process.env.STRIPE_KEY;
		const env = secretEnvVarName('STRIPE_KEY');
		process.env[env] = '/blocks/secrets/prod/STRIPE_KEY';
		process.env[`${env}_FALLBACK`] = '/blocks/secrets/STRIPE_KEY';
		_setSecretFetcher(async () => {
			const e = new Error('access denied');
			e.name = 'AccessDeniedException';
			throw e;
		});
		await assert.rejects(getSecret('STRIPE_KEY'), /access denied/);
		delete process.env[`${env}_FALLBACK`];
	});
});
