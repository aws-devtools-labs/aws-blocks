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
import { S3Client } from '@aws-sdk/client-s3';
import { ApiError, Scope, getSdkIdentifiers, isBlocksError, isWireSafeError } from '@aws-blocks/core';
import { deriveBucketName } from './bucket-name.js';
import { FileBucket as MockFileBucket, FileBucketErrors } from './index.mock.js';
import { FileBucket as AwsFileBucket } from './index.aws.js';
import type { FileBucketOptions } from './types.js';

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
				err.message === 'NoSuchVersion: The requested version does not exist' &&
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
					err.message === 'NoSuchVersion: The requested version does not exist' &&
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
const INVALID_KEYS = [
	'../etc/passwd', 'a/../../b', '/leading', 'foo\x00bar', 'ctrl\x01char', '.', 'a/./b', 'a//b', 'a/',
	'a\\b', 'a/%2e%2e/b', '%2E', 'a/.%2e', 'nel\u0085x', 'c1\u009fx', 'ls\u2028x', 'ps\u2029x', 'rlo\u202ex', 'iso\u2066x',
];

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

describe('presigned uploads are rejected on an objectLock bucket in both runtimes', () => {
	// Verified against real S3 (us-west-2): an upload to a bucket with an Object
	// Lock default retention needs a SIGNED Content-MD5 / x-amz-checksum-* header
	// (unsigned ones fail with "headers present in the request which were not
	// signed"), so a URL presigned before the file is known always fails with 400.
	// Both runtimes reject up front instead of returning a URL that can't work.
	const objectLock = { mode: 'governance', retentionDays: 1 } as const;
	const runtimes = [
		['mock', () => new MockFileBucket(new Scope('root'), uniqueId(), { objectLock })],
		['AWS', () => awsLockedBucket()],
	] as const;
	function awsLockedBucket(): AwsFileBucket {
		const bucket = new AwsFileBucket(new Scope('root'), uniqueId(), { objectLock });
		(bucket as any).s3.middlewareStack.add(
			(_next: any) => async () => { throw new Error('reached S3'); },
			{ step: 'initialize', name: 'fb-parity-no-s3', override: true },
		);
		return bucket;
	}
	for (const [label, make] of runtimes) {
		for (const method of ['putUrl', 'createUploadHandle'] as const) {
			test(`${label}: ${method}() throws PresignedUploadUnsupported`, async () => {
				const bucket = make();
				await assert.rejects(
					() => bucket[method]('a.txt'),
					(err: unknown) => isBlocksError(err, FileBucketErrors.PresignedUploadUnsupported)
						&& /Upload through the backend with put\(\) instead/.test((err as Error).message),
				);
			});
		}
	}
	test('mock: getUrl() still works on an objectLock bucket', async () => {
		const bucket = new MockFileBucket(new Scope('root'), uniqueId(), { objectLock });
		assert.ok(await bucket.getUrl('a.txt'));
	});
	test('a wrapped bucket (fromExisting) is not treated as objectLock', async () => {
		const bucket = new MockFileBucket(new Scope('root'), uniqueId(), {
			bucket: MockFileBucket.fromExisting('existing'),
			objectLock,
		});
		assert.ok(await bucket.putUrl('a.txt'));
	});
});

// ── Upload constraints, download disposition and scan prefixes ───────────────

/**
 * An AWS FileBucket whose S3 client has static credentials, so `getSignedUrl`
 * produces a real SigV4 URL offline, and whose sends are captured (and answered
 * with an empty listing) so a test can assert what reached the SDK.
 */
function awsSigningBucket(options: FileBucketOptions = {}): {
	bucket: AwsFileBucket;
	sent: () => { input: any }[];
} {
	const bucket = new AwsFileBucket(new Scope('root'), uniqueId(), options);
	const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' } });
	const captured: { input: any }[] = [];
	// Intercept send() rather than the middleware stack: getSignedUrl runs the
	// same stack to presign, and a short-circuiting middleware would break it.
	(client as any).send = async (command: { input: unknown }) => {
		captured.push({ input: command.input });
		return { Contents: [] };
	};
	(bucket as any).s3 = client;
	return { bucket, sent: () => captured };
}

/** Drain an async iterable (the lib target predates `Array.fromAsync`). */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iterable) items.push(item);
	return items;
}

/** Decode a mock presigned URL's token payload (the values the dev server enforces). */
function mockTokenPayload(url: string): Record<string, unknown> {
	const token = new URL(url).searchParams.get('token') ?? '';
	return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
}

