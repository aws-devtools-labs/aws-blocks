// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * BlocksPresets carry the expected posture. Resolution/anchoring (a block
 * reading its owning backend's defaults, and two backends in one stack keeping
 * separate postures) is covered in blocks-backend.test.ts, which has the
 * fixtures to construct real backends.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { RemovalPolicy } from 'aws-cdk-lib';
import { BlocksPresets } from './blocks-defaults.js';

describe('BlocksPresets', () => {
	test('sandbox is disposable: DESTROY + deletion protection off + no PITR', () => {
		assert.strictEqual(BlocksPresets.sandbox.removalPolicy, RemovalPolicy.DESTROY);
		assert.strictEqual(BlocksPresets.sandbox.deletionProtection, false);
		assert.strictEqual(BlocksPresets.sandbox.pointInTimeRecovery, false);
	});

	test('production is durable: RETAIN + deletion protection on + PITR on', () => {
		assert.strictEqual(BlocksPresets.production.removalPolicy, RemovalPolicy.RETAIN);
		assert.strictEqual(BlocksPresets.production.deletionProtection, true);
		assert.strictEqual(BlocksPresets.production.pointInTimeRecovery, true);
	});
});
