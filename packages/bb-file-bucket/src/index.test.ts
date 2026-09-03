// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { FileBucket, FileBucketErrors } from './index.mock.js';

const scope = new Scope('idx');

// Clean only our scope's mock data between tests
beforeEach(() => {
	const dir = '.bb-data';
	try {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('idx-')) {
					rmSync(`${dir}/${entry}`, { recursive: true, force: true });
				}
			}
		}
	} catch {}
});

// ── Basic CRUD ──────────────────────────────────────────────────────────────

test('put and get', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('hello.txt', 'hello world', { contentType: 'text/plain' });
	const file = await bucket.get('hello.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'hello world');
	assert.strictEqual(file.contentType, 'text/plain');
	assert.strictEqual(file.size, 11);
});

test('put with Buffer body', async () => {
	const bucket = new FileBucket(scope, 'test');
	const buf = Buffer.from([0x00, 0x01, 0x02]);
	await bucket.put('binary.bin', buf);
	const file = await bucket.get('binary.bin');
	assert.ok(file);
	assert.deepStrictEqual(file.body, buf);
});

test('get non-existent file returns null', async () => {
	const bucket = new FileBucket(scope, 'test');
	assert.strictEqual(await bucket.get('nonexistent.txt'), null);
});

test('put overwrites existing file', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v2');
});

// ── Delete ──────────────────────────────────────────────────────────────────

test('delete removes file', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('file.txt', 'data');
	await bucket.delete('file.txt');
	assert.strictEqual(await bucket.get('file.txt'), null);
});

test('delete non-existent file is no-op', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.delete('nonexistent.txt'); // should not throw
});

// ── deleteBatch ─────────────────────────────────────────────────────────────

test('deleteBatch removes multiple files', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('a.txt', 'a');
	await bucket.put('b.txt', 'b');
	await bucket.put('c.txt', 'c');
	await bucket.deleteBatch(['a.txt', 'b.txt']);
	assert.strictEqual(await bucket.get('a.txt'), null);
	assert.strictEqual(await bucket.get('b.txt'), null);
	assert.ok(await bucket.get('c.txt'));
});

// ── Metadata ────────────────────────────────────────────────────────────────

test('metadata is preserved', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('file.txt', 'data', {
		contentType: 'text/csv',
		metadata: { author: 'test' },
	});
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.contentType, 'text/csv');
	assert.strictEqual(file.metadata.author, 'test');
});

test('default contentType is application/octet-stream', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('file.bin', Buffer.from([1]));
	const file = await bucket.get('file.bin');
	assert.ok(file);
	assert.strictEqual(file.contentType, 'application/octet-stream');
});

// ── Nested paths ────────────────────────────────────────────────────────────

