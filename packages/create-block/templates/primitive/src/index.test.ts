// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { __BB_CLASS__, __BB_CLASS__Errors } from './index.mock.js';

// A real, typed parent Scope — no casts (this test represents customer usage).
const parent = new Scope('test-app');
let n = 0;
const make = () => new __BB_CLASS__(parent, `thing-${n++}`);

// Reset mock data between tests (blocks that persist to disk write under .bb-data).
beforeEach(() => {
	try {
		rmSync('.bb-data', { recursive: true, force: true });
	} catch {}
});

test('echo returns its input (TODO: replace with real coverage)', async () => {
	const bb = make();
	assert.strictEqual(await bb.echo('hello'), 'hello');
});

test('error constants are defined', () => {
	assert.ok(__BB_CLASS__Errors.InvalidInput);
});
