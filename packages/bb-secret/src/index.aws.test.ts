// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, mock, test } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { ResourceNotFoundException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Secret } from './index.aws.js';

const TEST_ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:test-AbCdEf';

/**
 * Stub `SecretsManagerClient.send`, recording every command and returning a
 * value derived from the command (so GetSecretValue reads route through a
 * caller-supplied responder). Returns the recorded command inputs + a restore.
 */
function stubSend(responder: (cmd: any) => unknown) {
	const commands: any[] = [];
	const m = mock.method(SecretsManagerClient.prototype, 'send', async (cmd: any) => {
		commands.push(cmd);
		return responder(cmd);
	});
	return { commands, restore: () => m.mock.restore() };
}

/** Count how many of the recorded commands are GetSecretValueCommand. */
function getCalls(commands: any[]): any[] {
	return commands.filter((c) => c.constructor.name === 'GetSecretValueCommand');
}

describe('AWS runtime read cache', () => {
	test('a repeated current read hits the cache — one GetSecretValue call', async () => {
		const { commands, restore } = stubSend(() => ({ SecretString: 'sk-live-1' }));
		try {
			const secret = new Secret(new Scope('app'), 'cache', { secret: Secret.fromExisting(TEST_ARN) });
			const a = await secret.get();
			const b = await secret.get();
			assert.strictEqual(a, 'sk-live-1');
			assert.strictEqual(b, 'sk-live-1');
			assert.strictEqual(getCalls(commands).length, 1, 'second read must be served from cache');
		} finally {
			restore();
		}
	});

	test('different version selectors are cached independently', async () => {
		// Return a value that identifies which version was requested.
		const { commands, restore } = stubSend((cmd) =>
			cmd.input.VersionStage === 'AWSPREVIOUS' ? { SecretString: 'sk-old' } : { SecretString: 'sk-new' },
		);
		try {
			const secret = new Secret(new Scope('app'), 'cache-ver', { secret: Secret.fromExisting(TEST_ARN) });
			assert.strictEqual(await secret.get(), 'sk-new');
			assert.strictEqual(await secret.get({ version: 'previous' }), 'sk-old');
			// Repeat both — still only the two original calls.
			assert.strictEqual(await secret.get(), 'sk-new');
			assert.strictEqual(await secret.get({ version: 'previous' }), 'sk-old');
			assert.strictEqual(getCalls(commands).length, 2, 'current and previous are separate cache entries');
		} finally {
			restore();
		}
	});

	test('a resolved not-found is cached (no repeat call)', async () => {
		const { commands, restore } = stubSend(() => {
			throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
		});
		try {
			const secret = new Secret(new Scope('app'), 'cache-missing', { secret: Secret.fromExisting(TEST_ARN) });
			assert.strictEqual(await secret.get(), null);
			assert.strictEqual(await secret.get(), null);
			assert.strictEqual(getCalls(commands).length, 1, 'the null result must be cached too');
		} finally {
			restore();
		}
	});

	test('put() clears the cache so the next read re-fetches', async () => {
		let current = 'sk-before';
		const { commands, restore } = stubSend((cmd) => {
			if (cmd.constructor.name === 'PutSecretValueCommand') {
				current = cmd.input.SecretString;
				return {};
			}
			return { SecretString: current };
		});
		try {
			const secret = new Secret(new Scope('app'), 'cache-put', { secret: Secret.fromExisting(TEST_ARN) });
			assert.strictEqual(await secret.get(), 'sk-before'); // call 1 (cached)
			assert.strictEqual(await secret.get(), 'sk-before'); // cache hit
			await secret.put('sk-after'); // clears the cache
			assert.strictEqual(await secret.get(), 'sk-after'); // call 2 — re-fetched
			assert.strictEqual(getCalls(commands).length, 2, 'put() must invalidate the cached current value');
		} finally {
			restore();
		}
	});
});

describe('AWS runtime read cache — cacheTtlSeconds', () => {
	test('within the TTL the cache is reused (no second call)', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const { commands, restore } = stubSend(() => ({ SecretString: 'sk-1' }));
		try {
			const secret = new Secret(new Scope('app'), 'ttl-fresh', {
				secret: Secret.fromExisting(TEST_ARN),
				cacheTtlSeconds: 60,
			});
			assert.strictEqual(await secret.get(), 'sk-1'); // call 1
			mock.timers.tick(59_000); // still inside the 60s window
			assert.strictEqual(await secret.get(), 'sk-1'); // cache hit
			assert.strictEqual(getCalls(commands).length, 1, 'a read within the TTL must not re-fetch');
		} finally {
			restore();
			mock.timers.reset();
		}
	});

	test('past the TTL the next read re-fetches and sees the rotated value', async () => {
		mock.timers.enable({ apis: ['Date'] });
		let current = 'sk-old';
		const { commands, restore } = stubSend(() => ({ SecretString: current }));
		try {
			const secret = new Secret(new Scope('app'), 'ttl-expire', {
				secret: Secret.fromExisting(TEST_ARN),
				cacheTtlSeconds: 30,
			});
			assert.strictEqual(await secret.get(), 'sk-old'); // call 1, cached
			current = 'sk-new'; // rotated out-of-band (no put())
			mock.timers.tick(29_000);
			assert.strictEqual(await secret.get(), 'sk-old'); // still within TTL → stale cache
			assert.strictEqual(getCalls(commands).length, 1, 'no re-fetch before the TTL elapses');
			mock.timers.tick(1_001); // cross the 30s boundary
			assert.strictEqual(await secret.get(), 'sk-new'); // re-fetched
			assert.strictEqual(getCalls(commands).length, 2, 'a read past the TTL must re-fetch');
		} finally {
			restore();
			mock.timers.reset();
		}
	});

	test('without cacheTtlSeconds the cache never expires (process-lifetime)', async () => {
		mock.timers.enable({ apis: ['Date'] });
		const { commands, restore } = stubSend(() => ({ SecretString: 'sk-1' }));
		try {
			const secret = new Secret(new Scope('app'), 'ttl-none', { secret: Secret.fromExisting(TEST_ARN) });
			assert.strictEqual(await secret.get(), 'sk-1');
			mock.timers.tick(24 * 60 * 60 * 1000); // a full day later
			assert.strictEqual(await secret.get(), 'sk-1');
			assert.strictEqual(getCalls(commands).length, 1, 'default (no TTL) caches for the life of the process');
		} finally {
			restore();
			mock.timers.reset();
		}
	});
});
