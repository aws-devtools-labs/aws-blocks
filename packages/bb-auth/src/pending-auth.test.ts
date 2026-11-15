// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The OAuth `state` check every server-initiated callback makes against the
 * pending-auth cookie (`engines/pending-auth.ts`): a constant-time comparison
 * that rejects — never throws on — a value of another length or encoding.
 * The engines' callbacks themselves are covered in `federation-direct.test.ts`
 * and `federation-hosted-ui.test.ts`.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type PendingAuth, pendingStateMatches } from './engines/pending-auth.js';

const STATE = crypto.randomBytes(32).toString('base64url');
const pending: PendingAuth = {
	provider: 'okta',
	state: STATE,
	codeVerifier: 'v',
	callbackUrl: 'https://app.example.com/aws-blocks/auth/callback',
	exp: Date.now() / 1000 + 600,
};

describe('pendingStateMatches — the callback state check', () => {
	test('the pending state matches', () => {
		assert.strictEqual(pendingStateMatches(STATE, pending), true);
	});

	test('a different value of the same length does not', () => {
		const other = `${STATE.slice(0, -1)}${STATE.endsWith('A') ? 'B' : 'A'}`;
		assert.strictEqual(other.length, STATE.length);
		assert.strictEqual(pendingStateMatches(other, pending), false);
	});

	test('missing, empty, shorter, longer or multi-byte values are rejected without throwing', () => {
		const candidates: Array<string | null | undefined> = [
			null,
			undefined,
			'',
			STATE.slice(0, -1),
			`${STATE}x`,
			STATE.toUpperCase() === STATE ? STATE.toLowerCase() : STATE.toUpperCase(),
			// Same number of characters, more bytes: lengths differ only once encoded.
			`${STATE.slice(0, -1)}é`,
			'é'.repeat(STATE.length),
		];
		for (const value of candidates) {
			assert.doesNotThrow(() => pendingStateMatches(value, pending), String(value));
			assert.strictEqual(pendingStateMatches(value, pending), false, String(value));
		}
	});

	test('an empty pending state never matches (not even an empty one)', () => {
		assert.strictEqual(pendingStateMatches('', { ...pending, state: '' }), false);
	});

	test('the engines compare state only through it, never with === / !==', () => {
		const engines = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engines');
		for (const file of ['federation-direct.ts', 'federation-hosted-ui.ts']) {
			const source = readFileSync(join(engines, file), 'utf8');
			assert.ok(
				!/[!=]==\s*pending\.state|pending\.state\s*[!=]==/.test(source),
				`${file} compares state directly`,
			);
			assert.match(source, /pendingStateMatches\(/, `${file} uses pendingStateMatches`);
		}
		// The ID-token nonce is the same kind of per-sign-in binding.
		const direct = readFileSync(join(engines, 'federation-direct.ts'), 'utf8');
		assert.ok(!/nonce\s*[!=]==\s*expectedNonce/.test(direct), 'the nonce is compared in constant time');
	});
});
