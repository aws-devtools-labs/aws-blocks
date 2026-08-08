// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the dev file-server attachment — presigned URL serving,
 * path encoding/decoding, and versioning integration.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Scope } from '@aws-blocks/core';
import { FileBucket } from './index.mock.js';
import { attach } from './file-server.js';
import { mintFileToken, LOCAL_FILE_SECRET } from './tokens.js';

const scope = new Scope('fsrv');

let server: Server;
let port: number;

beforeEach(async () => {
	const dir = '.bb-data';
	try {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('fsrv-')) {
					rmSync(`${dir}/${entry}`, { recursive: true, force: true });
				}
			}
		}
	} catch {}
	server = createServer((_req, res) => {
		res.writeHead(404);
		res.end('not found');
	});
	attach(server);
	port = await new Promise<number>((resolve) => {
		server.listen(0, () => {
			const addr = server.address();
			resolve(typeof addr === 'object' && addr ? addr.port : 0);
		});
	});
});

afterEach(() => {
	server.close();
});

// ── Basic presigned URL round-trip ──────────────────────────────────────────

describe('file-server: basic GET/PUT', () => {
	test('PUT then GET via presigned URLs', async () => {
		const bucket = new FileBucket(scope, 'fs-basic');
		const putUrl = await bucket.putUrl('hello.txt', { contentType: 'text/plain' });
		const adjustedPut = putUrl.replace(/localhost:\d+/, `localhost:${port}`);

		const putRes = await fetch(adjustedPut, {
			method: 'PUT',
			body: 'hello world',
			headers: { 'Content-Type': 'text/plain' },
		});
		assert.strictEqual(putRes.status, 200, `PUT failed: ${putRes.status}`);

		const getUrl = await bucket.getUrl('hello.txt');
		const adjustedGet = getUrl.replace(/localhost:\d+/, `localhost:${port}`);

		const getRes = await fetch(adjustedGet);
		assert.strictEqual(getRes.status, 200, `GET failed: ${getRes.status}`);
		assert.strictEqual(await getRes.text(), 'hello world');
	});

	test('GET hardens against stored XSS: nosniff + attachment disposition', async () => {
		// A client uploads an HTML payload under a text/html content type — the
		// classic stored-XSS setup. When the dev server serves it back it must
		// never let the browser render it inline in the app's origin.
		const bucket = new FileBucket(scope, 'fs-xss');
		const putUrl = await bucket.putUrl('payload.html', { contentType: 'text/html' });
		const adjustedPut = putUrl.replace(/localhost:\d+/, `localhost:${port}`);
		const putRes = await fetch(adjustedPut, {
			method: 'PUT',
			body: '<script>alert(document.domain)</script>',
			headers: { 'Content-Type': 'text/html' },
		});
		assert.strictEqual(putRes.status, 200, `PUT failed: ${putRes.status}`);

		const getUrl = await bucket.getUrl('payload.html');
		const adjustedGet = getUrl.replace(/localhost:\d+/, `localhost:${port}`);
		const getRes = await fetch(adjustedGet);
		assert.strictEqual(getRes.status, 200, `GET failed: ${getRes.status}`);
		assert.strictEqual(
			getRes.headers.get('x-content-type-options'),
			'nosniff',
			'GET must send X-Content-Type-Options: nosniff',
		);
		assert.match(
			getRes.headers.get('content-disposition') ?? '',
			/^attachment/,
			'GET must force download via Content-Disposition: attachment',
		);
		// consume the body so the socket closes cleanly
		await getRes.arrayBuffer();
	});

	test('GET non-existent file returns 404', async () => {
		const bucket = new FileBucket(scope, 'fs-404');
		const url = await bucket.getUrl('missing.txt');
		const adjusted = url.replace(/localhost:\d+/, `localhost:${port}`);

		const res = await fetch(adjusted);
		assert.strictEqual(res.status, 404);
	});

	test('invalid token returns 403', async () => {
		const url = `http://localhost:${port}/.bb-file-bucket/root-test/file.txt?token=invalid.token`;
		const res = await fetch(url);
		assert.strictEqual(res.status, 403);
	});

	test('a token forged with the former hardcoded secret is rejected', async () => {
		// The signing secret used to be a fixed, source-visible literal, so anyone
		// could mint a valid token offline for any fullId/path without ever calling
		// getUrl()/putUrl(). It is now a per-process random secret. A token signed
		// with the old literal must no longer validate.
		const bucket = new FileBucket(scope, 'fs-forge');
		const putUrl = await bucket.putUrl('secret.txt', { contentType: 'text/plain' });
		const adjustedPut = putUrl.replace(/localhost:\d+/, `localhost:${port}`);
		await fetch(adjustedPut, { method: 'PUT', body: 'data', headers: { 'Content-Type': 'text/plain' } });

		const forged = mintFileToken('fsrv-fs-forge', 'secret.txt', 'GET', 3600, '__blocks_file_bucket_dev_secret__');
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-forge/secret.txt?token=${forged}`;
		const res = await fetch(url);
		await res.arrayBuffer();
		assert.strictEqual(res.status, 403, 'a token forged with the old hardcoded secret must be rejected');
	});

	test('PUT for an unregistered bucket fails loud (500), no silent write', async () => {
		// Mint a structurally valid token for a fullId that has no FileBucket
		// instance registered. The server must refuse rather than fall back to
		// an unversioned direct write.
		const unknownId = 'fsrv-unregistered';
		const token = mintFileToken(unknownId, 'orphan.txt', 'PUT', 3600, LOCAL_FILE_SECRET, 'text/plain');
		const url = `http://localhost:${port}/.bb-file-bucket/${unknownId}/orphan.txt?token=${token}`;

		const res = await fetch(url, {
			method: 'PUT',
			body: 'should not be written',
			headers: { 'Content-Type': 'text/plain' },
		});
		assert.strictEqual(res.status, 500, `Expected 500 for unregistered bucket, got ${res.status}`);
	});
});

