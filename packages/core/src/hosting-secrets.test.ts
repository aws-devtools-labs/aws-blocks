// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { secret } from '@aws-blocks/hosting';
import {
	collectSynthSecretKeys,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
} from './hosting-secrets.js';

void describe('partitionEnvironment()', () => {
	void it('splits plain / runtime-secret / exposeAsEnv', () => {
		const { plain, runtimeSecrets, exposeSecrets } = partitionEnvironment({
			FLAG: 'on',
			STRIPE_KEY: secret('STRIPE_KEY'),
			LEGACY: secret('LEGACY', { exposeAsEnv: true }),
		});
		assert.deepStrictEqual(plain, { FLAG: 'on' });
		assert.deepStrictEqual(
			runtimeSecrets.map((s) => s.key),
			['STRIPE_KEY'],
		);
		assert.deepStrictEqual(
			exposeSecrets.map((s) => s.key),
			['LEGACY'],
		);
	});

	void it('rejects env key / secret key mismatch', () => {
		assert.throws(
			() => partitionEnvironment({ STRIPE_KEY: secret('OTHER') }),
			/must match the environment variable name/,
		);
	});

	void it('handles undefined', () => {
		const { plain, runtimeSecrets, exposeSecrets } = partitionEnvironment(undefined);
		assert.deepStrictEqual(plain, {});
		assert.strictEqual(runtimeSecrets.length, 0);
		assert.strictEqual(exposeSecrets.length, 0);
	});
});

void describe('collectSynthSecretKeys()', () => {
	void it('gathers domain + exposeAsEnv keys, deduped', () => {
		const keys = collectSynthSecretKeys(
			['example.com', secret('DOMAIN_PROD')],
			[secret('LEGACY', { exposeAsEnv: true }), secret('DOMAIN_PROD', { exposeAsEnv: true })],
		);
		assert.deepStrictEqual([...keys].sort(), ['DOMAIN_PROD', 'LEGACY']);
	});

	void it('returns nothing when no synth-time secrets exist', () => {
		assert.deepStrictEqual(collectSynthSecretKeys('example.com', []), []);
		assert.deepStrictEqual(collectSynthSecretKeys(undefined, []), []);
	});
});

void describe('resolveSecretsAtSynth()', () => {
	void it('fetches each referenced key with decryption', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth(['DOMAIN_PROD'], async (name) => {
			seen.push(name);
			return 'prod.example.com';
		});
		assert.deepStrictEqual(seen, ['/blocks/secrets/DOMAIN_PROD']);
		assert.strictEqual(resolved.get('DOMAIN_PROD'), 'prod.example.com');
	});

	void it('throws an actionable error when a secret is not set', async () => {
		await assert.rejects(
			resolveSecretsAtSynth(['DOMAIN_PROD'], async () => {
				const e = new Error('not found');
				e.name = 'ParameterNotFound';
				throw e;
			}),
			/blocks secret set DOMAIN_PROD/,
		);
	});
});

void describe('resolveDomainNames()', () => {
	void it('replaces markers with resolved literals, preserving shape', () => {
		const resolved = new Map([['DOMAIN_PROD', 'prod.example.com']]);
		assert.strictEqual(resolveDomainNames(secret('DOMAIN_PROD'), resolved), 'prod.example.com');
		assert.deepStrictEqual(resolveDomainNames(['www.example.com', secret('DOMAIN_PROD')], resolved), [
			'www.example.com',
			'prod.example.com',
		]);
	});

	void it('throws if a marker reached the sync path unresolved', () => {
		assert.throws(
			() => resolveDomainNames(secret('DOMAIN_PROD'), new Map()),
			/requires async resolution.*Hosting\.create/s,
		);
	});

	void it('passes literal domains through untouched', () => {
		assert.strictEqual(resolveDomainNames('example.com', new Map()), 'example.com');
	});
});
