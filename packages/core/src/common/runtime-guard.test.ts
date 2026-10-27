// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotMockInDeployedEnv, isDeployedEnv } from './runtime-guard.js';
import * as bbUtils from '../bb-utils.js';

const ENV_KEYS = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY'] as const;
let saved: Record<string, string | undefined> = {};

/** Restore the saved env vars, deleting any that were originally unset. */
function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
}

beforeEach(() => {
	saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	restoreEnv();
});

describe('assertNotMockInDeployedEnv', () => {
	it('throws when BLOCKS_CONFIG_BUCKET and BLOCKS_CONFIG_KEY are both set (deployed)', () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.throws(
			() => assertNotMockInDeployedEnv('bb-test'),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /bb-test/);
				assert.match(err.message, /deployed environment/);
				assert.match(err.message, /aws-runtime/);
				return true;
			},
		);
	});

	it('does not throw when only BLOCKS_CONFIG_BUCKET is set (partial config)', () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		assert.doesNotThrow(() => assertNotMockInDeployedEnv('bb-test'));
	});

	it('does not throw when only BLOCKS_CONFIG_KEY is set (partial config)', () => {
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.doesNotThrow(() => assertNotMockInDeployedEnv('bb-test'));
	});

	it('does not throw when both are set but empty', () => {
		process.env.BLOCKS_CONFIG_BUCKET = '';
		process.env.BLOCKS_CONFIG_KEY = '';
		assert.doesNotThrow(() => assertNotMockInDeployedEnv('bb-test'));
	});

	it('is a no-op when neither is set (local dev)', () => {
		assert.doesNotThrow(() => assertNotMockInDeployedEnv('bb-test'));
	});
});

describe('isDeployedEnv', () => {
	it('is true only when both config variables are set, on any compute', () => {
		assert.equal(isDeployedEnv(), false);
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		assert.equal(isDeployedEnv(), false, 'a partial configuration is not deployed');
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.equal(isDeployedEnv(), true);
	});

	it('ignores Lambda-only variables', () => {
		const saved = process.env.AWS_LAMBDA_FUNCTION_NAME;
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn';
		try {
			assert.equal(isDeployedEnv(), false);
		} finally {
			if (saved === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
			else process.env.AWS_LAMBDA_FUNCTION_NAME = saved;
		}
	});

	it('is exported from @aws-blocks/core/bb-utils for Building Block authors', () => {
		assert.equal(bbUtils.isDeployedEnv, isDeployedEnv);
	});
});
