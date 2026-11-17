// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime tests for `frameworkKey()`: `get()` reads the store the stack was
 * synthesized with, and never the other one.
 *
 * Run with `--conditions=aws-runtime` (see the package `test` script) so the
 * nested `AppSetting` resolves to its SSM implementation.
 */
import assert from 'node:assert';
import { afterEach, mock, test } from 'node:test';
import { _resetConfigCache, isBlocksError, loadConfigToProcessEnv, Scope } from '@aws-blocks/core';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretErrors } from '../errors.js';
import { frameworkKey } from '../internal.aws.js';
import { secretArnConfigKey } from '../internal-shared.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:BlocksKey-AbCdEf';
const ENV_KEY = secretArnConfigKey('app-signing-key');

interface Recorded {
	name: string;
	input: Record<string, unknown>;
}

function stubClients(responses: { sm?: () => unknown; ssm?: () => unknown }) {
	const sm: Recorded[] = [];
	const ssm: Recorded[] = [];
	const smMock = mock.method(
		SecretsManagerClient.prototype,
		'send',
		async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			sm.push({ name: cmd.constructor.name, input: cmd.input });
			if (!responses.sm) throw new Error('Secrets Manager must not be called in this mode');
			return responses.sm();
		},
	);
	const ssmMock = mock.method(
		SSMClient.prototype,
		'send',
		async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			ssm.push({ name: cmd.constructor.name, input: cmd.input });
			if (!responses.ssm) throw new Error('SSM must not be called in this mode');
			return responses.ssm();
		},
	);
	return {
		sm,
		ssm,
		restore: () => {
			smMock.mock.restore();
			ssmMock.mock.restore();
		},
	};
}

afterEach(() => {
	delete process.env[ENV_KEY];
});

test('secrets-manager stack: get() reads Secrets Manager by the ARN in config, never SSM', async () => {
	process.env[ENV_KEY] = ARN;
	const stubs = stubClients({ sm: () => ({ SecretString: 'k'.repeat(64) }) });
	try {
		const value = await frameworkKey(new Scope('app'), 'signing-key').get();
		assert.strictEqual(value, 'k'.repeat(64));
		assert.deepStrictEqual(
			stubs.sm.map((c) => [c.name, c.input.SecretId]),
			[['GetSecretValueCommand', ARN]],
		);
		assert.strictEqual(stubs.ssm.length, 0);
	} finally {
		stubs.restore();
	}
});

test('ssm stack: get() reads the SSM SecureString AppSetting reads today, never Secrets Manager', async () => {
	const stubs = stubClients({ ssm: () => ({ Parameter: { Value: 'legacy-base64url-key' } }) });
	try {
		const value = await frameworkKey(new Scope('app'), 'signing-key').get();
		assert.strictEqual(value, 'legacy-base64url-key');
		assert.deepStrictEqual(
			stubs.ssm.map((c) => [c.name, c.input.Name, c.input.WithDecryption]),
			[['GetParameterCommand', '/app-signing-key', true]],
		);
		assert.strictEqual(stubs.sm.length, 0);
	} finally {
		stubs.restore();
	}
});

test('secrets-manager stack: a failed Secrets Manager read is not retried against SSM', async () => {
	process.env[ENV_KEY] = ARN;
	const stubs = stubClients({
		sm: () => {
			const err = new Error('denied');
			err.name = 'AccessDeniedException';
			throw err;
		},
	});
	try {
		await assert.rejects(frameworkKey(new Scope('app'), 'signing-key').get(), /denied/);
		assert.strictEqual(stubs.ssm.length, 0);
	} finally {
		stubs.restore();
	}
});

test('secrets-manager stack: an empty secret throws SecretNotFound', async () => {
	process.env[ENV_KEY] = ARN;
	const stubs = stubClients({ sm: () => ({}) });
	try {
		await assert.rejects(frameworkKey(new Scope('app'), 'signing-key').get(), (e: unknown) =>
			isBlocksError(e, SecretErrors.SecretNotFound),
		);
	} finally {
		stubs.restore();
	}
});

test('the store is chosen per key: another key without an ARN stays on SSM', async () => {
	process.env[ENV_KEY] = ARN;
	const stubs = stubClients({
		sm: () => ({ SecretString: 'from-secrets-manager' }),
		ssm: () => ({ Parameter: { Value: 'from-ssm' } }),
	});
	try {
		assert.strictEqual(await frameworkKey(new Scope('app'), 'signing-key').get(), 'from-secrets-manager');
		assert.strictEqual(await frameworkKey(new Scope('app'), 'other-secret').get(), 'from-ssm');
	} finally {
		stubs.restore();
	}
});

// ── Stale config: reload once on a failed SSM read ──────────────────────────

const OLD_CONFIG = { BLOCKS_SSM_PARAM_SIGNING_KEY: '/app-signing-key' };
const NEW_CONFIG = { [ENV_KEY]: ARN };

/**
 * Simulate deployed compute: config coordinates set, and S3 serving each
 * `bodies` entry in turn (the last one repeats). Returns the GetObject count.
 */
