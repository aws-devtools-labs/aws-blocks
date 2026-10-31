// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { secretStoreLocator } from '@aws-blocks/hosting';
import {
	BLOCKS_CONFIG_PARAMETER_PREFIX,
	BLOCKS_SECRET_PARAMETER_PREFIX,
	blocksConfigParameterName,
	blocksConfigPrefix,
	blocksSecretParameterName,
	blocksSecretPrefix,
	blocksStoreConfig,
} from './secret-naming.js';

// These run with no `.blocks/config.json` in cwd, so they exercise the UNSCOPED
// fallback. A real Blocks app has the file, so it gets the `stackId`-scoped path
// (covered by the explicit-stackId cases below).
void describe('Blocks value namespaces — fallback (no .blocks/config.json)', () => {
	void it('falls back to the unscoped /blocks/secrets and /blocks/config bases', () => {
		assert.strictEqual(BLOCKS_SECRET_PARAMETER_PREFIX, '/blocks/secrets');
		assert.strictEqual(BLOCKS_CONFIG_PARAMETER_PREFIX, '/blocks/config');
		// Secrets Manager names are slash-free at the root; SSM keeps the leading slash.
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY'), 'blocks/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS'), '/blocks/config/FEATURE_FLAGS');
		assert.deepStrictEqual(blocksStoreConfig(), {
			secretStore: { prefix: '/blocks/secrets' },
			configStore: { prefix: '/blocks/config' },
		});
	});

	void it('matches the store locator the CLI/grant/runtime actually use (no divergent name)', () => {
		assert.strictEqual(
			blocksSecretParameterName('K'),
			secretStoreLocator('K', { prefix: BLOCKS_SECRET_PARAMETER_PREFIX, store: 'secrets-manager' }),
		);
		assert.strictEqual(
			blocksConfigParameterName('K'),
			secretStoreLocator('K', { prefix: BLOCKS_CONFIG_PARAMETER_PREFIX, store: 'ssm' }),
		);
	});
});

void describe('Blocks value namespaces — stackId-scoped (B5)', () => {
	void it('scopes the prefix by stackId so two apps in one account never collide', () => {
		assert.strictEqual(blocksSecretPrefix('myapp'), '/blocks/myapp/secrets');
		assert.strictEqual(blocksConfigPrefix('myapp'), '/blocks/myapp/config');
		assert.deepStrictEqual(blocksStoreConfig('myapp'), {
			secretStore: { prefix: '/blocks/myapp/secrets' },
			configStore: { prefix: '/blocks/myapp/config' },
		});
	});

	void it('scoped store names match secretStoreLocator (SM slash-free, SSM leading-slash)', () => {
		assert.strictEqual(blocksSecretParameterName('STRIPE_KEY', 'myapp'), 'blocks/myapp/secrets/STRIPE_KEY');
		assert.strictEqual(blocksConfigParameterName('FEATURE_FLAGS', 'myapp'), '/blocks/myapp/config/FEATURE_FLAGS');
	});
});

// The prefix helpers read `.blocks/config.json` from cwd when no stackId is passed.
void describe('Blocks value namespaces — reading .blocks/config.json', () => {
	const originalCwd = process.cwd();
	let app: string;

	beforeEach(() => {
		app = mkdtempSync(join(tmpdir(), 'blocks-ns-'));
		mkdirSync(join(app, '.blocks'));
		process.chdir(app);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(app, { recursive: true, force: true });
	});

	void it('scopes by the stackId of a config saved with a UTF-8 BOM', () => {
		writeFileSync(join(app, '.blocks', 'config.json'), '\uFEFF{\n  "stackId": "my-app-1"\n}\n');
		assert.strictEqual(blocksSecretPrefix(), '/blocks/my-app-1/secrets');
		assert.strictEqual(blocksConfigPrefix(), '/blocks/my-app-1/config');
		assert.strictEqual(blocksSecretParameterName('K'), 'blocks/my-app-1/secrets/K');
	});

	for (const [label, content] of [
		['invalid JSON', '{ "stackId": "my-app-1", }'],
		['a top-level array', '[{"stackId":"my-app-1"}]'],
	] as const) {
		void it(`throws instead of falling back to the shared namespace when the config is ${label}`, () => {
			writeFileSync(join(app, '.blocks', 'config.json'), content);
			assert.throws(() => blocksSecretPrefix(), /\.blocks\/config\.json could not be read/);
			assert.throws(() => blocksStoreConfig(), /\.blocks\/config\.json could not be read/);
		});
	}

	void it('an explicit stackId never reads the config file', () => {
		writeFileSync(join(app, '.blocks', 'config.json'), '{ not json');
		assert.strictEqual(blocksSecretPrefix('myapp'), '/blocks/myapp/secrets');
	});

	void it('still falls back silently (synth path) when the config is missing or has no stackId', (t) => {
		const warn = t.mock.method(console, 'warn', () => {});
		assert.strictEqual(blocksSecretPrefix(), BLOCKS_SECRET_PARAMETER_PREFIX);
		writeFileSync(join(app, '.blocks', 'config.json'), '{"telemetry":{"enabled":false}}');
		assert.deepStrictEqual(blocksStoreConfig(), {
			secretStore: { prefix: BLOCKS_SECRET_PARAMETER_PREFIX },
			configStore: { prefix: BLOCKS_CONFIG_PARAMETER_PREFIX },
		});
		assert.strictEqual(warn.mock.callCount(), 0);
	});
});
