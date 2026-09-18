// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { FileBucket as AwsFileBucket } from './index.aws.js';
import { FileBucket as MockFileBucket } from './index.mock.js';
import { validatePresignedUrlExpiry } from './presigned-url.js';

test('accepts presigned URL expiration values supported by Signature Version 4', () => {
	assert.strictEqual(validatePresignedUrlExpiry(1), 1);
	assert.strictEqual(validatePresignedUrlExpiry(604800), 604800);
});

test('rejects invalid presigned URL expiration values', () => {
	for (const expiresIn of [0, -1, 1.5, NaN, Infinity, 604801]) {
		assert.throws(
			() => validatePresignedUrlExpiry(expiresIn),
			(err: unknown) => isBlocksError(err, 'ValidationFailed') && /integer between 1 and 604800 seconds/.test((err as Error).message),
			`expiresIn=${String(expiresIn)} should throw ValidationFailed`,
		);
	}
});

test('mock and AWS runtimes reject invalid expiration values before URL generation', async () => {
	const scope = new Scope('presigned-url-validation');
	const buckets = [
		new MockFileBucket(scope, 'mock'),
		new AwsFileBucket(scope, 'aws'),
	];

	for (const expiresIn of [0, -1, 1.5, NaN, Infinity, 604801]) {
		for (const bucket of buckets) {
			for (const createUrl of [
				() => bucket.getUrl('file.txt', { expiresIn }),
				() => bucket.putUrl('file.txt', { expiresIn }),
				() => bucket.createUploadHandle('file.txt', { expiresIn }),
			]) {
				await assert.rejects(
					createUrl(),
					(err: unknown) => isBlocksError(err, 'ValidationFailed') && /integer between 1 and 604800 seconds/.test((err as Error).message),
					`expiresIn=${String(expiresIn)} should be rejected`,
				);
			}
		}
	}
});
