// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotMockInDeployedEnv, getDeploymentType } from './runtime-guard.js';
import { _resetConfigCache, _setS3Fetcher, loadConfigToProcessEnv } from './config.js';

const ENV_KEYS = ['BLOCKS_CONFIG_BUCKET', 'BLOCKS_CONFIG_KEY', 'BLOCKS_DEPLOYMENT_TYPE'] as const;
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
	_resetConfigCache();
});

afterEach(() => {
	_resetConfigCache();
	restoreEnv();
});

/**
 * Simulate a deployed compute: set the config location and load `config` as the
 * BB config file (through the same `loadConfigToProcessEnv()` the entry points use).
 */
async function loadDeployedConfig(config: Record<string, string>): Promise<void> {
	process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
	process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
	_setS3Fetcher(async () => JSON.stringify(config));
	await loadConfigToProcessEnv();
}

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

describe('getDeploymentType', () => {
	it("returns 'sandbox' when BLOCKS_DEPLOYMENT_TYPE is 'sandbox'", () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		assert.equal(getDeploymentType(), 'sandbox');
	});

	it("returns 'sandbox' on deployed compute when the loaded config says 'sandbox'", async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'sandbox' });
		assert.equal(getDeploymentType(), 'sandbox');
	});

	it('on deployed compute, a pre-set BLOCKS_DEPLOYMENT_TYPE env var does not override the config value', async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'production' });
		// loadConfigToProcessEnv() keeps the pre-set env var...
		assert.equal(process.env.BLOCKS_DEPLOYMENT_TYPE, 'sandbox');
		// ...but getDeploymentType() reads the config entry on deployed compute.
		assert.equal(getDeploymentType(), 'production');
	});

	it("on deployed compute, ignores a BLOCKS_DEPLOYMENT_TYPE env var when the config has no entry ('production')", async () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		await loadDeployedConfig({ OTHER_KEY: 'value' });
		assert.equal(getDeploymentType(), 'production');
	});

	it("on deployed compute, ignores a BLOCKS_DEPLOYMENT_TYPE env var before the config is loaded ('production')", () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'sandbox';
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.equal(getDeploymentType(), 'production');
	});

	it('treats an unrecognized config value as unset (deployed)', async () => {
		await loadDeployedConfig({ BLOCKS_DEPLOYMENT_TYPE: 'Sandbox' });
		assert.equal(getDeploymentType(), 'production');
	});

	it("returns 'production' when BLOCKS_DEPLOYMENT_TYPE is 'production'", () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'production';
		assert.equal(getDeploymentType(), 'production');
	});

	it('treats an unrecognized value as unset (local)', () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'Sandbox';
		assert.equal(getDeploymentType(), 'local');
	});

	it('treats an unrecognized value as unset (deployed)', () => {
		process.env.BLOCKS_DEPLOYMENT_TYPE = 'local';
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.equal(getDeploymentType(), 'production');
	});

	it("falls back to 'production' when unset and BLOCKS_CONFIG_BUCKET/KEY are set", () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		process.env.BLOCKS_CONFIG_KEY = 'test-key.json';
		assert.equal(getDeploymentType(), 'production');
	});

	it("falls back to 'local' when unset and no deployed config", () => {
		assert.equal(getDeploymentType(), 'local');
	});

	it("falls back to 'local' with partial deployed config", () => {
		process.env.BLOCKS_CONFIG_BUCKET = 'test-bucket';
		assert.equal(getDeploymentType(), 'local');
	});
});
