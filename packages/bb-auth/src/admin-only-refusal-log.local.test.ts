// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local runtime logs a refused end-user write of a `userWritable: false`
 * attribute, as the Cognito engine does (`index.aws.attributes.test.ts`):
 * one warning naming the attribute, never the value.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { Auth } from './index.mock.js';
import { Browser, captureLogger } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const VALUE = 'secret-admin-value';
let n = 0;
const root = (): ScopeParent => ({ id: `adminonlylog${process.pid}x${++n}` });

function localAuth() {
	const logs = captureLogger();
	const codes: string[] = [];
	const auth = new Auth(root(), 'auth', {
		users: { attributes: [{ name: 'team' }, { name: 'role', userWritable: false }] },
		logger: logs.logger,
		codeDelivery: async (_login: string, code: string) => {
			codes.push(code);
		},
	});
	return { auth, logs, codes };
}

function adminOnlyWarnings(entries: ReturnType<typeof captureLogger>['entries']) {
	return entries
		.filter((e) => e.message.includes('admin-only attribute'))
		.map((e) => [e.level, e.message, e.context?.attribute]);
}

const EXPECTED = [['warn', '[bb-auth] refused end-user write to admin-only attribute', 'custom:role']];

test('local signUp: a refused `userWritable: false` write logs the attribute, never the value', async () => {
	const { auth, logs } = localAuth();
	await assert.rejects(
		auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com', role: VALUE } as never }),
		{ name: 'NotAuthorizedException' },
	);
	assert.deepStrictEqual(adminOnlyWarnings(logs.entries), EXPECTED);
	assert.ok(!JSON.stringify(logs.entries).includes(VALUE));
});

test('local updateUserAttributes: a refused `userWritable: false` write logs the attribute, never the value', async () => {
	const { auth, logs, codes } = localAuth();
	await auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com', team: 'ops' } });
	await auth.confirmSignUp('alice', codes.at(-1) ?? '');
	const browser = new Browser();
	await browser.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
	logs.entries.length = 0;
	await assert.rejects(
		browser.request((ctx) => auth.updateUserAttributes(ctx, { 'custom:role': VALUE } as never)),
		{ name: 'NotAuthorizedException' },
	);
	assert.deepStrictEqual(adminOnlyWarnings(logs.entries), EXPECTED);
	assert.ok(!JSON.stringify(logs.entries).includes(VALUE));
	// A user-writable attribute is accepted and logs nothing.
	await browser.request((ctx) => auth.updateUserAttributes(ctx, { team: 'dev' } as never));
	assert.deepStrictEqual(adminOnlyWarnings(logs.entries), EXPECTED);
});
