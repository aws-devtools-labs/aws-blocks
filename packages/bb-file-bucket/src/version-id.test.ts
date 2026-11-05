// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scope } from '@aws-blocks/core';
import { FileBucket, FileBucketErrors } from './index.mock.js';
import { versionContentPath, versionMetaPath, versionsDirFor } from './paths.js';

const scope = new Scope('version-identity');
const bucketId = 'files';
const dataDir = join(process.cwd(), '.bb-data', `${scope.fullId}-${bucketId}`);
const key = 'reports/document.txt';

beforeEach(() => rmSync(dataDir, { recursive: true, force: true }));
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

function seedLegacyVersion(versionId: string, body: string) {
	mkdirSync(versionsDirFor(dataDir, key), { recursive: true });
	writeFileSync(versionContentPath(dataDir, key, versionId), body);
	writeFileSync(versionMetaPath(dataDir, key, versionId), JSON.stringify({
		contentType: 'text/plain', metadata: { revision: versionId },
	}));
}

for (const keepOlder of [false, true]) {
	test(`a deleted version stays absent after upload (older version remains: ${keepOlder})`, async () => {
		const bucket = new FileBucket(scope, bucketId);
		if (keepOlder) await bucket.put(key, 'older');
		await bucket.put(key, 'deleted');
		const [saved] = await bucket.listVersions(key);
		await bucket.delete(key, { versionId: saved.versionId });
		assert.equal(await bucket.get(key, { versionId: saved.versionId }), null);
		await bucket.put(key, 'replacement');
		assert.equal(await bucket.get(key, { versionId: saved.versionId }), null);
		await assert.rejects(bucket.restoreVersion(key, saved.versionId), { name: FileBucketErrors.VersionNotFound });
		await bucket.delete(key, { versionId: saved.versionId });
		assert.equal((await bucket.get(key))?.body.toString(), 'replacement');
		assert.equal((await bucket.listVersions(key)).length, keepOlder ? 2 : 1);
	});
}

test('deleted references stay absent across separate Node processes', () => {
	const imports = `
		import { Scope } from ${JSON.stringify(import.meta.resolve('@aws-blocks/core'))};
		import { FileBucket } from ${JSON.stringify(new URL('./index.mock.js', import.meta.url).href)};
		const bucket = new FileBucket(new Scope('version-identity'), 'files');
		const key = ${JSON.stringify(key)};
	`;
	const run = (source: string) => execFileSync(process.execPath, ['--input-type=module', '-e', imports + source], {
		encoding: 'utf8',
	});
	const savedId = run(`
		await bucket.put(key, 'deleted');
		const [version] = await bucket.listVersions(key);
		await bucket.delete(key, { versionId: version.versionId });
		process.stdout.write(version.versionId);
	`);
	run(`await bucket.put(key, 'replacement');`);
	assert.equal(run(`
		const versionId = ${JSON.stringify(savedId)};
		if (await bucket.get(key, { versionId }) !== null) throw new Error('Deleted reference was reused');
		await bucket.delete(key, { versionId });
		process.stdout.write((await bucket.get(key))?.body.toString() ?? 'missing');
	`), 'replacement');
});

test('future uploads cannot recreate legacy IDs deleted before the upgrade', async () => {
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'new data');
	const [version] = await bucket.listVersions(key);
	assert.doesNotMatch(version.versionId, /^v\d+$/);
	for (const versionId of ['v1', 'v2', 'v999']) {
		assert.equal(await bucket.get(key, { versionId }), null);
		await bucket.delete(key, { versionId });
	}
	assert.equal((await bucket.get(key))?.body.toString(), 'new data');
});

test('legacy references remain readable, restorable, and deletable with new versions', async () => {
	seedLegacyVersion('v1', 'first');
	seedLegacyVersion('v10', 'tenth');
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'new');
	assert.equal((await bucket.get(key, { versionId: 'v1' }))?.body.toString(), 'first');
	assert.deepEqual((await bucket.get(key, { versionId: 'v10' }))?.metadata, { revision: 'v10' });
	await bucket.restoreVersion(key, 'v1');
	const [restored] = await bucket.listVersions(key);
	assert.doesNotMatch(restored.versionId, /^v\d+$/);
	assert.equal((await bucket.get(key))?.body.toString(), 'first');
	assert.deepEqual((await bucket.get(key))?.metadata, { revision: 'v1' });
	await bucket.delete(key, { versionId: 'v1' });
	await bucket.delete(key, { versionId: 'v10' });
	assert.equal((await bucket.get(key))?.body.toString(), 'first');
	assert.equal((await bucket.listVersions(key)).length, 2);
});

test('mixed legacy and new versions preserve numeric order when timestamps tie', async () => {
	seedLegacyVersion('v2', 'second');
	seedLegacyVersion('v10', 'tenth');
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'eleventh');
	await bucket.put(key, 'twelfth');
	const timestamp = new Date('2020-01-01T00:00:00.000Z');
	for (const version of await bucket.listVersions(key)) {
		utimesSync(versionContentPath(dataDir, key, version.versionId), timestamp, timestamp);
	}
	const bodies = [];
	for (const version of await bucket.listVersions(key)) {
		bodies.push((await bucket.get(key, { versionId: version.versionId }))?.body.toString());
	}
	assert.deepEqual(bodies, ['twelfth', 'eleventh', 'tenth', 'second']);
	for (const expected of ['eleventh', 'tenth', 'second', undefined]) {
		const [current] = await bucket.listVersions(key);
		assert.equal(current.isCurrent, true);
		await bucket.delete(key, { versionId: current.versionId });
		assert.equal((await bucket.get(key))?.body.toString(), expected);
	}
});

test('restoring after deletion creates a new identity instead of reviving the deleted ID', async () => {
	const bucket = new FileBucket(scope, bucketId);
	await bucket.put(key, 'original');
	const [original] = await bucket.listVersions(key);
	await bucket.put(key, 'deleted');
	const [deleted] = await bucket.listVersions(key);
	await bucket.delete(key, { versionId: deleted.versionId });
	await bucket.restoreVersion(key, original.versionId);
	assert.equal(await bucket.get(key, { versionId: deleted.versionId }), null);
	await bucket.delete(key, { versionId: deleted.versionId });
	assert.equal((await bucket.get(key))?.body.toString(), 'original');
	assert.equal((await bucket.listVersions(key)).length, 2);
});