// ── Content-Type parity with S3 presigned PUT ───────────────────────────────

describe('file-server: Content-Type signing parity', () => {
	test('PUT with a Content-Type that differs from the signed value returns 403', async () => {
		const bucket = new FileBucket(scope, 'fs-ct1');
		// URL is signed for image/png …
		const putUrl = await bucket.putUrl('avatar', { contentType: 'image/png' });
		const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);

		// … but the client uploads with image/jpeg. Real S3 rejects this with
		// SignatureDoesNotMatch; the mock must do the same so the failure shows
		// up locally instead of only in prod.
		const res = await fetch(adjusted, {
			method: 'PUT',
			body: 'fake png bytes',
			headers: { 'Content-Type': 'image/jpeg' },
		});
		assert.strictEqual(res.status, 403, `Expected 403 for mismatched Content-Type, got ${res.status}`);

		// And nothing was written.
		assert.strictEqual(await bucket.get('avatar'), null, 'mismatched upload must not be stored');
	});

	test('PUT omitting Content-Type when one was signed returns 403', async () => {
		const bucket = new FileBucket(scope, 'fs-ct2');
		const putUrl = await bucket.putUrl('doc.pdf', { contentType: 'application/pdf' });
		const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);

		// node-fetch/undici defaults a string body to text/plain; send an empty
		// body with no explicit Content-Type isn't reliable across runtimes, so
		// assert the realistic case: a wrong/absent signed header is rejected.
		const res = await fetch(adjusted, {
			method: 'PUT',
			body: new Blob(['data']), // Blob with no type → Content-Type omitted by undici
		});
		assert.strictEqual(res.status, 403, `Expected 403 when signed Content-Type is missing, got ${res.status}`);
	});

	test('PUT with a matching Content-Type succeeds and stores it', async () => {
		const bucket = new FileBucket(scope, 'fs-ct3');
		const putUrl = await bucket.putUrl('report.csv', { contentType: 'text/csv' });
		const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);

		const res = await fetch(adjusted, {
			method: 'PUT',
			body: 'a,b,c',
			headers: { 'Content-Type': 'text/csv' },
		});
		assert.strictEqual(res.status, 200, `Expected 200 for matching Content-Type, got ${res.status}`);

		const file = await bucket.get('report.csv');
		assert.ok(file, 'matching upload should be stored');
		assert.strictEqual(file.contentType, 'text/csv');
		assert.strictEqual(file.body.toString(), 'a,b,c');
	});

	test('createUploadHandle round-trips because it sends the signed Content-Type', async () => {
		// The typed handle path sets the request header from the same value it
		// signs, so it stays consistent across mock and prod. This pins that the
		// new enforcement does not regress the happy path.
		const bucket = new FileBucket(scope, 'fs-ct4');
		const handle = await bucket.createUploadHandle('photo.jpg', { contentType: 'image/jpeg' });
		const adjusted = handle.getUrl().replace(/localhost:\d+/, `localhost:${port}`);

		const res = await fetch(adjusted, {
			method: 'PUT',
			body: 'jpeg bytes',
			headers: { 'Content-Type': 'image/jpeg' },
		});
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);

		const file = await bucket.get('photo.jpg');
		assert.ok(file);
		assert.strictEqual(file.contentType, 'image/jpeg');
	});

	test('PUT without a signed Content-Type accepts any request header', async () => {
		// putUrl without contentType signs no content-type, mirroring an S3
		// presigned URL that did not include it — any upload header is allowed.
		const bucket = new FileBucket(scope, 'fs-ct5');
		const putUrl = await bucket.putUrl('blob.bin');
		const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);

		const res = await fetch(adjusted, {
			method: 'PUT',
			body: 'anything',
			headers: { 'Content-Type': 'application/x-custom' },
		});
		assert.strictEqual(res.status, 200, `Expected 200 when no Content-Type was signed, got ${res.status}`);

		const file = await bucket.get('blob.bin');
		assert.ok(file);
		assert.strictEqual(file.contentType, 'application/x-custom');
	});
});

