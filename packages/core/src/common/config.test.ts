// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { getConfig, getConfigSync, loadConfigToProcessEnv, preloadConfig, _resetConfigCache, _setS3Fetcher } from './config.js';

beforeEach(() => {
	_resetConfigCache();
	delete process.env.BLOCKS_CONFIG_BUCKET;
	delete process.env.BLOCKS_CONFIG_KEY;
});

afterEach(() => {
	_resetConfigCache();
	delete process.env.BLOCKS_CONFIG_BUCKET;
	delete process.env.BLOCKS_CONFIG_KEY;
});

describe('config — no S3 env vars (local dev)', () => {
	it('getConfig returns empty string when key not in env', async () => {
		const result = await getConfig('SOME_KEY');
		assert.strictEqual(result, '');
	});

	it('getConfig returns env var value when set', async () => {
		process.env.MY_KEY = 'my-value';
		const result = await getConfig('MY_KEY');
		assert.strictEqual(result, 'my-value');
		delete process.env.MY_KEY;
	});

	it('loadConfigToProcessEnv does not throw when no S3 vars', async () => {
		await assert.doesNotReject(() => loadConfigToProcessEnv());
	});

	it('preloadConfig does not throw when no S3 vars', async () => {
		await assert.doesNotReject(() => preloadConfig());
	});

	it('getConfigSync returns env var value', () => {
		process.env.SYNC_KEY = 'sync-value';
		const result = getConfigSync('SYNC_KEY');
		assert.strictEqual(result, 'sync-value');
		delete process.env.SYNC_KEY;
	});

	it('getConfigSync returns empty string for unknown key', () => {
		const result = getConfigSync('UNKNOWN');
		assert.strictEqual(result, '');
	});
});

describe('config — S3 load success', () => {
	it('loads config from S3 and caches it', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		let callCount = 0;
		_setS3Fetcher(async () => {
			callCount++;
			return JSON.stringify({ DB_URL: 'postgres://localhost', QUEUE_ARN: 'arn:aws:sqs:us-east-1:123:queue' });
		});

		const result = await getConfig('DB_URL');
		assert.strictEqual(result, 'postgres://localhost');

		const result2 = await getConfig('QUEUE_ARN');
		assert.strictEqual(result2, 'arn:aws:sqs:us-east-1:123:queue');

		assert.strictEqual(callCount, 1, 'S3 should only be called once (cached)');
	});

	it('loadConfigToProcessEnv injects values into process.env', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => JSON.stringify({ INJECTED_KEY: 'injected-value' }));

		await loadConfigToProcessEnv();
		assert.strictEqual(process.env.INJECTED_KEY, 'injected-value');
		delete process.env.INJECTED_KEY;
	});

	it('loadConfigToProcessEnv does not override existing env vars', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';
		process.env.EXISTING_KEY = 'original';

		_setS3Fetcher(async () => JSON.stringify({ EXISTING_KEY: 'from-s3' }));

		await loadConfigToProcessEnv();
		assert.strictEqual(process.env.EXISTING_KEY, 'original');
		delete process.env.EXISTING_KEY;
	});

	it('getConfigSync returns cached value after load', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => JSON.stringify({ CACHED_KEY: 'cached-value' }));

		await preloadConfig();
		const result = getConfigSync('CACHED_KEY');
		assert.strictEqual(result, 'cached-value');
	});
});

describe('config — S3 errors', () => {
	it('gracefully handles NoSuchKey (file not yet written)', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		const noSuchKeyError = new Error('The specified key does not exist.');
		(noSuchKeyError as any).name = 'NoSuchKey';
		_setS3Fetcher(async () => { throw noSuchKeyError; });

		const result = await getConfig('ANY_KEY');
		assert.strictEqual(result, '', 'Should return empty string (empty config) on NoSuchKey');
	});

	it('gracefully handles S3 404 status code', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		const notFoundError = new Error('Not Found');
		(notFoundError as any).$metadata = { httpStatusCode: 404 };
		_setS3Fetcher(async () => { throw notFoundError; });

		const result = await getConfig('ANY_KEY');
		assert.strictEqual(result, '', 'Should return empty string (empty config) on 404');
	});

	it('does not cache a not-found result — a later call re-fetches once the config exists', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		// Simulate the transient post-deploy window: the object isn't written yet on the first
		// fetch, then becomes available. A not-found result must NOT be cached, or the container
		// would be poisoned with empty config for its lifetime.
		let call = 0;
		const notFound = new Error('The specified key does not exist.');
		(notFound as any).name = 'NoSuchKey';
		_setS3Fetcher(async () => {
			call++;
			if (call === 1) throw notFound;
			return JSON.stringify({ READY_KEY: 'ready-value' });
		});

		assert.strictEqual(await getConfig('READY_KEY'), '', 'first call sees the not-yet-written config as empty');
		assert.strictEqual(await getConfig('READY_KEY'), 'ready-value', 'later call re-fetches once the config exists');
		assert.strictEqual(call, 2, 'a not-found result must not be cached — S3 is retried');
	});

	it('throws with clear message on S3 network error', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => { throw new Error('Network timeout'); });

		await assert.rejects(
			() => getConfig('ANY_KEY'),
			(err: Error) => {
				assert.ok(err.message.includes('[Blocks] Failed to load config from S3'));
				assert.ok(err.message.includes('test-bucket/blocks-config.json'));
				assert.ok(err.message.includes('Network timeout'));
				return true;
			},
		);
	});

	it('throws on empty config file', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => { throw new Error('Empty config file'); });

		await assert.rejects(
			() => getConfig('ANY_KEY'),
			(err: Error) => {
				assert.ok(err.message.includes('[Blocks] Failed to load config from S3'));
				assert.ok(err.message.includes('Empty config file'));
				return true;
			},
		);
	});

	it('throws on malformed JSON', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => 'not valid json {{{');

		await assert.rejects(
			() => getConfig('ANY_KEY'),
			(err: Error) => {
				assert.ok(err.message.includes('[Blocks] Failed to load config from S3'));
				return true;
			},
		);
	});

	it('throws when config is an array instead of object', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => '["not", "an", "object"]');

		await assert.rejects(
			() => getConfig('ANY_KEY'),
			(err: Error) => {
				assert.ok(err.message.includes('[Blocks] Config file must be a JSON object'));
				return true;
			},
		);
	});

	it('throws when config is null', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		_setS3Fetcher(async () => 'null');

		await assert.rejects(
			() => getConfig('ANY_KEY'),
			(err: Error) => {
				assert.ok(err.message.includes('[Blocks] Config file must be a JSON object'));
				return true;
			},
		);
	});
});

describe('config — concurrent access', () => {
	it('deduplicates concurrent calls to the same S3 fetch', async () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';

		let callCount = 0;
		_setS3Fetcher(async () => {
			callCount++;
			await new Promise(r => setTimeout(r, 50));
			return JSON.stringify({ KEY_A: 'value-a' });
		});

		const [r1, r2, r3] = await Promise.all([
			getConfig('KEY_A'),
			getConfig('KEY_A'),
			getConfig('KEY_A'),
		]);

		assert.strictEqual(r1, 'value-a');
		assert.strictEqual(r2, 'value-a');
		assert.strictEqual(r3, 'value-a');
		assert.strictEqual(callCount, 1, 'S3 should only be called once even with concurrent access');
	});
});
