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
import { assertValidKey } from './validation.js';

describe('assertValidKey rejects invalid keys with a ValidationFailed error', () => {
	for (const key of [
		'../etc/passwd',
		'a/../../b',
		'/leading',
		'foo\x00bar',
		'ctrl\x01char',
		'.',
		'a/./b',
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