async function deployedWithConfig(...bodies: Record<string, string>[]) {
	process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
	process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';
	_resetConfigCache();
	let gets = 0;
	const s3 = mock.method(S3Client.prototype, 'send', async () => {
		const body = bodies[Math.min(gets, bodies.length - 1)];
		gets += 1;
		return { Body: { transformToString: async () => JSON.stringify(body) } };
	});
	await loadConfigToProcessEnv();
	return {
		gets: () => gets,
		restore: () => {
			s3.mock.restore();
			for (const k of [
				'BLOCKS_CONFIG_BUCKET',
				'BLOCKS_CONFIG_KEY',
				...Object.keys(OLD_CONFIG),
				...Object.keys(NEW_CONFIG),
			]) {
				delete process.env[k];
			}
			_resetConfigCache();
		},
	};
}

function accessDenied(): Error {
	const err = new Error('User is not authorized to perform: ssm:GetParameter');
	err.name = 'AccessDeniedException';
	return err;
}

test('stale config: an SSM failure reloads the config, finds the ARN and reads Secrets Manager', async () => {
	const s3 = await deployedWithConfig(OLD_CONFIG, NEW_CONFIG);
	const stubs = stubClients({
		ssm: () => {
			throw accessDenied();
		},
		sm: () => ({ SecretString: 'from-secrets-manager' }),
	});
	try {
		assert.strictEqual(process.env[ENV_KEY], undefined, 'the cold-start config has no ARN');
		assert.strictEqual(await frameworkKey(new Scope('app'), 'signing-key').get(), 'from-secrets-manager');
		assert.strictEqual(s3.gets(), 2, 'cold start + one reload');
		assert.strictEqual(stubs.ssm.length, 1, 'no second SSM call');
		assert.deepStrictEqual(
			stubs.sm.map((c) => c.input.SecretId),
			[ARN],
		);
		// Later calls go straight to Secrets Manager.
		await frameworkKey(new Scope('app'), 'signing-key').get();
		assert.strictEqual(stubs.ssm.length, 1);
		assert.strictEqual(s3.gets(), 2);
	} finally {
		stubs.restore();
		s3.restore();
	}
});

test('stale config: no ARN after the reload rethrows the original SSM error, after exactly one reload', async () => {
	const s3 = await deployedWithConfig(OLD_CONFIG);
	const original = accessDenied();
	const stubs = stubClients({
		ssm: () => {
			throw original;
		},
	});
	try {
		await assert.rejects(frameworkKey(new Scope('app'), 'signing-key').get(), (e: unknown) => e === original);
		assert.strictEqual(s3.gets(), 2, 'cold start + one reload');
		assert.strictEqual(stubs.ssm.length, 1, 'one SSM read, no retry');
		assert.strictEqual(stubs.sm.length, 0);
	} finally {
		stubs.restore();
		s3.restore();
	}
});

test('stale config: concurrent failures share one reload, and a failure inside the interval does not reload', async () => {
	const s3 = await deployedWithConfig(OLD_CONFIG);
	const stubs = stubClients({
		ssm: () => {
			throw accessDenied();
		},
	});
	try {
		const key = frameworkKey(new Scope('app'), 'signing-key');
		const results = await Promise.allSettled([
			key.get(),
			key.get(),
			frameworkKey(new Scope('app'), 'signing-key').get(),
		]);
		assert.deepStrictEqual(
			results.map((r) => r.status),
			['rejected', 'rejected', 'rejected'],
		);
		assert.strictEqual(s3.gets(), 2, 'three failing calls, one shared reload');

		await assert.rejects(key.get(), /not authorized/);
		assert.strictEqual(s3.gets(), 2, 'a failure inside the interval does not reload again');
	} finally {
		stubs.restore();
		s3.restore();
	}
});

test('stale config: a successful SSM read never reloads the config', async () => {
	const s3 = await deployedWithConfig(OLD_CONFIG);
	const stubs = stubClients({ ssm: () => ({ Parameter: { Value: 'legacy-key' } }) });
	try {
		assert.strictEqual(await frameworkKey(new Scope('app'), 'signing-key').get(), 'legacy-key');
		assert.strictEqual(s3.gets(), 1, 'cold start only');
	} finally {
		stubs.restore();
		s3.restore();
	}
});

test('a Secrets Manager failure is rethrown with no reload and no SSM call', async () => {
	const s3 = await deployedWithConfig(NEW_CONFIG);
	const stubs = stubClients({
		sm: () => {
			const err = new Error('Rate exceeded');
			err.name = 'ThrottlingException';
			throw err;
		},
	});
	try {
		assert.strictEqual(process.env[ENV_KEY], ARN);
		await assert.rejects(frameworkKey(new Scope('app'), 'signing-key').get(), /Rate exceeded/);
		assert.strictEqual(s3.gets(), 1, 'no reload');
		assert.strictEqual(stubs.ssm.length, 0, 'no SSM fallback');
	} finally {
		stubs.restore();
		s3.restore();
	}
});
