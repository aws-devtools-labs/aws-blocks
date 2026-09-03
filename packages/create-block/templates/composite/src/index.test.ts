// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { __BB_CLASS__ } from './index.js';

// A real, typed parent Scope — no casts (this test represents customer usage).
const parent = new Scope('test-app');
let n = 0;
const make = () => new __BB_CLASS__(parent, `thing-${n++}`);

beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

test('set then read returns the value (via the composed KVStore)', async () => {
	const bb = make();
	await bb.set('k', 'v');
	assert.strictEqual(await bb.read('k'), 'v');
});

test('read returns null for a missing key', async () => {
	const bb = make();
	assert.strictEqual(await bb.read('missing'), null);
});
