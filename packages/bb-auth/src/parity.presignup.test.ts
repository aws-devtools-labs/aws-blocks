// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision Q10, mock ↔ AWS parity: for every PreSignUp trigger source the
 * local runtime has a counterpart for, `validateUser` sees the same candidate
 * and a rejection looks the same to the caller.
 *
 * | Trigger source (AWS) | Local counterpart |
 * |---|---|
 * | `PreSignUp_SignUp` | `auth.signUp` (in-process) |
 * | `PreSignUp_AdminCreateUser` | `auth.admin.createUser` (in-process) |
 * | `PreSignUp_ExternalProvider` | none — Cognito-federated providers (social, SAML, `federateVia: 'cognito'`) are unavailable locally; directly federated ones, the stub IdP included, never create a pool user on either runtime, so they only ever see `phase: 'signIn'` |
 *
 * The AWS side runs the **trigger** (Cognito played by
 * `test-support/cognito-trigger.ts`, with no marker delivered, so the trigger
 * really validates), and its candidate must equal both the AWS in-process one
 * and the local one.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError, type ScopeParent } from '@aws-blocks/core';
import { INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { makeAwsAuth, wireView } from './test-support/aws-harness.js';
import { cognitoWithTrigger } from './test-support/cognito-trigger.js';
import type { AuthOptions, UserCandidate } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

let n = 0;
const root = (): ScopeParent => ({ id: `q10parity${process.pid}x${++n}` });

function recorder(reject?: (c: UserCandidate) => unknown) {
	const calls: UserCandidate[] = [];
	return {
		calls,
		validateUser: async (c: UserCandidate) => {
			calls.push(c);
			const e = reject?.(c);
			if (e !== undefined) throw e;
		},
	};
}

async function caught(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected a rejection'),
		(e: unknown) => e,
	);
}

const SCENARIOS: { name: string; users?: AuthOptions['users']; login: string; attributes: Record<string, string> }[] = [
	{ name: 'default pool (username + email alias)', login: 'ada', attributes: { email: 'ada@example.com' } },
	{
		name: 'email-only pool (Cognito stores a UUID username)',
		users: { signInWith: ['email'] },
		login: 'ada@example.com',
		attributes: {},
	},
	{
		name: 'custom attribute',
		users: { attributes: [{ name: 'tenant' }] },
		login: 'ada',
		attributes: { email: 'ada@example.com', tenant: 't-1' },
	},
];

describe('Q10 parity: PreSignUp_SignUp ↔ local auth.signUp — same candidate', () => {
	for (const s of SCENARIOS) {
		test(s.name, async () => {
			const local = recorder();
			const mock: MockAuth = new MockAuth(root(), 'auth', {
				...(s.users ? { users: s.users } : {}),
				validateUser: local.validateUser,
			});
			await mock.signUp(s.login, 'Passw0rd!', { attributes: s.attributes });

			const aws = recorder();
			const h = makeAwsAuth({ ...(s.users ? { users: s.users } : {}), validateUser: aws.validateUser });
			cognitoWithTrigger(h, {
				dropClientMetadata: true,
				usernameAttributes: s.users?.signInWith !== undefined && !s.users.signInWith.includes('username'),
			});
			await h.auth.signUp(s.login, 'Passw0rd!', { attributes: s.attributes });

			assert.strictEqual(local.calls.length, 1);
			assert.strictEqual(aws.calls.length, 2, 'AWS: in-process, then the trigger (no marker delivered)');
			const [inProcess, trigger] = aws.calls;
			assert.deepStrictEqual(trigger, inProcess, 'AWS trigger candidate = AWS in-process candidate');
			assert.deepStrictEqual(local.calls[0], trigger, 'local candidate = AWS trigger candidate');
		});
	}
});

describe('Q10 parity: PreSignUp_AdminCreateUser ↔ local auth.admin.createUser — same candidate', () => {
	test('admin-created user', async () => {
		const local = recorder();
		const mock = new MockAuth(root(), 'auth', { admin: {}, validateUser: local.validateUser });
		await mock.admin.createUser('cy', { attributes: { email: 'cy@example.com' } });

		const aws = recorder();
		const h = makeAwsAuth({ admin: {}, validateUser: aws.validateUser });
		cognitoWithTrigger(h, { dropClientMetadata: true });
		await h.auth.admin.createUser('cy', { attributes: { email: 'cy@example.com' } });

		assert.strictEqual(local.calls.length, 1);
		assert.strictEqual(aws.calls.length, 2);
		assert.deepStrictEqual(aws.calls[1], aws.calls[0]);
		assert.deepStrictEqual(local.calls[0], aws.calls[1]);
		assert.strictEqual(local.calls[0]?.phase, 'signUp');
		assert.strictEqual(local.calls[0]?.provider, 'password');
	});
});

describe('Q10 parity: a rejection looks the same locally and from the AWS trigger', () => {
	const cases: { name: string; error: () => unknown; expected: Record<string, unknown> }[] = [
		{
			name: 'an ApiError with an AuthErrors name',
			error: () => new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized }),
			expected: {
				code: 403,
				message: 'Corporate accounts only',
				name: AuthErrors.NotAuthorized,
				retriable: false,
			},
		},
		{
			name: 'a plain Error (masked)',
			error: () => new Error('bug in my validator'),
			expected: { code: 500, message: INTERNAL_ERROR_MESSAGE, name: AuthErrors.InternalError, retriable: true },
		},
	];
	for (const c of cases) {
		test(c.name, async () => {
			const mock: MockAuth = new MockAuth(root(), 'auth', {
				validateUser: async () => Promise.reject(c.error()),
			});
			const local = wireView(
				await caught(mock.signUp('mal', 'Passw0rd!', { attributes: { email: 'm@x.example' } })),
			);

			// AWS: in-process accepts, the trigger rejects — the client sees the decoded error.
			let calls = 0;
			const h = makeAwsAuth({
				validateUser: async () => {
					if (++calls > 1) throw c.error();
				},
			});
			const cognito = cognitoWithTrigger(h, { dropClientMetadata: true });
			const aws = wireView(
				await caught(h.auth.signUp('mal', 'Passw0rd!', { attributes: { email: 'm@x.example' } })),
			);

			assert.deepStrictEqual(local, c.expected);
			assert.deepStrictEqual(aws, local);
			assert.deepStrictEqual(cognito.created, []);
		});
	}
});
