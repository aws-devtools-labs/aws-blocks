// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { ValueCliUsageError } from '@aws-blocks/hosting/scripts';
import { runConfigCli } from './config.js';
import { runSecretCli } from './secret.js';

// argv parsing + validation only (no live SSM/Secrets Manager). The set/list/
// remove SDK calls are exercised end-to-end during deploy verification.

void describe('cdk-blocks secret / config CLI argv parsing', () => {
	void it('rejects an unknown subcommand', async () => {
		await assert.rejects(runSecretCli(['frobnicate']), /Unknown subcommand/);
		await assert.rejects(runConfigCli(['frobnicate']), /Unknown subcommand/);
	});

	void it('requires a key for set (label reflects the kind)', async () => {
		await assert.rejects(runSecretCli(['set']), /Usage: cdk-blocks secret set/);
		await assert.rejects(runConfigCli(['set']), /Usage: cdk-blocks config set/);
	});

	void it('key-only set falls through to the hidden prompt (TTY error, not usage)', async () => {
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY']), /stdin is not a TTY/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runSecretCli(['remove']), /Usage: cdk-blocks secret remove/);
		await assert.rejects(runConfigCli(['remove']), /Usage: cdk-blocks config remove/);
	});

	void it('validates the key before any store call', async () => {
		await assert.rejects(runSecretCli(['set', '1bad', 'value']), /Invalid key/);
	});
});

// An explicit `--prefix` keeps these cases independent of the cwd's `.blocks/config.json`
// (and of the missing-stackId warning the default namespace would print).
void describe('cdk-blocks secret / config CLI options forwarding', () => {
	afterEach(() => mock.restoreAll());

	void it('forwards `interactive: false` to the hosting CLI', async () => {
		for (const run of [runSecretCli, runConfigCli]) {
			await assert.rejects(
				run(['set', 'ONLY_KEY', '--prefix', '/test/values'], { interactive: false }),
				(e: unknown) => e instanceof ValueCliUsageError && /cannot prompt/.test(e.message),
			);
		}
	});

	void it('forwards `yes` so a forced secret delete is confirmed', async () => {
		await assert.rejects(runSecretCli(['remove', 'K', '--force', '--prefix', '/test/secrets']), ValueCliUsageError);
		// Confirmed, it reaches its first store call, which fails offline with no Region.
		const saved = { ...process.env };
		for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) delete process.env[key];
		process.env.AWS_CONFIG_FILE = '/nonexistent/aws-config';
		process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/aws-credentials';
		try {
			await assert.rejects(
				runSecretCli(['remove', 'K', '--force', '--prefix', '/test/secrets'], { yes: true }),
				(e: unknown) => !(e instanceof ValueCliUsageError) && /Region is missing/.test(String(e)),
			);
		} finally {
			process.env = saved;
		}
	});
});

// The CLI resolves the default namespace from `.blocks/config.json` in cwd. Each case
// runs in a fresh app dir and fails on the key check, so no store call is made.
void describe('cdk-blocks secret / config CLI namespace resolution', () => {
	const originalCwd = process.cwd();
	let app: string;

	beforeEach(() => {
		app = mkdtempSync(join(tmpdir(), 'blocks-cli-ns-'));
		process.chdir(app);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(app, { recursive: true, force: true });
	});

	function writeConfig(content: string): void {
		mkdirSync(join(app, '.blocks'), { recursive: true });
		writeFileSync(join(app, '.blocks', 'config.json'), content);
	}

	void it('warns on stderr, naming the shared namespace, when .blocks/config.json is missing', async (t) => {
		const warn = t.mock.method(console, 'warn', () => {});
		await assert.rejects(runSecretCli(['set', '1bad', 'v']), /Invalid key/);
		await assert.rejects(runConfigCli(['set', '1bad', 'v']), /Invalid key/);
		const messages = warn.mock.calls.map((c) => String(c.arguments[0]));
		assert.strictEqual(messages.length, 2);
		assert.match(messages[0], /\/blocks\/secrets/);
		assert.match(messages[0], /not found/);
		assert.match(messages[0], /"stackId"/);
		assert.match(messages[1], /\/blocks\/config/);
	});

	void it('warns when the config has no stackId', async (t) => {
		writeConfig('{"telemetry":{"enabled":false}}');
		const warn = t.mock.method(console, 'warn', () => {});
		await assert.rejects(runSecretCli(['set', '1bad', 'v']), /Invalid key/);
		assert.strictEqual(warn.mock.callCount(), 1);
		assert.match(String(warn.mock.calls[0].arguments[0]), /has no "stackId".*\/blocks\/secrets/s);
	});

	void it('does not warn when the app has a stackId (BOM included)', async (t) => {
		writeConfig('\uFEFF{"stackId":"my-app-1"}');
		const warn = t.mock.method(console, 'warn', () => {});
		await assert.rejects(runSecretCli(['set', '1bad', 'v']), /Invalid key/);
		assert.strictEqual(warn.mock.callCount(), 0);
	});

	void it('does not resolve the default namespace when --prefix is given', async (t) => {
		writeConfig('{ "stackId": "my-app-1", }');
		const warn = t.mock.method(console, 'warn', () => {});
		await assert.rejects(runSecretCli(['set', '1bad', 'v', '--prefix', '/mine/secrets']), /Invalid key/);
		await assert.rejects(runConfigCli(['set', '1bad', 'v', '--prefix=/mine/config']), /Invalid key/);
		assert.strictEqual(warn.mock.callCount(), 0);
	});

	void it('rejects with a clear error instead of falling back when the config is unparseable', async () => {
		writeConfig('{ "stackId": "my-app-1", }');
		await assert.rejects(runSecretCli(['set', '1bad', 'v']), /\.blocks\/config\.json could not be read/);
		await assert.rejects(runConfigCli(['list']), /\.blocks\/config\.json could not be read/);
	});
});
