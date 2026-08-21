// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { __BB_CLASS__ } from './index.js';

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

test('set then read returns the value (via the composed KVStore)', async () => {
	const bb = new __BB_CLASS__({ id: 'root' } as any, 'test');
	await bb.set('k', 'v');
	assert.strictEqual(await bb.read('k'), 'v');
});

test('read returns null for a missing key', async () => {
	const bb = new __BB_CLASS__({ id: 'root' } as any, 'test');
	assert.strictEqual(await bb.read('missing'), null);
});
