// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { totpCodeFor } from './utils.js';

/**
 * RFC 6238 Appendix B, SHA-1: the seed is the ASCII string "12345678901234567890"
 * (base32 below), 30 s steps. The RFC lists 8-digit codes; the 6-digit code an
 * authenticator app shows is the same truncated value modulo 10^6, i.e. its last
 * six digits.
 */
const RFC_SEED_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS: readonly [seconds: number, eightDigits: string][] = [
	[59, '94287082'],
	[1111111109, '07081804'],
	[1111111111, '14050471'],
	[1234567890, '89005924'],
	[2000000000, '69279037'],
	[20000000000, '65353130'],
];

describe('totpCodeFor (RFC 6238, SHA-1, 6 digits, 30 s)', () => {
	for (const [seconds, eightDigits] of RFC_VECTORS) {
		test(`T = ${seconds}s → ${eightDigits.slice(-6)}`, () => {
			assert.strictEqual(totpCodeFor(RFC_SEED_BASE32, seconds * 1000), eightDigits.slice(-6));
			assert.strictEqual(totpCodeFor(RFC_SEED_BASE32, new Date(seconds * 1000)), eightDigits.slice(-6));
		});
	}

	test('accepts the secret as authenticator apps do: lower case, spaces and padding are ignored', () => {
		const spaced = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq====';
		assert.strictEqual(totpCodeFor(spaced, 59_000), '287082');
	});

	test('defaults to the current time and always returns six digits', () => {
		const code = totpCodeFor(RFC_SEED_BASE32);
		assert.match(code, /^\d{6}$/);
		assert.strictEqual(code, totpCodeFor(RFC_SEED_BASE32, Date.now()));
	});

	test('a step boundary changes the code; time within one step does not', () => {
		assert.strictEqual(totpCodeFor(RFC_SEED_BASE32, 30_000), totpCodeFor(RFC_SEED_BASE32, 59_999));
		assert.notStrictEqual(totpCodeFor(RFC_SEED_BASE32, 59_999), totpCodeFor(RFC_SEED_BASE32, 60_000));
	});

	test('a secret that is not base32 is refused', () => {
		assert.throws(() => totpCodeFor('not-base32!'), /base32/);
		assert.throws(() => totpCodeFor(''), /base32/);
	});
});