// ── Path encoding/decoding ──────────────────────────────────────────────────

describe('file-server: URL-encoded paths', () => {
	test('GET with spaces in path (encoded as %20)', async () => {
		const bucket = new FileBucket(scope, 'fs-enc1');
		await bucket.put('my folder/my file.txt', 'spaced content', { contentType: 'text/plain' });

		const token = mintFileToken('fsrv-fs-enc1', 'my folder/my file.txt', 'GET', 3600, LOCAL_FILE_SECRET);
		const encodedPath = 'my%20folder/my%20file.txt';
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-enc1/${encodedPath}?token=${token}`;

		const res = await fetch(url);
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${await res.clone().text()}`);
		assert.strictEqual(await res.text(), 'spaced content');
	});

	test('GET with # in filename (encoded as %23)', async () => {
		const bucket = new FileBucket(scope, 'fs-enc2');
		await bucket.put('file#1.txt', 'hash content', { contentType: 'text/plain' });

		const token = mintFileToken('fsrv-fs-enc2', 'file#1.txt', 'GET', 3600, LOCAL_FILE_SECRET);
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-enc2/file%231.txt?token=${token}`;

		const res = await fetch(url);
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${await res.clone().text()}`);
		assert.strictEqual(await res.text(), 'hash content');
	});

	test('GET with + in filename (should not decode as space)', async () => {
		const bucket = new FileBucket(scope, 'fs-enc3');
		await bucket.put('a+b.txt', 'plus content', { contentType: 'text/plain' });

		const token = mintFileToken('fsrv-fs-enc3', 'a+b.txt', 'GET', 3600, LOCAL_FILE_SECRET);
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-enc3/a%2Bb.txt?token=${token}`;

		const res = await fetch(url);
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${await res.clone().text()}`);
		assert.strictEqual(await res.text(), 'plus content');
	});

	test('GET with unicode characters (encoded)', async () => {
		const bucket = new FileBucket(scope, 'fs-enc4');
		await bucket.put('文件/数据.txt', 'unicode content', { contentType: 'text/plain' });

		const token = mintFileToken('fsrv-fs-enc4', '文件/数据.txt', 'GET', 3600, LOCAL_FILE_SECRET);
		const encodedPath = encodeURIComponent('文件') + '/' + encodeURIComponent('数据.txt');
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-enc4/${encodedPath}?token=${token}`;

		const res = await fetch(url);
		assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${await res.clone().text()}`);
		assert.strictEqual(await res.text(), 'unicode content');
	});

	test('PUT with spaces in path (encoded)', async () => {
		const bucket = new FileBucket(scope, 'fs-enc5');
		const token = mintFileToken('fsrv-fs-enc5', 'dir name/file name.txt', 'PUT', 3600, LOCAL_FILE_SECRET, 'text/plain');
		const encodedPath = 'dir%20name/file%20name.txt';
		const url = `http://localhost:${port}/.bb-file-bucket/fsrv-fs-enc5/${encodedPath}?token=${token}`;

		const putRes = await fetch(url, {
			method: 'PUT',
			body: 'uploaded with spaces',
			headers: { 'Content-Type': 'text/plain' },
		});
		assert.strictEqual(putRes.status, 200, `PUT failed: ${putRes.status}`);

		// Verify via bucket API
		const file = await bucket.get('dir name/file name.txt');
		assert.ok(file, 'File should exist after presigned PUT');
		assert.strictEqual(file.body.toString(), 'uploaded with spaces');
	});
});

// ── Versioning integration ──────────────────────────────────────────────────

