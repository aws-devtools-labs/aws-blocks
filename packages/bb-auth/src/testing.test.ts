// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `getLastAuthCode` (`@aws-blocks/bb-auth/testing`) against real local pools:
 * it finds the code wherever the block's data directory is, so renaming the
 * scope or the block does not break a test; it keeps working when another
 * user's code has overwritten `last-code.json`; and it says why when there is
 * nothing to read.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Auth } from './index.mock.js';
import { totpCode } from './engines/totp.js';
import { getLastAuthCode, totpCodeFor } from './testing.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let n = 0;

/** A local pool under a scope name the test never repeats (as after a rename). */
function makeAuth(id = 'auth', options: ConstructorParameters<typeof Auth>[2] = {}) {
	return new Auth({ id: `testing-${process.pid}-${++n}` }, id, options);
}

describe('getLastAuthCode', () => {
	test('reads the sign-up code without knowing the scope or block name', async () => {
		const auth = makeAuth('renamed-auth');
		await auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		const code = await getLastAuthCode('alice');
		assert.match(code, /^\d{6}$/);
		await auth.confirmSignUp('alice', code);
	});

	test('on an email sign-in pool, takes the email the user signs in with', async () => {
		const auth = makeAuth('auth', { users: { signInWith: ['email'] } });
		await auth.signUp('Ann@Example.com', PASSWORD);
		await auth.confirmSignUp('Ann@Example.com', await getLastAuthCode('Ann@Example.com'));
	});

	test("still finds a user's code after another user's code replaced last-code.json", async () => {
		const auth = makeAuth();
		await auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		await auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com' } });
		await auth.confirmSignUp('alice', await getLastAuthCode('alice'));
		await auth.confirmSignUp('bob', await getLastAuthCode('bob'));
	});

	test('`purpose` selects the flow; a consumed code is not returned again', async () => {
		const auth = makeAuth();
		await auth.signUp('carol', PASSWORD, { attributes: { email: 'carol@example.com' } });
		await auth.confirmSignUp('carol', await getLastAuthCode('carol', { purpose: 'signUp' }));
		await assert.rejects(
			getLastAuthCode('carol', { purpose: 'resetPassword' }),
			/No resetPassword code for 'carol'/,
		);
		await auth.resetPassword('carol');
		const reset = await getLastAuthCode('carol', { purpose: 'resetPassword' });
		await auth.confirmResetPassword('carol', reset, 'N3wPassw0rd!');
		await assert.rejects(
			getLastAuthCode('carol', { purpose: 'resetPassword' }),
			/No resetPassword code for 'carol'/,
		);
	});

	test("a username that ends with another's after a ':' (x:bob) is not that user (bob)", async () => {
		const auth = makeAuth();
		await auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com' } });
		await auth.confirmSignUp('bob', await getLastAuthCode('bob'));
		await auth.signUp('x:bob', PASSWORD, { attributes: { email: 'xbob@example.com' } });
		// Only x:bob has a pending code (`signUp:x:bob`); bob's was used.
		await assert.rejects(getLastAuthCode('bob'), /No code for 'bob'/);
		await auth.confirmSignUp('x:bob', await getLastAuthCode('x:bob'));
	});

	test('`block` picks one of several blocks, by id or full id', async () => {
		const a = makeAuth('members');
		const b = makeAuth('staff');
		await a.signUp('dave', PASSWORD, { attributes: { email: 'dave@example.com' } });
		await b.signUp('dave', PASSWORD, { attributes: { email: 'dave@example.com' } });
		const forA = await getLastAuthCode('dave', { block: 'members' });
		const forB = await getLastAuthCode('dave', { block: b.fullId });
		await a.confirmSignUp('dave', forA);
		await b.confirmSignUp('dave', forB);
		await assert.rejects(getLastAuthCode('dave', { block: 'nope' }), /No local Auth block matches 'nope'/);
	});

	test('a user with no code: the error names what the local pools hold', async () => {
		const auth = makeAuth();
		await auth.signUp('erin', PASSWORD, { attributes: { email: 'erin@example.com' } });
		await assert.rejects(getLastAuthCode('frank'), (e: unknown) => {
			assert.ok(e instanceof Error);
			assert.match(e.message, /No code for 'frank'/);
			assert.match(e.message, /last code: signUp for 'erin'/);
			return true;
		});
	});

	test('no local data: says the helper reads the local pool, not a deployed one', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'bb-auth-testing-'));
		try {
			await assert.rejects(getLastAuthCode('alice', { cwd: empty }), (e: unknown) => {
				assert.ok(e instanceof Error);
				assert.match(e.message, /no local Auth data/);
				assert.match(e.message, /deployed/);
				return true;
			});
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe('totpCodeFor', () => {
	// RFC 6238 Appendix B, SHA-1 (ASCII "12345678901234567890"); the six-digit code is the last six digits.
	const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

	test('is the local pool\'s own RFC 6238 code (one implementation), for a Date or epoch milliseconds', () => {
		for (const [seconds, eight] of [
			[59, '94287082'],
			[1111111109, '07081804'],
			[2000000000, '69279037'],
		] as const) {
			assert.strictEqual(totpCodeFor(seed, seconds * 1000), eight.slice(-6));
			assert.strictEqual(totpCodeFor(seed, new Date(seconds * 1000)), totpCode(seed, seconds * 1000));
		}
	});

	test('refuses a secret that is not base32', () => {
		assert.throws(() => totpCodeFor('not-base32!'), /base32/);
	});
});
