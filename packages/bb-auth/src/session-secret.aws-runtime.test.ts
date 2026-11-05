// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the AWS layer reads `Auth`'s `session-secret`, and that a failed read
 * is not cached.
 *
 * Runs in the package's second test pass, under `--conditions=aws-runtime`, so
 * `frameworkKey()` resolves its AWS entry: Secrets Manager when the compute's
 * environment carries the key's ARN (a `secretsStore: 'secrets-manager'`
 * stack), the SSM SecureString otherwise. The SDK clients are stubbed.
 *
 * `signOut()` reads the secret to verify the session cookie, so a request with
 * a (garbage) session cookie drives one read per call.
 */

import assert from 'node:assert';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import type { BlocksContext } from '@aws-blocks/core';
import { clearRouteRegistry, Scope } from '@aws-blocks/core';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Auth } from './index.aws.js';

const ARN = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:SessionKey-AbCdEf';
const ARN_KEY = 'BLOCKS_SECRET_ARN_APP_AUTH_SESSION_SECRET';
const ENV_KEYS = [
	'AWS_REGION',
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_PROFILE',
	'BLOCKS_STACK_NAME',
	ARN_KEY,
] as const;
const prevEnv: Record<string, string | undefined> = {};

before(() => {
	for (const key of ENV_KEYS) prevEnv[key] = process.env[key];
	process.env.AWS_REGION = 'us-east-1';
	process.env.AWS_ACCESS_KEY_ID = 'AKIDTEST';
	process.env.AWS_SECRET_ACCESS_KEY = 'secret';
	delete process.env.AWS_PROFILE;
	delete process.env.BLOCKS_STACK_NAME;
});

after(() => {
	for (const key of ENV_KEYS) {
		if (prevEnv[key] === undefined) delete process.env[key];
		else process.env[key] = prevEnv[key];
	}
});

beforeEach(() => clearRouteRegistry());
afterEach(() => {
	mock.restoreAll();
	delete process.env[ARN_KEY];
});

/** A request carrying a session cookie that will not verify, so `signOut()` reads the secret and stops. */
function contextWithSessionCookie(): BlocksContext {
	return {
		request: {
			headers: new Headers({ cookie: 'auth_app-auth=not-a-valid-session' }),
			url: new URL('https://app.example.com/'),
		},
		response: { headers: new Headers(), status: 200, send: () => {} },
	} as unknown as BlocksContext;
}

interface Sent {
	name: string;
	input: Record<string, unknown>;
}

function stubStores(responses: { sm?: () => unknown; ssm?: () => unknown }) {
	const sm: Sent[] = [];
	const ssm: Sent[] = [];
	mock.method(
		SecretsManagerClient.prototype,
		'send',
		async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			sm.push({ name: cmd.constructor.name, input: cmd.input });
			if (!responses.sm) throw new Error('Secrets Manager must not be called');
			return responses.sm();
		},
	);
	mock.method(
		SSMClient.prototype,
		'send',
		async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			ssm.push({ name: cmd.constructor.name, input: cmd.input });
			if (!responses.ssm) throw new Error('SSM must not be called');
			return responses.ssm();
		},
	);
	return { sm, ssm };
}

/** Whether `frameworkKey()` resolved its AWS entry (this pass runs under `aws-runtime`). */
const internalIsAws = import.meta.resolve('@aws-blocks/bb-secret/internal').endsWith('/internal.aws.js');

describe('Auth session secret store (aws-runtime)', {
	skip: !internalIsAws && 'runs under --conditions=aws-runtime',
}, () => {
	test('secrets-manager stack: the session secret is read from Secrets Manager by the ARN, never SSM', async () => {
		process.env[ARN_KEY] = ARN;
		const sent = stubStores({ sm: () => ({ SecretString: 'k'.repeat(64) }) });
		const auth = new Auth(new Scope('app'), 'auth');
		await auth.signOut(contextWithSessionCookie());
		assert.deepStrictEqual(
			sent.sm.map((c) => [c.name, c.input.SecretId]),
			[['GetSecretValueCommand', ARN]],
		);
		assert.strictEqual(sent.ssm.length, 0);
	});

	test('ssm stack: the session secret is read from the SSM parameter AuthCognito used, never Secrets Manager', async () => {
		const sent = stubStores({ ssm: () => ({ Parameter: { Value: 'legacy-session-key' } }) });
		const auth = new Auth(new Scope('app'), 'auth');
		await auth.signOut(contextWithSessionCookie());
		assert.deepStrictEqual(
			sent.ssm.map((c) => [c.name, c.input.Name, c.input.WithDecryption]),
			[['GetParameterCommand', '/app-auth-session-secret', true]],
		);
		assert.strictEqual(sent.sm.length, 0);
	});

	test('a failed read is retried on the next request, then cached', async () => {
		process.env[ARN_KEY] = ARN;
		let calls = 0;
		stubStores({
			sm: () => {
				calls += 1;
				if (calls === 1) {
					const err = new Error('Rate exceeded');
					err.name = 'ThrottlingException';
					throw err;
				}
				return { SecretString: 'k'.repeat(64) };
			},
		});
		const auth = new Auth(new Scope('app'), 'auth');
		await assert.rejects(auth.signOut(contextWithSessionCookie()), /Rate exceeded/);
		await auth.signOut(contextWithSessionCookie());
		await auth.signOut(contextWithSessionCookie());
		assert.strictEqual(calls, 2, 'one failed read, one successful read, then the cached value');
	});
});