describe('file-server: versioning', () => {
	test('PUT via presigned URL creates a new version', async () => {
		const bucket = new FileBucket(scope, 'fs-ver1', { versioned: true });
		await bucket.put('doc.txt', 'v1-api', { contentType: 'text/plain' });

		const vBefore = await bucket.listVersions('doc.txt');
		assert.strictEqual(vBefore.length, 1);

		// Upload v2 via presigned URL
		const putUrl = await bucket.putUrl('doc.txt', { contentType: 'text/plain' });
		const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);
		const res = await fetch(adjusted, {
			method: 'PUT',
			body: 'v2-presigned',
			headers: { 'Content-Type': 'text/plain' },
		});
		assert.strictEqual(res.status, 200);

		const vAfter = await bucket.listVersions('doc.txt');
		assert.strictEqual(
			vAfter.length, 2,
			`Expected 2 versions after presigned PUT, got ${vAfter.length}`,
		);

		const current = await bucket.get('doc.txt');
		assert.ok(current);
		assert.strictEqual(current.body.toString(), 'v2-presigned');
	});

	test('GET with versionId via presigned URL returns specific version', async () => {
		const bucket = new FileBucket(scope, 'fs-ver2', { versioned: true });
		await bucket.put('doc.txt', 'v1', { contentType: 'text/plain' });
		await bucket.put('doc.txt', 'v2', { contentType: 'text/plain' });

		const versions = await bucket.listVersions('doc.txt');
		const oldVersion = versions[versions.length - 1];

		const url = await bucket.getUrl('doc.txt', { versionId: oldVersion.versionId });
		const adjusted = url.replace(/localhost:\d+/, `localhost:${port}`);

		const res = await fetch(adjusted);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(await res.text(), 'v1');
	});

	test('rejects a traversal versionId (path-traversal guard)', async () => {
		const bucket = new FileBucket(scope, 'fs-ver-traversal', { versioned: true });
		await bucket.put('doc.txt', 'secret-contents', { contentType: 'text/plain' });

		// Start from a legitimate presigned GET URL, then tamper with versionId.
		const url = await bucket.getUrl('doc.txt');
		const adjusted = url.replace(/localhost:\d+/, `localhost:${port}`);
		const malicious = `${adjusted}${adjusted.includes('?') ? '&' : '?'}versionId=${encodeURIComponent('../../../../../../etc/passwd')}`;

		const res = await fetch(malicious);
		assert.strictEqual(res.status, 400, 'traversal versionId must be rejected with 400');
		const body = await res.text();
		assert.ok(!body.includes('root:'), 'must not leak /etc/passwd contents');
	});

	test('rejects a prefix-bypass versionId (anchored regex guard)', async () => {
		const bucket = new FileBucket(scope, 'fs-ver-prefix-bypass', { versioned: true });
		await bucket.put('doc.txt', 'secret-contents', { contentType: 'text/plain' });

		// Attempt to bypass with a versionId that starts valid but appends traversal.
		const url = await bucket.getUrl('doc.txt');
		const adjusted = url.replace(/localhost:\d+/, `localhost:${port}`);
		const malicious = `${adjusted}${adjusted.includes('?') ? '&' : '?'}versionId=${encodeURIComponent('v1/../../../etc/passwd')}`;

		const res = await fetch(malicious);
		assert.strictEqual(res.status, 400, 'prefix-bypass versionId must be rejected with 400');
	});

	test('multiple presigned PUTs each create a version', async () => {
		const bucket = new FileBucket(scope, 'fs-ver3', { versioned: true });

		for (let i = 1; i <= 3; i++) {
			const putUrl = await bucket.putUrl('counter.txt', { contentType: 'text/plain' });
			const adjusted = putUrl.replace(/localhost:\d+/, `localhost:${port}`);
			await fetch(adjusted, {
				method: 'PUT',
				body: `version-${i}`,
				headers: { 'Content-Type': 'text/plain' },
			});
		}

		const versions = await bucket.listVersions('counter.txt');
		assert.strictEqual(
			versions.length, 3,
			`Expected 3 versions, got ${versions.length}`,
		);
	});
});

// ── CORS headers ────────────────────────────────────────────────────────────

describe('file-server: CORS', () => {
	test('OPTIONS request returns CORS headers', async () => {
		const url = `http://localhost:${port}/.bb-file-bucket/any/path?token=x`;
		const res = await fetch(url, { method: 'OPTIONS' });
		assert.strictEqual(res.status, 200);
		assert.ok(res.headers.get('access-control-allow-methods')?.includes('PUT'));
	});

	test('CORS response does not credential a reflected/wildcard origin', async () => {
		// The dev file-server reflects the request Origin (falling back to `*`).
		// Pairing that with `Access-Control-Allow-Credentials: true` is the
		// permissive-CORS pattern a security scanner flags. Presigned-token auth
		// is a query param, not a cookie, so credentials are never needed.
		const url = `http://localhost:${port}/.bb-file-bucket/any/path?token=x`;
		const res = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
		assert.strictEqual(res.headers.get('access-control-allow-credentials'), null);
	});
});