test('nested paths work', async () => {
	const bucket = new FileBucket(scope, 'test');
	await bucket.put('a/b/c/file.txt', 'nested');
	const file = await bucket.get('a/b/c/file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'nested');
});

// ── scan() ──────────────────────────────────────────────────────────────────

test('scan yields all files', async () => {
	const bucket = new FileBucket(scope, 'scantest');
	await bucket.put('a.txt', 'a');
	await bucket.put('b.txt', 'b');
	const files: { path: string }[] = [];
	for await (const file of bucket.scan()) files.push(file);
	assert.strictEqual(files.length, 2);
	const paths = files.map(f => f.path).sort();
	assert.deepStrictEqual(paths, ['a.txt', 'b.txt']);
});

test('scan with prefix filters results', async () => {
	const bucket = new FileBucket(scope, 'scantest');
	await bucket.put('uploads/a.txt', 'a');
	await bucket.put('uploads/b.txt', 'b');
	await bucket.put('reports/c.txt', 'c');
	const files: { path: string }[] = [];
	for await (const file of bucket.scan({ prefix: 'uploads/' })) files.push(file);
	assert.strictEqual(files.length, 2);
});

test('scan on empty bucket yields nothing', async () => {
	const bucket = new FileBucket(scope, 'empty');
	const files: unknown[] = [];
	for await (const file of bucket.scan()) files.push(file);
	assert.strictEqual(files.length, 0);
});

test('scan returns size and lastModified', async () => {
	const bucket = new FileBucket(scope, 'scanmeta');
	await bucket.put('file.txt', 'hello');
	for await (const file of bucket.scan()) {
		assert.strictEqual(file.size, 5);
		assert.ok(file.lastModified instanceof Date);
	}
});

// ── Presigned URLs ──────────────────────────────────────────────────────────

test('getUrl returns a token-bearing URL', async () => {
	const bucket = new FileBucket(scope, 'urls');
	const url = await bucket.getUrl('file.txt');
	assert.ok(url.includes('localhost'));
	assert.ok(url.includes('file.txt'));
	assert.ok(url.includes('token='));
});

test('putUrl returns a token-bearing URL', async () => {
	const bucket = new FileBucket(scope, 'urls');
	const url = await bucket.putUrl('file.txt');
	assert.ok(url.includes('localhost'));
	assert.ok(url.includes('file.txt'));
	assert.ok(url.includes('token='));
});

// ── Transferable handles ────────────────────────────────────────────────────

test('getFileHandle returns a download handle with toJSON', async () => {
	const bucket = new FileBucket(scope, 'handles');
	const handle = await bucket.getFileHandle('file.txt');
	assert.strictEqual(typeof handle.download, 'function');
	assert.strictEqual(typeof handle.getUrl, 'function');
	assert.ok(handle.getUrl().includes('file.txt'));
	const json = handle.toJSON();
	assert.strictEqual(json.__blocks, 'file-bucket/download');
	assert.ok(json.url.includes('file.txt'));
});

test('createUploadHandle returns an upload handle with toJSON', async () => {
	const bucket = new FileBucket(scope, 'handles');
	const handle = await bucket.createUploadHandle('file.txt', { contentType: 'text/plain' });
	assert.strictEqual(typeof handle.upload, 'function');
	assert.strictEqual(typeof handle.getUrl, 'function');
	assert.ok(handle.getUrl().includes('file.txt'));
	const json = handle.toJSON();
	assert.strictEqual(json.__blocks, 'file-bucket/upload');
	assert.ok(json.url.includes('file.txt'));
	assert.strictEqual(json.contentType, 'text/plain');
});

// ── fromExisting ────────────────────────────────────────────────────────────

test('fromExisting returns ExternalBucketRef', () => {
	const ref = FileBucket.fromExisting('my-bucket');
	assert.strictEqual(ref.bucketName, 'my-bucket');
});

// ── Error constants ─────────────────────────────────────────────────────────

test('FileBucketErrors has expected values', () => {
	assert.strictEqual(FileBucketErrors.FileNotFound, 'NoSuchKey');
});

// ── fullId ──────────────────────────────────────────────────────────────────

test('fullId generation with parent', () => {
	const bucket = new FileBucket(scope, 'child');
	assert.ok(bucket.fullId.endsWith('idx-child'));
});

// ── Disk persistence ────────────────────────────────────────────────────────

test('data persists across instances', async () => {
	const bucket1 = new FileBucket(scope, 'persist');
	await bucket1.put('file.txt', 'saved');

	const bucket2 = new FileBucket(scope, 'persist');
	const file = await bucket2.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'saved');
});

// ── Versioned bucket ────────────────────────────────────────────────────────

test('versioned: put creates versions', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	await bucket.put('file.txt', 'v3');
	const versions = await bucket.listVersions('file.txt');
	assert.strictEqual(versions.length, 3);
	assert.strictEqual(versions[0].isCurrent, true);
	assert.strictEqual(versions[1].isCurrent, false);
});

test('versioned: get returns latest by default', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v2');
});

test('versioned: get with versionId returns specific version', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const versions = await bucket.listVersions('file.txt');
	const oldest = versions[versions.length - 1];
	const file = await bucket.get('file.txt', { versionId: oldest.versionId });
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v1');
});

test('versioned: delete without versionId places delete marker', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'data');
	await bucket.delete('file.txt');
	// Current version appears deleted
	assert.strictEqual(await bucket.get('file.txt'), null);
	// But versions still exist
	const versions = await bucket.listVersions('file.txt');
	assert.strictEqual(versions.length, 1);
	assert.strictEqual(versions[0].isCurrent, false); // delete marker means none is current
});

