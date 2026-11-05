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

test('upgrade window: the S3 config is the previous one (no ARN) but the env var is set, so get() reads Secrets Manager', async () => {
	// The compute update carries the env var; the config object it loads at
	// cold start can still be the previous deploy's, which only names the SSM
	// parameter.
	process.env[ENV_KEY] = ARN;
	process.env.BLOCKS_CONFIG_BUCKET = 'config-bucket';
	process.env.BLOCKS_CONFIG_KEY = 'blocks-config.json';
	_resetConfigCache();
	const s3 = mock.method(S3Client.prototype, 'send', async () => ({
		Body: { transformToString: async () => JSON.stringify({ BLOCKS_SSM_PARAM_SIGNING_KEY: '/app-signing-key' }) },
	}));
	const stubs = stubClients({ sm: () => ({ SecretString: 'from-secrets-manager' }) });
	try {
		await loadConfigToProcessEnv();
		assert.strictEqual(process.env.BLOCKS_SSM_PARAM_SIGNING_KEY, '/app-signing-key', 'the old config was loaded');
		assert.strictEqual(await frameworkKey(new Scope('app'), 'signing-key').get(), 'from-secrets-manager');
		assert.deepStrictEqual(
			stubs.sm.map((c) => c.input.SecretId),
			[ARN],
		);
		assert.strictEqual(stubs.ssm.length, 0, 'never falls back to SSM');
	} finally {
		stubs.restore();
		s3.mock.restore();
		delete process.env.BLOCKS_CONFIG_BUCKET;
		delete process.env.BLOCKS_CONFIG_KEY;
		delete process.env.BLOCKS_SSM_PARAM_SIGNING_KEY;
		_resetConfigCache();
	}
});
