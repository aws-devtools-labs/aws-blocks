// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Scope } from '@aws-blocks/core';
import { FileBucket } from './index.mock.js';
import { contentPath, metaPath, deleteMarkerPath, versionContentPath } from './paths.js';

const scope = new Scope('version-delete');
const bucketId = 'files';
const dataDir = join(process.cwd(), '.bb-data', `${scope.fullId}-${bucketId}`);
const key = 'reports/document.txt';

beforeEach(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

async function scanFiles(bucket: FileBucket) {
	const files = [];
	for await (const file of bucket.scan()) files.push(file);
	return files;
}

async function putVersions(bucket: FileBucket) {
	await bucket.put(key, 'old', {
		contentType: 'text/plain',
		metadata: { revision: 'old' },
		cacheControl: 'max-age=60',
	});
	await bucket.put(key, 'new content', {
		contentType: 'text/csv',
		metadata: { revision: 'new' },
		cacheControl: 'no-cache',
	});
	return bucket.listVersions(key);
}

test('deleting the current version promotes the previous body and metadata without a new version', async () => {
	const bucket = new FileBucket(scope, bucketId);
	const [latest, previous] = await putVersions(bucket);
	const timestamp = new Date('2020-01-01T00:00:00.000Z');
	utimesSync(versionContentPath(dataDir, key, previous.versionId), timestamp, timestamp);
	await bucket.delete(key, { versionId: latest.versionId });
	const file = await bucket.get(key);
	assert.ok(file);
	assert.equal(file.body.toString(), 'old');
	assert.equal(file.contentType, 'text/plain');
	assert.deepEqual(file.metadata, { revision: 'old' });
	assert.equal(file.size, 3);
	assert.equal(JSON.parse(readFileSync(metaPath(dataDir, key), 'utf8')).cacheControl, 'max-age=60');
	assert.equal(await bucket.get(key, { versionId: latest.versionId }), null);
	const versions = await bucket.listVersions(key);
	assert.equal(versions.length, 1);
	assert.equal(versions[0].versionId, previous.versionId);
	assert.equal(versions[0].isCurrent, true);
	const files = await scanFiles(bucket);
	assert.equal(files.length, 1);
	assert.equal(files[0].size, 3);
	assert.equal(files[0].lastModified.getTime(), timestamp.getTime());
	const reopened = new FileBucket(scope, bucketId);
	assert.equal((await reopened.get(key))?.body.toString(), 'old');
	assert.deepEqual((await reopened.get(key))?.metadata, { revision: 'old' });
});

test('equal version timestamps use the same numeric ordering as listVersions', async () => {
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'first');
	await bucket.put(key, 'second');
	await bucket.put(key, 'third');
	const timestamp = new Date('2020-01-01T00:00:00.000Z');
	for (const version of await bucket.listVersions(key)) {
		utimesSync(versionContentPath(dataDir, key, version.versionId), timestamp, timestamp);
	}
	const [latest, previous] = await bucket.listVersions(key);
	await bucket.delete(key, { versionId: latest.versionId });
	assert.equal((await bucket.get(key))?.body.toString(), 'second');
	assert.equal((await bucket.listVersions(key))[0].versionId, previous.versionId);
});

test('deleting the only version removes the current body and sidecar', async () => {
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'only');
	const [version] = await bucket.listVersions(key);
	await bucket.delete(key, { versionId: version.versionId });
	assert.equal(await bucket.get(key), null);
	assert.deepEqual(await scanFiles(bucket), []);
	assert.deepEqual(await bucket.listVersions(key), []);
	assert.equal(existsSync(contentPath(dataDir, key)), false);
	assert.equal(existsSync(metaPath(dataDir, key)), false);
});

test('repeated newest-first deletion promotes each remaining version and then removes the file', async () => {
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'first');
	await bucket.put(key, 'second');
	await bucket.put(key, 'third');
	for (const expected of ['second', 'first', null]) {
		const [current] = await bucket.listVersions(key);
		await bucket.delete(key, { versionId: current.versionId });
		assert.equal((await bucket.get(key))?.body.toString() ?? null, expected);
	}
	assert.deepEqual(await scanFiles(bucket), []);
});

test('deleting an older version leaves current content, metadata, and modification time unchanged', async () => {
	const bucket = new FileBucket(scope, bucketId);
	const [latest, previous] = await putVersions(bucket);
	const before = statSync(contentPath(dataDir, key)).mtimeMs;
	await bucket.delete(key, { versionId: previous.versionId });
	assert.equal((await bucket.get(key))?.body.toString(), 'new content');
	assert.deepEqual((await bucket.get(key))?.metadata, { revision: 'new' });
	assert.equal(statSync(contentPath(dataDir, key)).mtimeMs, before);
	assert.equal((await bucket.listVersions(key))[0].versionId, latest.versionId);
});

test('deleting an unknown version is a no-op for existing and missing objects', async () => {
	const bucket = new FileBucket(scope, bucketId);
	const versions = await putVersions(bucket);
	const before = statSync(contentPath(dataDir, key)).mtimeMs;
	await bucket.delete(key, { versionId: 'v999' });
	await bucket.delete('missing.txt', { versionId: 'v999' });
	assert.equal((await bucket.get(key))?.body.toString(), 'new content');
	assert.equal(statSync(contentPath(dataDir, key)).mtimeMs, before);
	assert.deepEqual(await bucket.listVersions(key), versions);
	assert.equal(await bucket.get('missing.txt'), null);
});

test('deleting versions does not remove an existing delete marker or resurrect the object', async () => {
	const bucket = new FileBucket(scope, bucketId);
	const versions = await putVersions(bucket);
	await bucket.delete(key);
	for (const version of versions) {
		await bucket.delete(key, { versionId: version.versionId });
		assert.equal(await bucket.get(key), null);
		assert.deepEqual(await scanFiles(bucket), []);
		assert.equal(existsSync(deleteMarkerPath(dataDir, key)), true);
		assert.ok((await bucket.listVersions(key)).every((remaining) => !remaining.isCurrent));
	}
	assert.equal(existsSync(contentPath(dataDir, key)), false);
	await bucket.put(key, 'uploaded again');
	assert.equal((await bucket.get(key))?.body.toString(), 'uploaded again');
});

test('concurrent version deletions do not retain a stale current copy', async () => {
	const bucket = new FileBucket(scope, bucketId);
	const versions = await putVersions(bucket);
	await Promise.all(versions.map((version) => bucket.delete(key, { versionId: version.versionId })));
	assert.equal(await bucket.get(key), null);
	assert.deepEqual(await bucket.listVersions(key), []);
	assert.deepEqual(await scanFiles(bucket), []);
});

test('non-versioned deletion still removes the object', async () => {
	const bucket = new FileBucket(scope, bucketId, { versioned: false });
	await bucket.put(key, 'data');
	await bucket.delete(key);
	assert.equal(await bucket.get(key), null);
	assert.deepEqual(await scanFiles(bucket), []);
});
