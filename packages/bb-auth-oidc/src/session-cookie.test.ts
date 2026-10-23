// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { decodeSignedCookie, encodeSignedCookie, type SessionCookiePayload } from './session-cookie.js';

const SECRET = 'test-secret-for-session-cookie-tests-only';

describe('signed cookie envelope', () => {
	test('round-trips a session payload', () => {
		const payload: SessionCookiePayload = {
			mode: 'stateful',
			provider: 'google',
			sessionId: 'abc123',
			exp: 1767225600,
		};
		const encoded = encodeSignedCookie(payload, SECRET);
		assert.match(encoded, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		assert.deepStrictEqual(decodeSignedCookie(encoded, SECRET), payload);
	});

	// Pins the wire format so deployed cookies keep decoding. The expected
	// value was produced by the original hand-written base64url helpers; the
	// body contains `-` and `_` and needs padding, so a switch to standard
	// base64 or a padding change fails here.
	const KNOWN_PAYLOAD: SessionCookiePayload = {
		mode: 'stateful',
		provider: 'google',
		sessionId: 'xsession-1/café?x=~&y=☃',
		exp: 1767225600,
	};
	const KNOWN_COOKIE =
		'v1.eyJtb2RlIjoic3RhdGVmdWwiLCJwcm92aWRlciI6Imdvb2dsZSIsInNlc3Npb25JZCI6InhzZXNzaW9uLTEvY2Fmw6k_eD1-Jnk94piDIiwiZXhwIjoxNzY3MjI1NjAwfQ.fsC3R6R31n6epEWPvzrbz8jxPxkT7D5k0N_t20i32eg';

	test('encodes a known payload to the pinned wire format', () => {
		assert.strictEqual(encodeSignedCookie(KNOWN_PAYLOAD, SECRET), KNOWN_COOKIE);
	});

	test('decodes a pinned cookie value', () => {
		assert.deepStrictEqual(decodeSignedCookie(KNOWN_COOKIE, SECRET), KNOWN_PAYLOAD);
	});

	test('tampered signature returns null', () => {
		const [version, body, sig] = KNOWN_COOKIE.split('.');
		const flipped = sig[0] === 'A' ? 'B' : 'A';
		assert.strictEqual(decodeSignedCookie(`${version}.${body}.${flipped}${sig.slice(1)}`, SECRET), null);
	});

	test('tampered body returns null', () => {
		const [version, body, sig] = KNOWN_COOKIE.split('.');
		assert.strictEqual(decodeSignedCookie(`${version}.${body}X.${sig}`, SECRET), null);
	});

	test('wrong secret returns null', () => {
		assert.strictEqual(decodeSignedCookie(KNOWN_COOKIE, 'wrong-secret'), null);
	});

	test('unknown version or malformed envelope returns null', () => {
		assert.strictEqual(decodeSignedCookie(KNOWN_COOKIE.replace(/^v1\./, 'v2.'), SECRET), null);
		assert.strictEqual(decodeSignedCookie('v1.only-two-parts', SECRET), null);
		assert.strictEqual(decodeSignedCookie('', SECRET), null);
	});
});