function signedHeaders(url: string): string[] {
	return (new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
}

/** A `ValidationFailed` that the RPC serializer answers as HTTP 400. */
function isValidation400(err: unknown): boolean {
	return isBlocksError(err, 'ValidationFailed') && err instanceof ApiError && err.status === 400;
}

describe('presigned uploads always sign a Content-Type in both runtimes', () => {
	test('AWS signs content-type, defaulting to application/octet-stream', async () => {
		const { bucket } = awsSigningBucket();
		const url = await bucket.putUrl('a.bin');
		assert.ok(signedHeaders(url).includes('content-type'), url);
		const handle = await bucket.createUploadHandle('a.bin');
		assert.strictEqual(handle.toJSON().contentType, 'application/octet-stream');
		assert.ok(signedHeaders(handle.getUrl()).includes('content-type'));
	});

	test('the mock signs the same default', async () => {
		const mock = mockBucket();
		assert.strictEqual(mockTokenPayload(await mock.putUrl('a.bin')).contentType, 'application/octet-stream');
		const handle = await mock.createUploadHandle('a.bin');
		assert.strictEqual(handle.toJSON().contentType, 'application/octet-stream');
		assert.strictEqual(mockTokenPayload(handle.getUrl()).contentType, 'application/octet-stream');
	});

	test('a caller-supplied contentType is signed unchanged in both runtimes', async () => {
		const { bucket } = awsSigningBucket();
		assert.strictEqual((await bucket.createUploadHandle('a.txt', { contentType: 'text/plain; charset=utf-8' })).toJSON().contentType, 'text/plain; charset=utf-8');
		const mock = mockBucket();
		assert.strictEqual(mockTokenPayload(await mock.putUrl('a.txt', { contentType: 'text/plain; charset=utf-8' })).contentType, 'text/plain; charset=utf-8');
	});

	test('AWS put() stores the same default content type as the mock', async () => {
		const { bucket, sent } = awsSigningBucket();
		await bucket.put('a.bin', 'x');
		assert.strictEqual(sent()[0].input.ContentType, 'application/octet-stream');
		const mock = mockBucket();
		await mock.put('a.bin', 'x');
		assert.strictEqual((await mock.get('a.bin'))?.contentType, 'application/octet-stream');
	});
});

describe('allowedContentTypes is enforced identically', () => {
	const allowedContentTypes = ['image/*', 'application/pdf'];
	const runtimes = [
		['mock', () => new MockFileBucket(new Scope('root'), uniqueId(), { allowedContentTypes })],
		['AWS', () => awsSigningBucket({ allowedContentTypes }).bucket],
	] as const;
	for (const [label, make] of runtimes) {
		test(`${label}: accepts exact, wildcard, case-insensitive and parameterized matches`, async () => {
			const bucket = make();
			for (const contentType of ['application/pdf', 'image/png', 'IMAGE/JPEG', 'application/pdf; foo=bar']) {
				assert.ok(await bucket.putUrl('a', { contentType }), contentType);
				await bucket.createUploadHandle('a', { contentType });
				await bucket.put('a', 'x', { contentType });
			}
		});
		test(`${label}: rejects an unlisted type, and the octet-stream default, with a 400 ValidationFailed`, async () => {
			const bucket = make();
			for (const contentType of ['text/html', 'imagex/png', 'image-x/png', undefined]) {
				for (const call of [
					() => bucket.putUrl('a', { contentType }),
					() => bucket.createUploadHandle('a', { contentType }),
					() => bucket.put('a', 'x', { contentType }),
				]) {
					await assert.rejects(call, (err: unknown) =>
						isValidation400(err) && (err as Error).message === 'ValidationFailed: The content type is not allowed for this bucket');
				}
			}
		});
	}

	for (const bad of [[], [''], ['image'], ['image/png; charset=x'], ['*'], [42]]) {
		test(`mock and CDK-shared validation reject allowedContentTypes ${JSON.stringify(bad)} at construction`, () => {
			const allowed = bad as unknown as string[];
			assert.throws(() => new MockFileBucket(new Scope('root'), uniqueId(), { allowedContentTypes: allowed }), /allowedContentTypes/);
			assert.throws(() => new AwsFileBucket(new Scope('root'), uniqueId(), { allowedContentTypes: allowed }), /allowedContentTypes/);
		});
	}
});

describe('contentType must be a single well-formed media type in both runtimes', () => {
	const INVALID_MESSAGE = 'ValidationFailed: Invalid contentType: must be a single type/subtype media type with optional parameters';
	const runtimes = [
		['mock', (o: FileBucketOptions = {}) => new MockFileBucket(new Scope('root'), uniqueId(), o)],
		['AWS', (o: FileBucketOptions = {}) => awsSigningBucket(o).bucket],
	] as const;
	const INVALID = [
		'',
		' ',
		'image/png, text/html',
		'application/pdf; a=b, text/html',
		'text/plain; charset="utf-8", text/html',
		'image/pngé',
		'text/plain; name="résumé"',
		'text/plain\r\nX-Injected: 1',
		'text/plain\u0085',
		'text/plain\u007f',
		'text/plain; a="b"c"',
		'text/plain;',
		'text/plain; a',
		'text',
		'text/',
		'/plain',
	];
	// [caller value, canonical value signed and returned]
	const VALID: ReadonlyArray<[string, string]> = [
		['text/plain; charset=utf-8', 'text/plain; charset=utf-8'],
		['multipart/form-data; boundary="a b"', 'multipart/form-data; boundary="a b"'],
		['text/plain;charset=utf-8', 'text/plain; charset=utf-8'],
		['text/plain;  charset=UTF-8', 'text/plain; charset=UTF-8'],
		['text/plain ; charset = utf-8', 'text/plain; charset=utf-8'],
		['text/plain\t;\tcharset\t=\tutf-8', 'text/plain; charset=utf-8'],
		['application/vnd.api+json', 'application/vnd.api+json'],
		['Text/Plain;A=B', 'Text/Plain; A=B'],
		['text/plain; a="x, y";b="esc\\"aped"', 'text/plain; a="x, y"; b="esc\\"aped"'],
		['text/plain;a="  ;  =  "', 'text/plain; a="  ;  =  "'],
	];
	for (const [label, make] of runtimes) {
		test(`${label}: rejects malformed values with or without allowedContentTypes`, async () => {
			for (const options of [{}, { allowedContentTypes: ['image/*', 'application/pdf', 'text/plain'] }]) {
				const bucket = make(options);
				for (const contentType of INVALID) {
					for (const call of [
						() => bucket.putUrl('a', { contentType }),
						() => bucket.createUploadHandle('a', { contentType }),
						() => bucket.put('a', 'x', { contentType }),
					]) {
						await assert.rejects(call, (err: unknown) =>
							isValidation400(err) && (err as Error).message === INVALID_MESSAGE, JSON.stringify(contentType));
					}
				}
			}
		});
		test(`${label}: accepts well-formed values and signs them in canonical form`, async () => {
			const bucket = make();
			for (const [contentType, canonical] of VALID) {
				assert.strictEqual((await bucket.createUploadHandle('a', { contentType })).toJSON().contentType, canonical);
				assert.ok(await bucket.putUrl('a', { contentType }), contentType);
				await bucket.put('a', 'x', { contentType });
			}
		});
		test(`${label}: a type/* wildcard matches the type part exactly`, async () => {
			const bucket = make({ allowedContentTypes: ['image/*', 'text/plain', 'multipart/form-data'] });
			for (const contentType of ['image/png', 'IMAGE/webp', 'text/plain; charset=utf-8', 'multipart/form-data; boundary="a b"']) {
				assert.ok(await bucket.putUrl('a', { contentType }), contentType);
			}
			for (const contentType of ['imagex/png', 'image-x/png', 'text/plainx']) {
				await assert.rejects(() => bucket.putUrl('a', { contentType }), (err: unknown) =>
					isValidation400(err) && (err as Error).message === 'ValidationFailed: The content type is not allowed for this bucket');
			}
		});
	}
});

describe('a type/* wildcard does not match active document types in both runtimes', () => {
	const ACTIVE = ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript'];
	const NOT_ALLOWED = 'ValidationFailed: The content type is not allowed for this bucket';
	const runtimes = [
		['mock', (o: FileBucketOptions) => new MockFileBucket(new Scope('root'), uniqueId(), o)],
		['AWS', (o: FileBucketOptions) => awsSigningBucket(o).bucket],
	] as const;
	for (const [label, make] of runtimes) {
		test(`${label}: text/*, image/* and application/* reject the active types`, async () => {
			const bucket = make({ allowedContentTypes: ['text/*', 'image/*', 'application/*'] });
			for (const contentType of [...ACTIVE, 'TEXT/HTML; charset=utf-8', 'Image/SVG+XML']) {
				for (const call of [
					() => bucket.putUrl('a', { contentType }),
					() => bucket.createUploadHandle('a', { contentType }),
					() => bucket.put('a', 'x', { contentType }),
				]) {
					await assert.rejects(call, (err: unknown) =>
						isValidation400(err) && (err as Error).message === NOT_ALLOWED, contentType);
				}
			}
			for (const contentType of ['text/plain', 'text/csv', 'image/png', 'application/json', 'application/pdf']) {
				assert.ok(await bucket.putUrl('a', { contentType }), contentType);
			}
		});
		test(`${label}: an active type listed exactly is accepted`, async () => {
			const bucket = make({ allowedContentTypes: ['image/*', ...ACTIVE] });
			for (const contentType of [...ACTIVE, 'IMAGE/SVG+XML', 'text/html; charset=utf-8']) {
				assert.ok(await bucket.putUrl('a', { contentType }), contentType);
				await bucket.put('a', 'x', { contentType });
			}
		});
	}
});

describe('contentLength and maxUploadBytes are enforced identically', () => {
	test('AWS signs content-length when contentLength is given', async () => {
		const { bucket } = awsSigningBucket();
		const url = await bucket.putUrl('a', { contentLength: 42 });
		assert.ok(signedHeaders(url).includes('content-length'), url);
		assert.ok(!signedHeaders(await bucket.putUrl('a')).includes('content-length'));
	});

	test('the mock signs the same contentLength', async () => {
		const mock = mockBucket();
		assert.strictEqual(mockTokenPayload(await mock.putUrl('a', { contentLength: 42 })).contentLength, 42);
		assert.strictEqual(mockTokenPayload(await mock.putUrl('a')).contentLength, undefined);
	});

	const runtimes = [
		['mock', (o: FileBucketOptions = {}) => new MockFileBucket(new Scope('root'), uniqueId(), o)],
		['AWS', (o: FileBucketOptions = {}) => awsSigningBucket(o).bucket],
	] as const;
	for (const [label, make] of runtimes) {
		test(`${label}: rejects an invalid contentLength`, async () => {
			const bucket = make();
			for (const contentLength of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '10' as unknown as number]) {
				await assert.rejects(() => bucket.putUrl('a', { contentLength }), (err: unknown) =>
					isValidation400(err) && /Invalid contentLength/.test((err as Error).message));
			}
			assert.ok(await bucket.putUrl('a', { contentLength: 0 }));
		});

		test(`${label}: maxUploadBytes requires contentLength and caps it and put()`, async () => {
			const bucket = make({ maxUploadBytes: 10 });
			for (const method of ['putUrl', 'createUploadHandle'] as const) {
				await assert.rejects(() => bucket[method]('a'), (err: unknown) =>
					isValidation400(err) && /contentLength is required/.test((err as Error).message));
				await assert.rejects(() => bucket[method]('a', { contentLength: 11 }), (err: unknown) =>
					isValidation400(err) && /exceeds the maximum size/.test((err as Error).message));
				assert.ok(await bucket[method]('a', { contentLength: 10 }));
			}
			await assert.rejects(() => bucket.put('a', Buffer.alloc(11)), (err: unknown) =>
				isValidation400(err) && /exceeds the maximum size/.test((err as Error).message));
			await bucket.put('a', Buffer.alloc(10));
		});
	}

	for (const bad of [0, -1, 1.5, Number.NaN, '10']) {
		test(`maxUploadBytes ${JSON.stringify(bad)} is rejected at construction by the mock and AWS runtime`, () => {
			const maxUploadBytes = bad as unknown as number;
			assert.throws(() => new MockFileBucket(new Scope('root'), uniqueId(), { maxUploadBytes }), /maxUploadBytes must be a positive integer/);
			assert.throws(() => new AwsFileBucket(new Scope('root'), uniqueId(), { maxUploadBytes }), /maxUploadBytes must be a positive integer/);
		});
	}

	test('a wrapped bucket still enforces the constraints (mock)', async () => {
		const bucket = new MockFileBucket(new Scope('root'), uniqueId(), {
			bucket: MockFileBucket.fromExisting('existing'),
			maxUploadBytes: 1,
		});
		await assert.rejects(() => bucket.put('a', 'xx'), isValidation400);
	});
});

