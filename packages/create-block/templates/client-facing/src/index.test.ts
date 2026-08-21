// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { __BB_CLASS__, __BB_CLASS__Errors } from './index.mock.js';

// Clean mock data between tests to avoid cross-contamination.
beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

test('put then get returns the stored value', async () => {
	const store = new __BB_CLASS__({ id: 'root' } as any, 'test');
	await store.put('k', 'v');
	assert.strictEqual(await store.get('k'), 'v');
});

test('get returns null for a missing key', async () => {
	const store = new __BB_CLASS__({ id: 'root' } as any, 'test');
	assert.strictEqual(await store.get('missing'), null);
});

test('delete removes the value', async () => {
	const store = new __BB_CLASS__({ id: 'root' } as any, 'test');
	await store.put('k', 'v');
	await store.delete('k');
	assert.strictEqual(await store.get('k'), null);
});

test('values persist across instances at the same scope path (disk)', async () => {
	const a = new __BB_CLASS__({ id: 'root' } as any, 'shared');
	await a.put('k', 'v');
	const b = new __BB_CLASS__({ id: 'root' } as any, 'shared');
	assert.strictEqual(await b.get('k'), 'v');
});

test('fromExisting returns a branded reference', () => {
	const ref = __BB_CLASS__.fromExisting('legacy-table');
	assert.strictEqual(ref.tableName, 'legacy-table');
	assert.strictEqual(ref.__brand, 'ExternalTableRef');
});

test('error constants are defined', () => {
	assert.ok(__BB_CLASS__Errors.ConditionalCheckFailed);
});
