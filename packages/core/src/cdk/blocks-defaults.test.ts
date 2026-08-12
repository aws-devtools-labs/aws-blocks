// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the stack-wide BlocksDefaults mechanism:
 *   - the sandbox/production presets carry the expected posture
 *   - register/get round-trips on the owning stack
 *   - an unregistered stack falls back to the (safe) production preset
 *   - a Building Block resolves `option ?? scope.defaults` correctly
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import { BlocksPresets, registerStackBlocksDefaults, getStackBlocksDefaults } from './blocks-defaults.js';

function stack(): cdk.Stack {
	const app = new cdk.App();
	return new cdk.Stack(app, 'TestStack');
}

describe('BlocksPresets', () => {
	test('sandbox is disposable: DESTROY + deletion protection off', () => {
		assert.strictEqual(BlocksPresets.sandbox.removalPolicy, RemovalPolicy.DESTROY);
		assert.strictEqual(BlocksPresets.sandbox.deletionProtection, false);
	});

	test('production is durable: RETAIN + deletion protection on', () => {
		assert.strictEqual(BlocksPresets.production.removalPolicy, RemovalPolicy.RETAIN);
		assert.strictEqual(BlocksPresets.production.deletionProtection, true);
	});
});

describe('register / get round-trip', () => {
	test('getStackBlocksDefaults returns what was registered', () => {
		const s = stack();
		registerStackBlocksDefaults(s, BlocksPresets.sandbox);
		assert.deepStrictEqual(getStackBlocksDefaults(s), BlocksPresets.sandbox);
	});

	test('an override spread over a preset round-trips', () => {
		const s = stack();
		const custom = { ...BlocksPresets.production, deletionProtection: false };
		registerStackBlocksDefaults(s, custom);
		assert.deepStrictEqual(getStackBlocksDefaults(s), custom);
	});
});

describe('fallback', () => {
	test('an unregistered stack resolves to the production preset (safe by default)', () => {
		assert.deepStrictEqual(getStackBlocksDefaults(stack()), BlocksPresets.production);
	});
});

describe('block-level resolution (option ?? scope.defaults)', () => {
	// Mirrors how a BB resolves a value: a per-block option wins, otherwise the
	// stack default applies. There is intentionally no tier below the stack.
	function resolve(perBlock: RemovalPolicy | undefined, s: cdk.Stack): RemovalPolicy {
		return perBlock ?? getStackBlocksDefaults(s).removalPolicy;
	}

	test('stack default applies when the block has no option', () => {
		const s = stack();
		registerStackBlocksDefaults(s, BlocksPresets.sandbox);
		assert.strictEqual(resolve(undefined, s), RemovalPolicy.DESTROY);
	});

	test('per-block option overrides the stack default', () => {
		const s = stack();
		registerStackBlocksDefaults(s, BlocksPresets.sandbox);
		assert.strictEqual(resolve(RemovalPolicy.RETAIN, s), RemovalPolicy.RETAIN);
	});
});
