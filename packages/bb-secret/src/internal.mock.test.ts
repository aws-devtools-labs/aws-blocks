// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock tests for `frameworkKey()`: local dev behaves exactly as it did with
 * `new AppSetting(scope, id, { secret: true })`.
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Scope } from '@aws-blocks/core';
import { frameworkKey } from './internal.mock.js';

const BB_DATA = join(process.cwd(), '.bb-data');

beforeEach(() => {
	rmSync(BB_DATA, { recursive: true, force: true });
});

test('mock: get() returns a stable non-empty key across instances', async () => {
	const a = await frameworkKey(new Scope('app'), 'signing-key').get();
	const b = await frameworkKey(new Scope('app'), 'signing-key').get();
	assert.ok(a.length > 0);
	assert.strictEqual(a, b);
});

test('mock: reads the same stored value as AppSetting({ secret: true }) at the same scope and id', async () => {
	const viaHelper = await frameworkKey(new Scope('app'), 'signing-key').get();
	const viaAppSetting = await new AppSetting(new Scope('app'), 'signing-key', { secret: true }).get();
	assert.strictEqual(viaHelper, viaAppSetting);
});

test('mock: different ids get different keys', async () => {
	const a = await frameworkKey(new Scope('app'), 'signing-key').get();
	const b = await frameworkKey(new Scope('app'), 'token-secret').get();
	assert.notStrictEqual(a, b);
});