test('versioned: delete with versionId permanently removes that version', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const versions = await bucket.listVersions('file.txt');
	await bucket.delete('file.txt', { versionId: versions[1].versionId });
	const remaining = await bucket.listVersions('file.txt');
	assert.strictEqual(remaining.length, 1);
});

test('versioned: scan skips deleted files', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('a.txt', 'a');
	await bucket.put('b.txt', 'b');
	await bucket.delete('a.txt');
	const files: { path: string }[] = [];
	for await (const f of bucket.scan()) files.push(f);
	assert.strictEqual(files.length, 1);
	assert.strictEqual(files[0].path, 'b.txt');
});

test('versioned: restoreVersion makes old version current', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const versions = await bucket.listVersions('file.txt');
	const oldest = versions[versions.length - 1];
	await bucket.restoreVersion('file.txt', oldest.versionId);
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v1');
	// Should now have 3 versions (v1, v2, restored copy)
	const after = await bucket.listVersions('file.txt');
	assert.strictEqual(after.length, 3);
});

test('versioned: restoreVersion after delete removes delete marker', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.delete('file.txt');
	assert.strictEqual(await bucket.get('file.txt'), null);
	const versions = await bucket.listVersions('file.txt');
	await bucket.restoreVersion('file.txt', versions[0].versionId);
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v1');
});

test('versioned: listVersions on non-existent file returns empty', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	const versions = await bucket.listVersions('nonexistent.txt');
	assert.deepStrictEqual(versions, []);
});

test('versioned: listVersions returns newest first', async () => {
	const bucket = new FileBucket(scope, 'versioned', { versioned: true });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	await bucket.put('file.txt', 'v3');
	const versions = await bucket.listVersions('file.txt');
	assert.strictEqual(versions[0].versionId, 'v3');
	assert.strictEqual(versions[1].versionId, 'v2');
	assert.strictEqual(versions[2].versionId, 'v1');
});

// ── Static type checks: conditional version types ───────────────────────────

function _conditionalVersionTypeChecks() {
	// Explicit opt-out selects the non-versioned option types.
	const plain = new FileBucket(scope, 'plain', { versioned: false });
	const versioned = new FileBucket(scope, 'versioned', { versioned: true });
	// No options now defaults to versioned-aware typings (Default: true).
	const dflt = new FileBucket(scope, 'dflt');

	// Non-versioned: get/delete accept no options
	plain.get('file.txt');
	plain.delete('file.txt');
	// @ts-expect-error — versionId not allowed on non-versioned bucket
	plain.get('file.txt', { versionId: 'v1' });
	// @ts-expect-error — versionId not allowed on non-versioned bucket
	plain.delete('file.txt', { versionId: 'v1' });
	// @ts-expect-error — versionId not allowed on non-versioned getUrl
	plain.getUrl('file.txt', { versionId: 'v1' });

	// Versioned: get/delete accept optional versionId
	versioned.get('file.txt');
	versioned.get('file.txt', { versionId: 'v1' });
	versioned.delete('file.txt');
	versioned.delete('file.txt', { versionId: 'v1' });
	versioned.getUrl('file.txt', { versionId: 'v1', expiresIn: 600 });

	// Default (no options) is versioned-aware: versionId is accepted.
	dflt.get('file.txt');
	dflt.get('file.txt', { versionId: 'v1' });
	dflt.delete('file.txt', { versionId: 'v1' });
	dflt.getUrl('file.txt', { versionId: 'v1', expiresIn: 600 });
}

// ── Versioning on by default (new secure default) ───────────────────────────

test('default (no options) bucket is versioned: put creates versions', async () => {
	const bucket = new FileBucket(scope, 'default-versioned');
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const versions = await bucket.listVersions('file.txt');
	assert.strictEqual(versions.length, 2);
	assert.strictEqual(versions[0].isCurrent, true);
});

test('versioned:false opt-out disables versioning at runtime', async () => {
	const bucket = new FileBucket(scope, 'optout-versioned', { versioned: false });
	await bucket.put('file.txt', 'v1');
	await bucket.put('file.txt', 'v2');
	const versions = await bucket.listVersions('file.txt');
	assert.strictEqual(versions.length, 0);
	const file = await bucket.get('file.txt');
	assert.ok(file);
	assert.strictEqual(file.body.toString(), 'v2');
});
