// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared, portable key validator (`assertValidKey`). The
 * validator is the half of key validation that must hold identically on every
 * runtime, so it is tested here directly (no filesystem, no SDK) and its
 * parity across the mock and AWS layers is asserted in `parity.test.ts`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { ApiError, isBlocksError, isWireSafeError } from '@aws-blocks/core';
import { assertValidKey, assertValidPrefix } from './validation.js';

describe('assertValidKey rejects invalid keys with a ValidationFailed error', () => {
	for (const key of [
		'../etc/passwd',
		'a/../../b',
		'/leading',
		'foo\x00bar',
		'ctrl\x01char',
		'.',
		'a/./b',
		'a//b', // interior empty segment — collapses on the mock, distinct on S3
		'a/', // trailing slash — same divergence
	]) {
		test(`rejects ${JSON.stringify(key)}`, () => {
			assert.throws(
				() => assertValidKey(key),
				(err: Error) => err.name === 'ValidationFailed',
			);
		});
	}

	test('rejects an empty string', () => {
		assert.throws(() => assertValidKey(''), (err: Error) => err.name === 'ValidationFailed');
	});

	test('rejects a non-string', () => {
		// The public type is `string`, but a JS caller can still pass a non-string;
		// the runtime guard must hold. Cast is test-only plumbing.
		assert.throws(
			() => assertValidKey(undefined as unknown as string),
			(err: Error) => err.name === 'ValidationFailed',
		);
	});
});

describe('assertValidKey accepts legitimate keys', () => {
	for (const key of [
		'uploads/user/photo.jpg',
		'my..file.txt', // dots inside a filename, not a path segment
		'a/b/c.txt',
		'file with spaces.png',
	]) {
		test(`accepts ${JSON.stringify(key)}`, () => {
			assert.doesNotThrow(() => assertValidKey(key));
		});
	}
});

describe('assertValidKey errors are wire-safe', () => {
	for (const key of ['a//b', '../x']) {
		test(`rejects ${JSON.stringify(key)} with a branded error the RPC sanitizer keeps`, () => {
			let caught: unknown;
			try {
				assertValidKey(key);
			} catch (e) {
				caught = e;
			}
			assert.ok(caught instanceof Error);
			assert.strictEqual(caught.name, 'ValidationFailed');
			assert.match(caught.message, /^ValidationFailed: /);
			assert.ok(isWireSafeError(caught), 'ValidationFailed must be branded so name/message cross the RPC wire');
			assert.ok(isBlocksError(caught, 'ValidationFailed'));
		});
	}
});

describe('assertValidKey rejects backslashes, %2e traversal segments and unsupported Unicode', () => {
	const cases: ReadonlyArray<[string, string]> = [
		['a\\b', 'ValidationFailed: Invalid key: backslash not allowed'],
		['a/%2e%2e/b', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['%2E%2E/b', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/.%2e', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/%2e/b', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['nel\u0085', 'ValidationFailed: Invalid key: contains control characters'],
		['c1\u0080', 'ValidationFailed: Invalid key: contains control characters'],
		['c1\u009f', 'ValidationFailed: Invalid key: contains control characters'],
		['ls\u2028', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['ps\u2029', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['lre\u202a', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['rlo\u202e', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['lri\u2066', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['pdi\u2069', 'ValidationFailed: Invalid key: contains Unicode line-separator or bidirectional formatting characters'],
		['a/..%2f../b', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/%2e%2e%2fb', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/%2E%2E%2Fb', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/b%2f..', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/%2e%2e%5cb', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['a/b%5C.%5Cc', 'ValidationFailed: Invalid key: contains a path traversal segment'],
		['x'.repeat(1025), 'ValidationFailed: Invalid key: longer than 1024 bytes in UTF-8'],
		['\u00e9'.repeat(600), 'ValidationFailed: Invalid key: longer than 1024 bytes in UTF-8'],
	];
	for (const [key, message] of cases) {
		test(`rejects ${JSON.stringify(key)} with a static message`, () => {
			assert.throws(() => assertValidKey(key), (err: Error) => err.name === 'ValidationFailed' && err.message === message);
		});
	}

	for (const key of ['100%done.txt', '50%25.txt', 'a/%2efile', 'a/file%2e', 'a/b%2e%2ec', '\u00e9t\u00e9.txt', 'a\u202fb', 'a\u2065b', 'a\u206ab', 'a%2fb', 'a%5Cb', 'a/b%2f.c', 'a/%252e%252e/b', 'x'.repeat(1024), '\u00e9'.repeat(512)]) {
		test(`accepts ${JSON.stringify(key)}`, () => {
			assert.doesNotThrow(() => assertValidKey(key));
		});
	}
});

describe('ValidationFailed is an ApiError with HTTP status 400', () => {
	test('assertValidKey', () => {
		assert.throws(() => assertValidKey('../x'), (err: unknown) => err instanceof ApiError && err.status === 400 && err.name === 'ValidationFailed');
	});
	test('assertValidPrefix', () => {
		assert.throws(() => assertValidPrefix('/x'), (err: unknown) => err instanceof ApiError && err.status === 400 && err.name === 'ValidationFailed');
	});
	test('the RPC sanitizer forwards it as a 400 with its name and message', () => {
		let caught: unknown;
		try {
			assertValidKey('a//b');
		} catch (e) {
			caught = e;
		}
		// Branch 1 of core's sanitizer keys on a branded error with a numeric status.
		assert.ok(isWireSafeError(caught));
		assert.strictEqual((caught as ApiError).status, 400);
		assert.strictEqual((caught as ApiError).message, 'ValidationFailed: Invalid key: contains an empty path segment');
	});
});

describe('assertValidPrefix', () => {
	for (const prefix of [undefined, '', 'uploads/', 'uploads/user-1/', 'reports/2024-0', 'a', '100%done']) {
		test(`accepts ${JSON.stringify(prefix)}`, () => {
			assert.doesNotThrow(() => assertValidPrefix(prefix));
		});
	}
	const cases: ReadonlyArray<[string, RegExp]> = [
		['/uploads', /^ValidationFailed: Invalid prefix: leading slash not allowed$/],
		['a//b', /^ValidationFailed: Invalid prefix: contains an empty path segment$/],
		['a//', /^ValidationFailed: Invalid prefix: contains an empty path segment$/],
		['..', /^ValidationFailed: Invalid prefix: contains a path traversal segment$/],
		['a/../', /^ValidationFailed: Invalid prefix: contains a path traversal segment$/],
		['a/%2E%2e/', /^ValidationFailed: Invalid prefix: contains a path traversal segment$/],
		['a\\b/', /^ValidationFailed: Invalid prefix: backslash not allowed$/],
		['a\x00/', /^ValidationFailed: Invalid prefix: contains control characters$/],
		['a\u2069/', /^ValidationFailed: Invalid prefix: contains Unicode line-separator or bidirectional formatting characters$/],
	];
	for (const [prefix, message] of cases) {
		test(`rejects ${JSON.stringify(prefix)}`, () => {
			assert.throws(() => assertValidPrefix(prefix), (err: Error) => message.test(err.message));
		});
	}
	test('rejects a non-string', () => {
		assert.throws(() => assertValidPrefix(42 as unknown as string), (err: Error) => err.name === 'ValidationFailed');
	});
});
