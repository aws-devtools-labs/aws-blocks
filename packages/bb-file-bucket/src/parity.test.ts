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
import { Scope, getSdkIdentifiers, isBlocksError } from '@aws-blocks/core';
import { deriveBucketName } from './bucket-name.js';
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

// The keys both runtimes must reject identically. This is the whole point of
// the shared validator: a key rejected in local dev must be rejected on AWS too.
const INVALID_KEYS = ['../etc/passwd', 'a/../../b', '/leading', 'foo\x00bar', 'ctrl\x01char', '.', 'a/./b', 'a//b', 'a/'];

// Every public method that accepts an object key. Each is invoked with a single
// invalid key so both layers are asserted to reject it on the SAME method —
// guarding against a future divergence where one layer validates a method the
// other does not. deleteBatch takes an array; the rest take the key first.
const KEY_METHODS: ReadonlyArray<{
	name: string;
	call: (bucket: { [k: string]: (...args: any[]) => unknown }, key: string) => Promise<unknown>;
}> = [
	{ name: 'put', call: (b, k) => b.put(k, Buffer.from('x')) as Promise<unknown> },
	{ name: 'get', call: (b, k) => b.get(k) as Promise<unknown> },
	{ name: 'delete', call: (b, k) => b.delete(k) as Promise<unknown> },
	{ name: 'deleteBatch', call: (b, k) => b.deleteBatch([k]) as Promise<unknown> },
	{ name: 'getUrl', call: (b, k) => b.getUrl(k) as Promise<unknown> },
	{ name: 'putUrl', call: (b, k) => b.putUrl(k) as Promise<unknown> },
	{ name: 'createUploadHandle', call: (b, k) => b.createUploadHandle(k) as Promise<unknown> },
	{ name: 'listVersions', call: (b, k) => b.listVersions(k) as Promise<unknown> },
	{ name: 'restoreVersion', call: (b, k) => b.restoreVersion(k, 'v1') as Promise<unknown> },
];

describe('object-key validation has mock↔AWS parity', () => {
	for (const { name, call } of KEY_METHODS) {
		for (const key of INVALID_KEYS) {
			test(`the mock rejects ${JSON.stringify(key)} on ${name}()`, async () => {
				const mock = mockBucket();
				await assert.rejects(
					() => call(mock as unknown as { [k: string]: (...a: any[]) => unknown }, key),
					(err: Error) => err.name === 'ValidationFailed',
				);
			});

			test(`the AWS runtime rejects ${JSON.stringify(key)} on ${name}() without reaching S3`, async () => {
				// Any send() reaching the SDK fails the test: the key must be rejected
				// before the command is dispatched.
				const { bucket, sent } = awsBucket(() => { throw new Error('should not reach S3'); });
				await assert.rejects(
					() => call(bucket as unknown as { [k: string]: (...a: any[]) => unknown }, key),
					(err: Error) => err.name === 'ValidationFailed',
				);
				assert.strictEqual(sent().length, 0, 'no S3 command should have been sent');
			});
		}
	}
});

describe('deleteBatch rejects a mixed valid/invalid batch atomically on both layers', () => {
	// A batch that mixes a valid key BEFORE an invalid one. Both layers must
	// reject the whole batch without deleting the valid key — AWS validates the
	// whole batch before any S3 send, and the mock now validates every key up
	// front before deleting any (rather than deleting the valid key then throwing
	// on the invalid one).
	const batch = ['keep/me.txt', '../bad'];

	test('the mock leaves the valid key in place', async () => {
		const mock = mockBucket();
		await mock.put('keep/me.txt', 'content');
		await assert.rejects(
			() => mock.deleteBatch(batch),
			(err: Error) => err.name === 'ValidationFailed',
		);
		// The valid object preceding the invalid key must survive.
		assert.notStrictEqual(await mock.get('keep/me.txt'), null, 'valid key should not have been deleted');
	});

	test('the AWS runtime sends no delete command', async () => {
		const { bucket, sent } = awsBucket(() => { throw new Error('should not reach S3'); });
		await assert.rejects(
			() => bucket.deleteBatch(batch),
			(err: Error) => err.name === 'ValidationFailed',
		);
		assert.strictEqual(sent().length, 0, 'no S3 command should have been sent');
	});
});

describe('derived bucket name agrees between the AWS runtime and the mock', () => {
	// The CDK layer provisions `deriveBucketName(fullId)` (index.cdk.test.ts); the
	// runtime must resolve that same physical name, and the mock its `mock-` twin.
	for (const [label, parentId] of [
		['under the 63-char limit (unchanged)', 'root'],
		['over the 63-char limit (shortened)', 'p'.repeat(60)],
	] as const) {
		test(label, () => {
			const id = uniqueId();
			const aws = new AwsFileBucket(new Scope(`${parentId}-aws`), id);
			const mock = new MockFileBucket(new Scope(`${parentId}-mock`), id);
			const awsName = getSdkIdentifiers(aws).bucketName;
			assert.strictEqual(awsName, deriveBucketName(aws.fullId));
			assert.strictEqual(getSdkIdentifiers(mock).bucketName, `mock-${deriveBucketName(mock.fullId)}`);
			assert.ok(awsName.length <= 63, awsName);
			if (aws.fullId.length <= 63) assert.strictEqual(awsName, aws.fullId);
		});
	}
});
