// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for path-traversal containment — the mock and dev file-server must
 * reject keys that would escape the bucket's content root. This guard is
 * mock-only (S3 itself accepts `..` in keys), so it is unit-tested here rather
 * than in the cross-environment e2e suite.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Scope, isBlocksError } from '@aws-cdk-blocks/core';
import { FileBucket } from './index.mock.js';
import { attach } from './file-server.js';
import { mintFileToken, LOCAL_FILE_SECRET } from './tokens.js';

const scope = new Scope('pc');

function cleanScopeData() {
	const dir = '.cdk-blocks/local/data';
	try {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('pc-')) {
					rmSync(`${dir}/${entry}`, { recursive: true, force: true });
				}
			}
		}
	} catch {}
}

// ── Bucket-level guard (validateKey → assertContainedPath(contentRoot)) ──────

describe('path containment: bucket API', () => {
	beforeEach(cleanScopeData);

	test('put rejects a parent-traversal key', async () => {
		const bucket = new FileBucket(scope, 'pc-put');
		await assert.rejects(
			() => bucket.put('../escape.txt', 'pwned'),
			(err: unknown) => isBlocksError(err, 'ValidationFailed'),
			'put("../escape.txt") should throw ValidationFailed',
		);
	});

	test('get rejects a parent-traversal key', async () => {
		const bucket = new FileBucket(scope, 'pc-get');
		await assert.rejects(
			() => bucket.get('../../secret.txt'),
			(err: unknown) => isBlocksError(err, 'ValidationFailed'),
		);
	});

	test('delete rejects a parent-traversal key', async () => {
		const bucket = new FileBucket(scope, 'pc-del');
		await assert.rejects(
			() => bucket.delete('a/../../escape.txt'),
			(err: unknown) => isBlocksError(err, 'ValidationFailed'),
		);
	});

	test('a key that escapes only after the content root is rejected', async () => {
		// Naively joining onto dataDir (not contentRoot) would let a single `..`
		// land inside dataDir/ (e.g. the meta/ or versions/ sibling). Validating
		// against the content root rejects it.
		const bucket = new FileBucket(scope, 'pc-sibling');
		await assert.rejects(
			() => bucket.put('../meta/forged.json', 'x'),
			(err: unknown) => isBlocksError(err, 'ValidationFailed'),
			'a key climbing into a sibling internal root must be rejected',
		);
	});

	test('legitimate nested keys are NOT false-positives', async () => {
		const bucket = new FileBucket(scope, 'pc-ok');
		await bucket.put('a/b/c/deep.txt', 'fine');
		const file = await bucket.get('a/b/c/deep.txt');
		assert.ok(file);
		assert.strictEqual(file.body.toString(), 'fine');
	});
});

// ── File-server guard (decoded path → assertContainedPath(contentRoot)) ──────

describe('path containment: dev file-server', () => {
	let server: Server;
	let port: number;

	beforeEach(async () => {
		cleanScopeData();
		server = createServer((_req, res) => { res.writeHead(404); res.end(); });
		attach(server);
		port = await new Promise<number>((resolve) => {
			server.listen(0, () => {
				const addr = server.address();
				resolve(typeof addr === 'object' && addr ? addr.port : 0);
			});
		});
	});

	afterEach(() => server.close());

	test('GET with an encoded ../ traversal returns 400', async () => {
		// Token is minted for the raw (decoded) path; the server decodes the URL
		// before validating containment, so the traversal is caught at the guard.
		const token = mintFileToken('pc-fsrv', '../escape.txt', 'GET', 3600, LOCAL_FILE_SECRET);
		const url = `http://localhost:${port}/.bb-file-bucket/pc-fsrv/..%2Fescape.txt?token=${token}`;
		const res = await fetch(url);
		assert.strictEqual(res.status, 400, `Expected 400 for traversal, got ${res.status}`);
	});

	test('PUT with an encoded ../ traversal returns 400', async () => {
		const token = mintFileToken('pc-fsrv', '../escape.txt', 'PUT', 3600, LOCAL_FILE_SECRET, 'text/plain');
		const url = `http://localhost:${port}/.bb-file-bucket/pc-fsrv/..%2Fescape.txt?token=${token}`;
		const res = await fetch(url, { method: 'PUT', body: 'pwned', headers: { 'Content-Type': 'text/plain' } });
		assert.strictEqual(res.status, 400, `Expected 400 for traversal, got ${res.status}`);
	});
});