describe('getUrl({ attachment }) signs the same Content-Disposition in both runtimes', () => {
	const cases: ReadonlyArray<[boolean | string | undefined, string | undefined]> = [
		[undefined, undefined],
		[false, undefined],
		[true, 'attachment'],
		['report.pdf', `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`],
		['a"b\\c%.txt', `attachment; filename="a_b_c_.txt"; filename*=UTF-8''a%22b%5Cc%25.txt`],
		['résumé (1).pdf', `attachment; filename="r_sum_ (1).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf`],
		['line\r\nbreak.txt', `attachment; filename="linebreak.txt"; filename*=UTF-8''linebreak.txt`],
	];
	for (const [attachment, expected] of cases) {
		test(`attachment=${JSON.stringify(attachment)}`, async () => {
			const { bucket } = awsSigningBucket();
			const awsUrl = new URL(await bucket.getUrl('a.pdf', { attachment }));
			assert.strictEqual(awsUrl.searchParams.get('response-content-disposition') ?? undefined, expected);
			const mock = mockBucket();
			assert.strictEqual(mockTokenPayload(await mock.getUrl('a.pdf', { attachment })).contentDisposition, expected);
			// getFileHandle forwards the option.
			const handle = await bucket.getFileHandle('a.pdf', { attachment });
			assert.strictEqual(new URL(handle.getUrl()).searchParams.get('response-content-disposition') ?? undefined, expected);
		});
	}

	for (const bad of ['', '\r\n', 1, {}]) {
		test(`attachment=${JSON.stringify(bad)} is rejected by both runtimes`, async () => {
			const attachment = bad as unknown as string;
			await assert.rejects(() => awsSigningBucket().bucket.getUrl('a', { attachment }), isValidation400);
			await assert.rejects(() => mockBucket().getUrl('a', { attachment }), isValidation400);
		});
	}
});

