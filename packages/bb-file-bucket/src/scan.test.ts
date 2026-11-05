// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for scan() correctness — ensures user files are never silently
 * excluded by internal sidecar/version-directory filtering.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { FileBucket } from './index.mock.js';

const scope = new Scope('scn');

beforeEach(() => {
	const dir = '.bb-data';
	try {
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('scn-')) {
					rmSync(`${dir}/${entry}`, { recursive: true, force: true });
				}
			}
		}
	} catch {}
});

// ── Filenames containing internal marker substrings ─────────────────────────

describe('scan: user files with __versions__ in name', () => {
	test('file named "my__versions__backup.txt" is listed', async () => {
		const bucket = new FileBucket(scope, 'scan-v1');
		await bucket.put('my__versions__backup.txt', 'data');
		await bucket.put('normal.txt', 'data');

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		assert.ok(
			files.includes('my__versions__backup.txt'),
			`scan() should include user file with __versions__ in name. Got: ${JSON.stringify(files)}`,
		);
	});

	test('file in directory containing __versions__ is listed', async () => {
		const bucket = new FileBucket(scope, 'scan-v2');
		await bucket.put('logs/__versions__report/data.csv', 'csv');

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		assert.ok(
			files.includes('logs/__versions__report/data.csv'),
			`scan() should include file in __versions__-named directory. Got: ${JSON.stringify(files)}`,
		);
	});

	test('internal version directories are still excluded', async () => {
		const bucket = new FileBucket(scope, 'scan-v4', { versioned: true });
		await bucket.put('doc.txt', 'v1');
		await bucket.put('doc.txt', 'v2');

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		assert.deepStrictEqual(files, ['doc.txt']);
	});
});

describe('scan: user files with .__meta__.json in name', () => {
	test('file named "data.__meta__.json" is listed', async () => {
		const bucket = new FileBucket(scope, 'scan-m1');
		await bucket.put('data.__meta__.json', '{"user": "file"}');
		await bucket.put('normal.txt', 'data');

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		assert.ok(
			files.includes('data.__meta__.json'),
			`scan() should include user file named "data.__meta__.json". Got: ${JSON.stringify(files)}`,
		);
	});

	test('actual sidecar metadata files are excluded', async () => {
		const bucket = new FileBucket(scope, 'scan-m4');
		await bucket.put('report.pdf', 'pdf', { contentType: 'application/pdf' });

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		// Only the real file, not its sidecar
		assert.deepStrictEqual(files, ['report.pdf']);
	});

	test('user file and its own sidecar coexist correctly', async () => {
		// A user file named "data.__meta__.json" is stored verbatim under the
		// content root; its metadata lives in the segregated meta root, so there
		// is no collision and scan() lists exactly the user file.
		const bucket = new FileBucket(scope, 'scan-m5');
		await bucket.put('data.__meta__.json', 'user content', { contentType: 'application/json' });

		const file = await bucket.get('data.__meta__.json');
		assert.ok(file);
		assert.strictEqual(file.body.toString(), 'user content');
		assert.strictEqual(file.contentType, 'application/json');

		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);

		assert.deepStrictEqual(files, ['data.__meta__.json']);
	});
});

describe('scan: segregated on-disk layout', () => {
	test('content, meta, and versions live under separate roots', async () => {
		const bucket = new FileBucket(scope, 'scan-layout', { versioned: true });
		await bucket.put('docs/report.pdf', 'pdf', { contentType: 'application/pdf' });

		const base = `.bb-data/scn-scan-layout`;
		// User content is byte-identical under content/
		assert.ok(existsSync(`${base}/content/docs/report.pdf`), 'content/ should hold the file body');
		// Metadata is segregated under meta/
		assert.ok(existsSync(`${base}/meta/docs/report.pdf.json`), 'meta/ should hold the sidecar');
		// Versions are segregated under versions/{key}/
		const [version] = await bucket.listVersions('docs/report.pdf');
		assert.ok(existsSync(`${base}/versions/docs/report.pdf/${version.versionId}`), 'versions/ should hold version bodies');

		// scan() only ever sees the content root — exactly one user file.
		const files: string[] = [];
		for await (const f of bucket.scan()) files.push(f.path);
		assert.deepStrictEqual(files, ['docs/report.pdf']);
	});
});


