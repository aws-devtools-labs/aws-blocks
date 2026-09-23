// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS↔mock parity for an unknown `versionId` on a versioned bucket.
 *
 * History: AWS `get()` mapped only `NoSuchKey` → null, so an unknown `versionId`
 * (which S3 raises as `NoSuchVersion`) threw — while the mock returns null. And
 * AWS `restoreVersion()` let the raw S3 error propagate (leaking `$metadata`),
 * whereas the mock throws a clean, `NoSuchVersion`-named error. These pin both to
 * the mock's behavior without touching the network.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { FileBucket } from './index.aws.js';

let n = 0;
const uniqueId = () => `fb-parity-${Date.now()}-${n++}`;

/** A versioned AWS FileBucket whose S3 client throws `err` for every command. */
function bucketWhoseS3Throws(err: Error): FileBucket<{ versioned: true }> {
	const bucket = new FileBucket(new Scope('root'), uniqueId(), { versioned: true });
	(bucket as any).s3.middlewareStack.add(
		(_next: any) => async () => {
			throw err;
		},
		{ step: 'initialize', name: 'fb-parity-throw', override: true },
	);
	return bucket;
}

function s3Error(name: string): Error {
	const err = new Error(`The specified ${name} does not exist.`);
	err.name = name;
	// Real S3 SDK errors carry this — its ARNs/requestId must NOT reach the client.
	(err as any).$metadata = { httpStatusCode: 404, requestId: 'req-123', cfId: 'cf-abc' };
	return err;
}

test('get() with an unknown versionId returns null (NoSuchVersion → null, matches the mock)', async () => {
	const bucket = bucketWhoseS3Throws(s3Error('NoSuchVersion'));
	const result = await bucket.get('reports/q1.pdf', { versionId: 'does-not-exist' });
	assert.strictEqual(result, null);
});

test('get() still returns null for a missing key (NoSuchKey → null, unchanged)', async () => {
	const bucket = bucketWhoseS3Throws(s3Error('NoSuchKey'));
	const result = await bucket.get('missing.txt');
	assert.strictEqual(result, null);
});

test('restoreVersion() with an unknown version throws a clean NoSuchVersion (no $metadata leak)', async () => {
	const bucket = bucketWhoseS3Throws(s3Error('NoSuchVersion'));
	await assert.rejects(
		() => bucket.restoreVersion('reports/q1.pdf', 'does-not-exist'),
		(err: Error) =>
			isBlocksError(err, 'NoSuchVersion') &&
			/does not exist for "reports\/q1\.pdf"/.test(err.message) &&
			// The raw SDK metadata must not ride along on the re-thrown error.
			!('$metadata' in err),
	);
});
