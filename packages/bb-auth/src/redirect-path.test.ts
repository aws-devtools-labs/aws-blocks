// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared same-origin redirect check (`redirect-path.ts`). The route- and
 * engine-level cases live in `stub-idp.test.ts`, `federation-direct.test.ts`
 * and `federation-hosted-ui.test.ts`; this pins the helper itself, including
 * that what it returns is what a browser would land on.
 */

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { isSafeRedirectPath, safeRedirectPath, signInRedirectPath } from './redirect-path.js';

const APP = 'https://app.example.com';

/** Where a browser on `APP` lands for `Location: <location>`. */
function landsOn(location: string): string {
	return new URL(location, `${APP}/aws-blocks/auth/callback`).origin;
}

const UNSAFE = [
	// Control characters a browser strips (or that break the header).
	'/\t/evil.example.com',
	'/\n/evil.example.com',
	'/\r/evil.example.com',
	'/\t\t/evil.example.com',
	'/\u0000/evil.example.com',
	'/\u001b/evil.example.com',
	'/\u007f/evil.example.com',
	'\t//evil.example.com',
	'/x\t',
	// Backslash is a slash to the URL parser.
	'/\\evil.example.com',
	'/\\/evil.example.com',
	'\\/evil.example.com',
	// Protocol-relative, and paths that collapse to it.
	'//evil.example.com',
	'///evil.example.com',
	'/.//evil.example.com',
	'/././/evil.example.com',
	'/a/..//evil.example.com',
	'/%2e//evil.example.com',
	'/%2e%2e//evil.example.com',
	// Absolute URLs and other schemes.
	'https://evil.example.com',
	'http://evil.example.com/',
	'javascript:alert(1)',
	'JavaScript:alert(1)',
	'data:text/html,<script>alert(1)</script>',
	// Not a path.
	'',
	' /x',
	'x',
	'evil.example.com',
	'?x=1',
	'#x',
];

describe('safeRedirectPath', () => {
	for (const path of UNSAFE) {
		test(`${JSON.stringify(path)} is refused`, () => {
			assert.strictEqual(safeRedirectPath(path), null);
			assert.strictEqual(isSafeRedirectPath(path), false);
		});
	}

	const SAFE: Array<[string, string]> = [
		['/', '/'],
		['/dashboard', '/dashboard'],
		['/dashboard?tab=2', '/dashboard?tab=2'],
		['/dashboard?tab=2#top', '/dashboard?tab=2#top'],
		['/a/b/../c', '/a/c'],
		['/a/./b', '/a/b'],
		['/a b', '/a%20b'],
		['/ /evil.example.com', '/%20/evil.example.com'],
		['/%20/evil.example.com', '/%20/evil.example.com'],
		['/%09/evil.example.com', '/%09/evil.example.com'],
		['/%2F/evil.example.com', '/%2F/evil.example.com'],
		['/%5Cevil.example.com', '/%5Cevil.example.com'],
		['/q?next=//evil.example.com', '/q?next=//evil.example.com'],
		['/q?x=a b#c d', '/q?x=a%20b#c%20d'],
		['/café', '/caf%C3%A9'],
		['/　/x', '/%E3%80%80/x'],
	];
	for (const [path, expected] of SAFE) {
		test(`${JSON.stringify(path)} → ${JSON.stringify(expected)}, which stays on the app origin`, () => {
			assert.strictEqual(safeRedirectPath(path), expected);
			assert.strictEqual(landsOn(expected), APP);
			// Idempotent: the normalised form is itself safe and unchanged.
			assert.strictEqual(safeRedirectPath(expected), expected);
		});
	}

	test('a non-string is refused', () => {
		for (const value of [undefined, null, 0, {}, ['/x']]) assert.strictEqual(safeRedirectPath(value), null);
	});

	test('the bypasses of the old string check really do leave the origin', () => {
		// Emitted raw, a browser lands on evil.example.com.
		for (const raw of ['/\t/evil.example.com', '/\n/evil.example.com', '/\\evil.example.com']) {
			assert.notStrictEqual(landsOn(raw), APP, JSON.stringify(raw));
		}
		// Safe raw, but its normalised form is protocol-relative — so it is refused
		// rather than emitted as `//evil.example.com`.
		assert.strictEqual(new URL('/.//evil.example.com', APP).pathname, '//evil.example.com');
		assert.notStrictEqual(landsOn('//evil.example.com'), APP);
	});
});

describe('signInRedirectPath', () => {
	test('undefined stays undefined; a safe path is normalised', () => {
		assert.strictEqual(signInRedirectPath(undefined), undefined);
		assert.strictEqual(signInRedirectPath('/a b?x=1'), '/a%20b?x=1');
	});

	test('an unsafe path is a 400 InvalidParameter', () => {
		assert.throws(
			() => signInRedirectPath('/\t/evil.example.com'),
			(e: unknown) => e instanceof ApiError && e.status === 400 && isBlocksError(e, AuthErrors.InvalidParameter),
		);
	});
});
