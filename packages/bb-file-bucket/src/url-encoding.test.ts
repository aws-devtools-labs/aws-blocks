// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for presigned URL generation — ensures URLs are valid and parseable
 * for paths containing special characters (#, ?, %, spaces).
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { Scope } from '@aws-cdk-blocks/core';
import { FileBucket } from './index.mock.js';

const scope = new Scope('enc');

beforeEach(() => {
	const dir = '.cdk-blocks/local/data';
	try {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('enc-')) {
					rmSync(`${dir}/${entry}`, { recursive: true, force: true });
				}
			}
		}
	} catch {}
});

describe('getUrl: URL encoding', () => {
	test('path with # produces valid URL (# encoded as %23)', async () => {
		const bucket = new FileBucket(scope, 'url-hash');
		const url = await bucket.getUrl('file#1.txt');
		const parsed = new URL(url);

		assert.strictEqual(parsed.hash, '', 'Hash fragment should be empty — # must be encoded');
		assert.ok(parsed.searchParams.has('token'), 'Token must be in query params, not lost in fragment');
	});

	test('path with ? produces valid URL (? encoded as %3F)', async () => {
		const bucket = new FileBucket(scope, 'url-question');
		const url = await bucket.getUrl('what?file.txt');
		const parsed = new URL(url);

		assert.ok(parsed.searchParams.has('token'), 'Token must be accessible in query params');
		assert.ok(
			!parsed.pathname.endsWith('what'),
			'Pathname should not be truncated at the ? character',
		);
	});

	test('path with % literal produces valid URL (% encoded as %25)', async () => {
		const bucket = new FileBucket(scope, 'url-percent');
		const url = await bucket.getUrl('100%done.txt');
		const parsed = new URL(url);

		assert.ok(parsed.searchParams.has('token'), 'Token must be in query params');
		// % must be encoded as %25 to avoid ambiguity
		assert.ok(
			url.includes('100%25done.txt'),
			`URL should encode % as %25. Got: ${url}`,
		);
	});

	test('already-encoded path is not double-encoded', async () => {
		// A file literally named "file%231.txt" (contains percent-two-three)
		// should encode to "file%25231.txt" — the % becomes %25
		const bucket = new FileBucket(scope, 'url-double');
		const url = await bucket.getUrl('file%231.txt');
		const parsed = new URL(url);

		assert.ok(parsed.searchParams.has('token'), 'Token must be in query params');
		assert.ok(
			url.includes('file%25231.txt'),
			`Literal % in filename should be encoded to %25. Got: ${url}`,
		);
	});
});

describe('putUrl: URL encoding', () => {
	test('path with # produces valid URL', async () => {
		const bucket = new FileBucket(scope, 'put-hash');
		const url = await bucket.putUrl('upload#1.bin');
		const parsed = new URL(url);

		assert.strictEqual(parsed.hash, '', 'Hash fragment should be empty');
		assert.ok(parsed.searchParams.has('token'), 'Token must be in query params');
	});
});

describe('getUrl: versioned with special chars', () => {
	test('versionId param preserved alongside encoded path', async () => {
		const bucket = new FileBucket(scope, 'url-ver', { versioned: true });
		await bucket.put('file#1.txt', 'v1');
		await bucket.put('file#1.txt', 'v2');

		const versions = await bucket.listVersions('file#1.txt');
		const oldest = versions[versions.length - 1];
		const url = await bucket.getUrl('file#1.txt', { versionId: oldest.versionId });
		const parsed = new URL(url);

		assert.ok(parsed.searchParams.has('token'), 'Token in query');
		assert.strictEqual(parsed.searchParams.get('versionId'), oldest.versionId);
		assert.strictEqual(parsed.hash, '', 'No fragment');
	});
});

describe('FileBucketErrors completeness', () => {
	test('FileBucketErrors includes FileTooLarge', async () => {
		const { FileBucketErrors } = await import('./errors.js');
		assert.ok(
			'FileTooLarge' in FileBucketErrors,
			`FileBucketErrors should include FileTooLarge. Keys: ${Object.keys(FileBucketErrors)}`,
		);
		assert.strictEqual(
			(FileBucketErrors as any).FileTooLarge,
			'EntityTooLarge',
		);
	});
});
