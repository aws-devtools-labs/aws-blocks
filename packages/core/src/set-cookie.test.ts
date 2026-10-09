// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { errorResponseSetCookies, isCookieDeletion } from './set-cookie.js';

const NOW = Date.parse('2026-06-01T00:00:00Z');

describe('isCookieDeletion', () => {
	const cases: Array<[string, boolean]> = [
		// Max-Age
		['s=; Path=/; Max-Age=0', true],
		['s=; Path=/; Max-Age=-1', true],
		['s=; Path=/; max-age=0', true],
		['s=;Max-Age = 0 ;Path=/', true],
		['s=v; Path=/; Max-Age=3600', false],
		['s=v; Path=/; Max-Age=1', false],
		// Malformed Max-Age is ignored (RFC 6265 §5.2.2) → session cookie.
		['s=v; Max-Age=abc', false],
		['s=v; Max-Age=+0', false],
		['s=v; Max-Age=', false],
		['s=v; Max-Age', false],
		// Expires
		['s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; expires=Sun, 31 May 2026 23:59:59 GMT', true],
		['s=v; Expires=Fri, 01 Jan 2100 00:00:00 GMT', false],
		['s=v; Expires=not-a-date', false],
		// Only a strict IMF-fixdate counts (RFC 7231 §7.1.1.1, the form RFC 6265
		// §4.1.1 says servers send). `Date.parse` accepts far more — `0` and `1`
		// parse as dates in 2000/2001 — but a browser ignores those and keeps the
		// cookie, so treating them as deletions would let a live cookie through.
		['s=v; Expires=0', false],
		['s=v; Expires=1', false],
		['s=v; Expires=-1', false],
		['s=v; Expires=1970', false],
		['s=v; Expires=1970-01-01T00:00:00Z', false],
		['s=v; Expires=Thu Jan 01 1970 00:00:00 GMT', false],
		['s=v; Expires=Thursday, 01-Jan-70 00:00:00 GMT', false],
		['s=v; Expires=Thu Jan  1 00:00:00 1970', false],
		['s=v; Expires=Thu, 1 Jan 1970 00:00:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:00 UTC', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:00 gmt', false],
		['s=v; Expires=Thu, 01 jan 1970 00:00:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT junk', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:00', false],
		['s=v; Expires=Thu, 01 Jan 70 00:00:00 GMT', false],
		// …and only a real calendar date and time.
		['s=v; Expires=Sat, 31 Feb 2020 00:00:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 24:00:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:60:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:60 GMT', false],
		['s=v; Expires=Thu, 00 Jan 1970 00:00:00 GMT', false],
		['s=; Expires=Sat, 29 Feb 2020 00:00:00 GMT', true],
		// The day name is not checked (browsers ignore it, too).
		['s=; Expires=Mon, 01 Jan 1970 00:00:00 GMT', true],
		// Exactly now is already expired.
		['s=; Expires=Mon, 01 Jun 2026 00:00:00 GMT', true],
		['s=v; Expires=Mon, 01 Jun 2026 00:00:01 GMT', false],
		// Max-Age must be an integer.
		['s=; Max-Age=-0', true],
		['s=; Max-Age=00', true],
		['s=v; Max-Age=0.5', false],
		['s=v; Max-Age=-0.5', false],
		['s=v; Max-Age=0e1', false],
		['s=v; Max-Age=0x0', false],
		['s=v; Max-Age=--1', false],
		// A malformed Max-Age falls back to Expires, which must itself be strict.
		['s=; Max-Age=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=v; Max-Age=x; Expires=0', false],
		// Max-Age wins over Expires (RFC 6265 §5.3 step 3), whatever the order.
		['s=v; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
		['s=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600', false],
		['s=; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT', true],
		// The last valid Max-Age counts.
		['s=v; Max-Age=0; Max-Age=60', false],
		['s=; Max-Age=60; Max-Age=0', true],
		// A malformed later Max-Age does not override a valid earlier one.
		['s=; Max-Age=0; Max-Age=x', true],
		// A Max-Age RFC 6265 §5.2.2 ignores (not a digit or '-' first, or a
		// non-digit later) leaves the decision to Expires…
		['s=; Max-Age=abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; Max-Age=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; Max-Age=-; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=v; Max-Age=abc; Expires=Fri, 01 Jan 2100 00:00:00 GMT', false],
		// …unless a lenient parser (a leading '+', trailing junk) could read it
		// as a positive lifetime: in doubt, not a deletion (R2-3).
		['s=; Max-Age=+999; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=+999', false],
		['s=; Max-Age=999abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
		['s=; Max-Age=+1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
		['s=; Max-Age=0; Max-Age=+60', false],
		['s=; Max-Age=0; Max-Age=60abc', false],
		// A lenient read that is zero or negative deletes too, so these still do.
		['s=; Max-Age=+0; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; Max-Age=-5abc; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; Max-Age=0; Max-Age=+0', true],
		// …but not without a past Expires: an RFC reader keeps a session cookie.
		['s=v; Max-Age=0abc', false],
		['s=v; Max-Age=-1abc', false],
		// Expires, the same rule (FX7b): a deletion only if every reading of the
		// dates deletes — strict IMF-fixdate, the RFC 6265 §5.1.1 cookie-date
		// algorithm browsers implement, and a free-form parser. A later Expires
		// the strict parser rejects can still be the one a browser keeps.
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01-Jan-2100 00:00:00 GMT', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01 Jan 2100 00:00:00 UTC', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=1 Jan 2100 00:00:00', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=2100-01-01T00:00:00Z', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri Jan 01 2100 00:00:00 GMT', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Fri, 01 Jan 2100 00:00:00 GMT junk', false],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Thu, 01-Jan-69 00:00:00 GMT', false],
		// …a later date no reading can parse is ignored by all of them…
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=garbage', true],
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=', true],
		// …and a later past date in any form deletes under every reading.
		['s=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=Thursday, 01-Jan-70 00:00:00 GMT', true],
		['s=; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		['s=; Expires=Fri, 01-Jan-2100 00:00:00 GMT; Expires=Thu, 01 Jan 1970 00:00:00 GMT', true],
		// A malformed earlier Expires never overrides the last strict past one.
		['s=; Expires=Fri, 01-Jan-2100 00:00:00 GMT; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/', true],
		// Only a lenient past date and no strict one: a strict reader keeps a session cookie.
		['s=v; Expires=Thursday, 01-Jan-70 00:00:00 GMT', false],
		// Max-Age still wins over every Expires reading.
		['s=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Expires=2100-01-01T00:00:00Z', true],
		['s=v; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
		// No expiry attributes → live session cookie.
		['s=v; Path=/; HttpOnly; Secure; SameSite=Lax', false],
		['s=v', false],
		// Attribute-looking text in the name/value is not an attribute.
		['s=Max-Age=0; Path=/', false],
		['Max-Age=0', false],
		['s=Expires=Thu, 01 Jan 1970 00:00:00 GMT', false],
	];

	for (const [header, expected] of cases) {
		it(`${JSON.stringify(header)} → ${expected ? 'deletes' : 'live'}`, () => {
			assert.strictEqual(isCookieDeletion(header, NOW), expected);
		});
	}
});

describe('errorResponseSetCookies', () => {
	it('keeps only deletions, in order', () => {
		const headers = new Headers();
		headers.append('set-cookie', 'session=live; Max-Age=3600');
		headers.append('set-cookie', 'a=; Max-Age=0');
		headers.append('set-cookie', 'b=live');
		headers.append('set-cookie', 'c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
		headers.append('set-cookie', 'session2=live; Expires=0');
		assert.deepStrictEqual(errorResponseSetCookies(headers, NOW), [
			'a=; Max-Age=0',
			'c=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		]);
	});

	it('returns [] for no headers or no cookies', () => {
		assert.deepStrictEqual(errorResponseSetCookies(undefined, NOW), []);
		assert.deepStrictEqual(errorResponseSetCookies(new Headers({ 'content-type': 'application/json' }), NOW), []);
	});
});
