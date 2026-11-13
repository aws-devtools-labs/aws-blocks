// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The opt-in `audit` option: one structured record per session lifecycle
 * event, with no secrets in it, and nothing emitted when the option is off.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import type { SessionStore } from './sessions.js';
import { Browser, captureLogger, type LogEntry, makeAuth, makeContext } from './test-helpers.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const OKTA = { okta: { type: 'oidc', issuer: 'https://okta.example.com', clientId: 'c' } } as const;

/** The audit records, in order, as the plain objects the logger received. */
function records(entries: readonly LogEntry[]): Record<string, unknown>[] {
	return entries.map((e) => {
		assert.strictEqual(e.level, 'info', 'audit records are logged at info');
		assert.ok(e.context, 'every audit record carries its fields');
		assert.strictEqual(e.message, e.context.event, 'the message is the event name');
		return e.context;
	});
}

/** No field of any record contains the password, a token or a session id. */
function assertNoSecrets(entries: readonly LogEntry[], ...secrets: string[]): void {
	const text = JSON.stringify(entries);
	for (const s of [...secrets, 'refresh-', 'eyJ']) assert.ok(!text.includes(s), `audit record leaked ${s}`);
}

async function passwordAuth() {
	const audit = captureLogger();
	const h = makeAuth({ audit: audit.logger });
	h.native.addUser('alice', 'Passw0rd!');
	return { h, audit };
}

describe('audit: password sign-in', () => {
	test('a successful sign-in records auth.session.issued with the sub and provider', async () => {
		const { h, audit } = await passwordAuth();
		await new Browser().request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		assert.deepStrictEqual(records(audit.entries), [
			{ event: 'auth.session.issued', block: h.auth.fullId, provider: 'password', sub: 'sub-alice', outcome: 'success' },
		]);
		assertNoSecrets(audit.entries, 'Passw0rd!');
	});

	test('a wrong password records auth.signin.failed with the error name, and no username', async () => {
		const { h, audit } = await passwordAuth();
		await assert.rejects(h.auth.signIn('alice', 'wrong', makeContext()), { name: AuthErrors.NotAuthorized });
		assert.deepStrictEqual(records(audit.entries), [
			{
				event: 'auth.signin.failed',
				block: h.auth.fullId,
				provider: 'password',
				outcome: 'failure',
				error: AuthErrors.NotAuthorized,
			},
		]);
		assertNoSecrets(audit.entries, 'wrong', 'alice');
	});

	test('a sign-in onSignIn rejects records auth.signin.failed, not auth.session.issued', async () => {
		const audit = captureLogger();
		const h = makeAuth({
			audit: audit.logger,
			onSignIn: async () => {
				throw new Error('blocked by the app');
			},
		});
		h.native.addUser('alice', 'Passw0rd!');
		await assert.rejects(h.auth.signIn('alice', 'Passw0rd!', makeContext()));
		assert.deepStrictEqual(
			records(audit.entries).map((r) => [r.event, r.reason, r.sub]),
			[['auth.signin.failed', 'on-sign-in', 'sub-alice']],
		);
	});
});

describe('audit: sign-out and revocation', () => {
	test('a sign-out records auth.signout with the sub', async () => {
		const { h, audit } = await passwordAuth();
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		audit.entries.length = 0;
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.deepStrictEqual(records(audit.entries), [
			{ event: 'auth.signout', block: h.auth.fullId, provider: 'password', sub: 'sub-alice', outcome: 'success' },
		]);
	});

	test('a sign-out with no session records nothing', async () => {
		const { h, audit } = await passwordAuth();
		await h.auth.signOut(makeContext());
		assert.deepStrictEqual(audit.entries, []);
	});

	test('a sign-out whose session read fails still records it, without the unknown fields', async () => {
		const { h, audit } = await passwordAuth();
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		audit.entries.length = 0;
		const store: SessionStore = Reflect.get(h.auth, 'sessions');
		store.lookup = async () => {
			throw new Error('read failed');
		};
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.deepStrictEqual(records(audit.entries), [
			{ event: 'auth.signout', block: h.auth.fullId, outcome: 'success' },
		]);
	});

	test('a completed password reset records auth.sessions.revoked with the canonical username', async () => {
		const { h, audit } = await passwordAuth();
		await h.auth.confirmResetPassword('alice', '123456', 'N3wPassw0rd!');
		assert.deepStrictEqual(records(audit.entries), [
			{
				event: 'auth.sessions.revoked',
				block: h.auth.fullId,
				username: 'alice',
				reason: 'password-reset',
				outcome: 'success',
			},
		]);
		assertNoSecrets(audit.entries, 'N3wPassw0rd!', '123456');
	});
});

