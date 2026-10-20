// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { config, secret } from '@aws-blocks/hosting';
import {
	collectSynthMarkers,
	partitionEnvironment,
	resolveDomainNames,
	resolveSecretsAtSynth,
} from './hosting-secrets.js';

void describe('partitionEnvironment()', () => {
	void it('splits plain / managed (secret+config)', () => {
		const { plain, managed } = partitionEnvironment({
			FLAG: 'on',
			STRIPE_KEY: secret('STRIPE_KEY'),
			FEATURE_FLAGS: config('FEATURE_FLAGS'),
		});
		assert.deepStrictEqual(plain, { FLAG: 'on' });
		assert.deepStrictEqual(managed.map((m) => `${m.key}:${m.kind}`).sort(), [
			'FEATURE_FLAGS:config',
			'STRIPE_KEY:secret',
		]);
	});

	void it('rejects env key / marker key mismatch', () => {
		assert.throws(
			() => partitionEnvironment({ STRIPE_KEY: secret('OTHER') }),
			/must match the environment variable name/,
		);
	});

	void it('handles undefined', () => {
		const { plain, managed, byo } = partitionEnvironment(undefined);
		assert.deepStrictEqual(plain, {});
		assert.strictEqual(managed.length, 0);
		assert.strictEqual(byo.length, 0);
	});
});

void describe('collectSynthMarkers()', () => {
	void it('gathers domain markers, deduped by key', () => {
		const markers = collectSynthMarkers(['example.com', config('DOMAIN_PROD'), config('DOMAIN_PROD')]);
		assert.deepStrictEqual(
			markers.map((m) => m.key),
			['DOMAIN_PROD'],
		);
	});
	void it('returns nothing when no markers', () => {
		assert.deepStrictEqual(collectSynthMarkers('example.com'), []);
		assert.deepStrictEqual(collectSynthMarkers(undefined), []);
	});
});

void describe('resolveSecretsAtSynth() — Blocks namespaces', () => {
	void it('config marker resolves under /blocks/config (SSM leading-slash)', async () => {
		const seen: string[] = [];
		const resolved = await resolveSecretsAtSynth([config('DOMAIN_PROD')], async (name) => {
			seen.push(name);
			return 'prod.example.com';
		});
		assert.deepStrictEqual(seen, ['/blocks/config/DOMAIN_PROD']);
		assert.strictEqual(resolved.get('DOMAIN_PROD'), 'prod.example.com');
	});

	void it('secret marker resolves under /blocks/secrets (Secrets Manager slash-free)', async () => {
		const seen: string[] = [];
		await resolveSecretsAtSynth([secret('API_KEY')], async (name) => {
			seen.push(name);
			return 'k';
		});
		assert.deepStrictEqual(seen, ['blocks/secrets/API_KEY']);
	});

	void it('throws an actionable error when a value is not set', async () => {
		await assert.rejects(
			resolveSecretsAtSynth([config('DOMAIN_PROD')], async () => {
				const e = new Error('not found');
				e.name = 'ParameterNotFound';
				throw e;
			}),
			/config 'DOMAIN_PROD' is referenced/,
		);
	});
});

void describe('resolveDomainNames()', () => {
	void it('replaces markers with resolved literals, preserving shape', () => {
		const resolved = new Map([['DOMAIN_PROD', 'prod.example.com']]);
		assert.strictEqual(resolveDomainNames(config('DOMAIN_PROD'), resolved), 'prod.example.com');
		assert.deepStrictEqual(resolveDomainNames(['www.example.com', config('DOMAIN_PROD')], resolved), [
			'www.example.com',
			'prod.example.com',
		]);
	});

	void it('throws if a marker reached the sync path unresolved', () => {
		assert.throws(() => resolveDomainNames(config('DOMAIN_PROD'), new Map()), /requires async resolution/);
	});

	void it('passes literal domains through untouched', () => {
		assert.strictEqual(resolveDomainNames('example.com', new Map()), 'example.com');
	});
});