describe('getUrl() validates in the same order in both runtimes', () => {
	test('an invalid expiresIn is reported before an invalid attachment', async () => {
		const options = { expiresIn: 0, attachment: 1 as unknown as string };
		const isExpiry = (err: unknown) => isValidation400(err) && /Presigned URL expiration/.test((err as Error).message);
		await assert.rejects(() => awsSigningBucket().bucket.getUrl('a', options), isExpiry);
		await assert.rejects(() => mockBucket().getUrl('a', options), isExpiry);
	});
	test('an invalid key is reported before an invalid expiresIn', async () => {
		const options = { expiresIn: 0 };
		const isKey = (err: unknown) => isValidation400(err) && /Invalid key/.test((err as Error).message);
		await assert.rejects(() => awsSigningBucket().bucket.getUrl('a/../b', options), isKey);
		await assert.rejects(() => mockBucket().getUrl('a/../b', options), isKey);
	});
});

describe('scan({ prefix }) validates the prefix identically', () => {
	const VALID = [undefined, '', 'uploads/', 'uploads/user-1/', 'reports/2024-0', 'a.b/c..d', '100%done'];
	const INVALID = ['/uploads', 'a//b', '../x', 'a/../', 'a/./', '.', '..', 'a/%2e%2e/', 'a\\b', 'a\x00', 'a\u0085', 'a\u2028', 'a\u202e'];
	for (const prefix of VALID) {
		test(`accepts ${JSON.stringify(prefix)}`, async () => {
			await collect(mockBucket().scan({ prefix }));
			const { bucket, sent } = awsSigningBucket();
			await collect(bucket.scan({ prefix }));
			assert.strictEqual(sent()[0].input.Prefix, prefix);
		});
	}
	for (const prefix of INVALID) {
		test(`rejects ${JSON.stringify(prefix)} without reaching S3`, async () => {
			await assert.rejects(() => collect(mockBucket().scan({ prefix })), isValidation400);
			const { bucket, sent } = awsSigningBucket();
			await assert.rejects(() => collect(bucket.scan({ prefix })), isValidation400);
			assert.strictEqual(sent().length, 0);
		});
	}
});

describe('ValidationFailed maps to HTTP 400 in both runtimes', () => {
	test('an invalid key is an ApiError with status 400 and a static message', async () => {
		const key = 'secret-user-42/../x';
		for (const bucket of [mockBucket(), awsSigningBucket().bucket]) {
			await assert.rejects(() => bucket.get(key), (err: unknown) =>
				isValidation400(err) && isWireSafeError(err) && !(err as Error).message.includes('secret-user-42'));
		}
	});
});