describe('audit: federated sign-in', () => {
	test('a provider that fails the callback records auth.signin.failed with the provider id', async () => {
		const audit = captureLogger();
		const h = makeAuth({ store: 'builtin', providers: OKTA, audit: audit.logger });
		// No identity scripted: the fake engine's completeSignIn throws.
		await assert.rejects(h.auth.completeFederated(makeContext(), 'okta'));
		const [r] = records(audit.entries);
		assert.strictEqual(r.event, 'auth.signin.failed');
		assert.strictEqual(r.provider, 'okta');
		assert.strictEqual(r.reason, 'provider');
		assert.strictEqual(audit.entries.length, 1);
	});

	test('a builtin federated sign-in records the <issuer>:<sub> id, never the email', async () => {
		const audit = captureLogger();
		const h = makeAuth({ store: 'builtin', providers: OKTA, audit: audit.logger });
		const okta = h.federation.get('okta');
		assert.ok(okta);
		okta.identity = {
			kind: 'direct',
			issuer: 'https://okta.example.com',
			subject: 'u-1',
			claims: { sub: 'u-1', iss: 'https://okta.example.com', email: 'eve@example.com' },
			groups: [],
			expiresAt: Date.now() + 3600_000,
		};
		await new Browser().request((ctx) => h.auth.completeFederated(ctx, 'okta'));
		assert.deepStrictEqual(records(audit.entries), [
			{
				event: 'auth.session.issued',
				block: h.auth.fullId,
				provider: 'okta',
				sub: 'https://okta.example.com:u-1',
				outcome: 'success',
			},
		]);
		assertNoSecrets(audit.entries, 'eve@example.com');
	});
});

describe('audit: revocations on the local pool', () => {
	let n = 0;
	async function signedInOnMockPool() {
		const audit = captureLogger();
		const codes: string[] = [];
		const auth = new MockAuth({ id: `audit-${process.pid}-${++n}` }, 'auth', {
			admin: {},
			audit: audit.logger,
			codeDelivery: async (_username, code) => {
				codes.push(code);
			},
		});
		await auth.signUp('alice', 'Passw0rd!', { attributes: { email: 'alice@example.com' } });
		const code = codes.at(-1);
		assert.ok(code, 'the local pool delivered a sign-up code');
		await auth.confirmSignUp('alice', code);
		const b = new Browser();
		const user = await b.request((ctx) => auth.signIn('alice', 'Passw0rd!', ctx));
		assert.strictEqual(user.status, 'signedIn');
		audit.entries.length = 0;
		return { auth, audit, b };
	}

	test('admin.revokeUserSessions records auth.sessions.revoked with reason admin', async () => {
		const { auth, audit } = await signedInOnMockPool();
		await auth.admin.revokeUserSessions('alice');
		assert.deepStrictEqual(records(audit.entries), [
			{ event: 'auth.sessions.revoked', block: auth.fullId, username: 'alice', outcome: 'success', reason: 'admin' },
		]);
	});

	test('deleteUser records auth.sessions.revoked with the deleted user sub', async () => {
		const { auth, audit, b } = await signedInOnMockPool();
		const me = await b.request((ctx) => auth.requireAuth(ctx));
		await b.request((ctx) => auth.deleteUser(ctx));
		assert.deepStrictEqual(records(audit.entries), [
			{
				event: 'auth.sessions.revoked',
				block: auth.fullId,
				provider: 'password',
				sub: me.userSub,
				outcome: 'success',
				reason: 'account-deleted',
			},
		]);
		assertNoSecrets(audit.entries, 'Passw0rd!', 'alice@example.com');
	});
});

describe('audit: off by default and best-effort', () => {
	test('without the option, the block logger receives no audit record', async () => {
		const log = captureLogger();
		const h = makeAuth({ logger: log.logger });
		h.native.addUser('alice', 'Passw0rd!');
		const b = new Browser();
		await b.request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.deepStrictEqual(
			log.entries.filter((e) => e.message.startsWith('auth.')),
			[],
		);
	});

	test('an audit logger that throws does not change the sign-in result', async () => {
		const throwing: ChildLogger = {
			debug: () => {},
			info: () => {
				throw new Error('log sink down');
			},
			warn: () => {},
			error: () => {},
			child: () => throwing,
		};
		const h = makeAuth({ audit: throwing });
		h.native.addUser('alice', 'Passw0rd!');
		const r = await new Browser().request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		assert.strictEqual(r.status, 'signedIn');
		await assert.rejects(h.auth.signIn('alice', 'wrong', makeContext()), { name: AuthErrors.NotAuthorized });
	});
});
