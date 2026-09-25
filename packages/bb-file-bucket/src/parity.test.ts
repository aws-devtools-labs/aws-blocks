// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS↔mock parity for an unknown `versionId` on a versioned bucket, plus the
 * `restoreVersion()` CopySource encoding.
 *
 * History: AWS `get()` mapped only `NoSuchKey` → null, so an unknown `versionId`
 * threw while the mock returned null; AWS `restoreVersion()` let the raw S3 error
 * propagate (leaking `$metadata`), whereas the mock throws a clean,
 * `NoSuchVersion`-named error.
 *
 * The subtlety this file exists to pin down: S3 does **not** signal an unknown
 * `versionId` as `NoSuchVersion`. Verified against real S3 (us-west-2), an id S3
 * cannot resolve comes back as `InvalidArgument` on GetObject ("Invalid version
 * id specified", 400) and `InvalidRequest` on CopyObject — `NoSuchVersion` is
 * reserved for a well-formed id that no longer exists. An earlier guard that only
 * matched `NoSuchVersion` was therefore a no-op for its own motivating input.
 *
 * Following `bb-kv-store/parity.test.ts`, each case instantiates the mock *and*
 * the AWS runtime and asserts they agree — and captures the SDK input so a
 * behavior change (VersionId not sent, CopySource not encoded) fails loudly
 * rather than passing on a middleware that throws for every command.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { FileBucket as MockFileBucket, FileBucketErrors } from './index.mock.js';
import { FileBucket as AwsFileBucket } from './index.aws.js';

// Every bucket uses a unique fullId, so its `.bb-data/{fullId}/` is already
// isolated — no `.bb-data` wipe here, which would race the other test files'
// processes when the runner executes files concurrently.
let n = 0;
const uniqueId = () => `fb-parity-${Date.now()}-${n++}`;

/** A versioned mock FileBucket persisting to disk. */
function mockBucket(): MockFileBucket<{ versioned: true }> {
	return new MockFileBucket(new Scope('root'), uniqueId(), { versioned: true });
}

/**
 * A versioned AWS FileBucket whose S3 client is intercepted: `respond` produces
 * the command output (or throws to simulate an S3 error), and every sent input
 * is captured so tests can assert what actually reached the SDK.
 */
function awsBucket(respond: () => unknown = () => ({})): {
	bucket: AwsFileBucket<{ versioned: true }>;
	sent: () => { commandName: string; input: any }[];
} {
	const bucket = new AwsFileBucket(new Scope('root'), uniqueId(), { versioned: true });
	const captured: { commandName: string; input: any }[] = [];
	(bucket as any).s3.middlewareStack.add(
		(_next: any) => async (args: any) => {
			captured.push({ commandName: args.constructor?.name ?? '', input: args.input });
			return { output: respond() };
		},
		{ step: 'initialize', name: 'fb-parity-intercept', override: true },
	);
	return { bucket, sent: () => captured };
}

/** A realistic S3 SDK error, carrying the `$metadata` that must not reach the client. */
function s3Error(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	(err as any).$metadata = { httpStatusCode: 400, requestId: 'req-123', cfId: 'cf-abc' };
	return err;
}

describe('get() with an unknown versionId returns null in both runtimes', () => {
	// The names S3 actually raises for an unresolvable versionId on GetObject.
	for (const [label, err] of [
		['InvalidArgument (malformed / unresolvable id — the real S3 name)', s3Error('InvalidArgument', 'Invalid version id specified')],
		['NoSuchVersion (well-formed id that no longer exists)', s3Error('NoSuchVersion', 'The specified version does not exist.')],
	] as const) {
		test(`AWS folds ${label} to null, matching the mock`, async () => {
			// Mock: a real versioned bucket returns null for an unknown versionId.
			const mock = mockBucket();
			await mock.put('reports/q1.pdf', 'v1');
			assert.strictEqual(await mock.get('reports/q1.pdf', { versionId: 'does-not-exist' }), null);

			// AWS: the same input, with S3 raising the real error.
			const { bucket, sent } = awsBucket(() => { throw err; });
			assert.strictEqual(await bucket.get('reports/q1.pdf', { versionId: 'does-not-exist' }), null);
			// The VersionId must actually have reached the command — otherwise this
			// test would pass even if get() never forwarded it.
			assert.strictEqual(sent()[0].input.VersionId, 'does-not-exist');
		});
	}

	test('AWS still returns null for a missing key (NoSuchKey), matching the mock', async () => {
		const mock = mockBucket();
		assert.strictEqual(await mock.get('missing.txt'), null);

		const { bucket } = awsBucket(() => { throw s3Error('NoSuchKey', 'The specified key does not exist.'); });
		assert.strictEqual(await bucket.get('missing.txt'), null);
	});

	test('an InvalidArgument with NO versionId still propagates (not swallowed as not-found)', async () => {
		const { bucket } = awsBucket(() => { throw s3Error('InvalidArgument', 'some other invalid argument'); });
		await assert.rejects(() => bucket.get('reports/q1.pdf'), (e: Error) => e.name === 'InvalidArgument');
	});
});

describe('restoreVersion() maps an unknown version to a clean NoSuchVersion in both runtimes', () => {
	test('the mock throws a clean, name-prefixed NoSuchVersion (no $metadata)', async () => {
		const mock = mockBucket();
		await mock.put('reports/q1.pdf', 'v1');
		await assert.rejects(
			() => mock.restoreVersion('reports/q1.pdf', 'does-not-exist'),
			(err: Error) =>
				isBlocksError(err, FileBucketErrors.VersionNotFound) &&
				err.message === 'NoSuchVersion: Version "does-not-exist" does not exist for "reports/q1.pdf"' &&
				!('$metadata' in err),
		);
	});

	// The names S3 actually raises for an unresolvable versionId on CopyObject.
	for (const name of ['InvalidRequest', 'InvalidArgument', 'NoSuchVersion', 'NoSuchKey'] as const) {
		test(`AWS folds S3's ${name} to the same clean NoSuchVersion (no $metadata leak)`, async () => {
			const { bucket } = awsBucket(() => { throw s3Error(name, `raw S3 ${name}`); });
			await assert.rejects(
				() => bucket.restoreVersion('reports/q1.pdf', 'does-not-exist'),
				(err: Error) =>
					isBlocksError(err, FileBucketErrors.VersionNotFound) &&
					// Identical to the mock's message — full parity, not just the name.
					err.message === 'NoSuchVersion: Version "does-not-exist" does not exist for "reports/q1.pdf"' &&
					!('$metadata' in err),
			);
		});
	}

	test('a genuinely unrelated S3 error is NOT masked as NoSuchVersion', async () => {
		const { bucket } = awsBucket(() => { throw s3Error('AccessDenied', 'Access Denied'); });
		await assert.rejects(() => bucket.restoreVersion('reports/q1.pdf', 'v1'), (e: Error) => e.name === 'AccessDenied');
	});
});

describe('delete() with an unknown versionId is a silent no-op in both runtimes', () => {
	test('the mock swallows an unknown version', async () => {
		const mock = mockBucket();
		await mock.put('reports/q1.pdf', 'v1');
		await mock.delete('reports/q1.pdf', { versionId: 'does-not-exist' }); // must not throw
	});

	for (const name of ['InvalidArgument', 'NoSuchVersion'] as const) {
		test(`AWS swallows S3's ${name} when a versionId was supplied, matching the mock`, async () => {
			const { bucket, sent } = awsBucket(() => { throw s3Error(name, `raw S3 ${name}`); });
			await bucket.delete('reports/q1.pdf', { versionId: 'does-not-exist' }); // must not throw
			assert.strictEqual(sent()[0].input.VersionId, 'does-not-exist');
		});
	}

	test('an InvalidArgument with NO versionId still propagates', async () => {
		const { bucket } = awsBucket(() => { throw s3Error('InvalidArgument', 'some other invalid argument'); });
		await assert.rejects(() => bucket.delete('reports/q1.pdf'), (e: Error) => e.name === 'InvalidArgument');
	});
});

describe('restoreVersion() encodes both the key and the caller-supplied versionId in CopySource', () => {
	test('a versionId containing header-hostile characters is percent-encoded', async () => {
		const { bucket, sent } = awsBucket();
		// `&`, `?`, `#`, space would otherwise corrupt the x-amz-copy-source header.
		await bucket.restoreVersion('reports/q1 report.pdf', 'v1&x=1?y=2 #frag');
		const { input } = sent()[0];
		assert.ok(input.CopySource, 'restoreVersion sends a CopyObject with a CopySource');
		const [, query] = String(input.CopySource).split('?versionId=');
		assert.strictEqual(query, encodeURIComponent('v1&x=1?y=2 #frag'));
		// The key segment is encoded too (space → %20), and the '/' separator kept.
		assert.ok(input.CopySource.includes('/reports/q1%20report.pdf?versionId='), input.CopySource);
	});
});
