// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
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

void describe('cdk-blocks secret / config CLI options forwarding', () => {
	afterEach(() => mock.restoreAll());

	void it('forwards `interactive: false` to the hosting CLI', async () => {
		for (const run of [runSecretCli, runConfigCli]) {
			await assert.rejects(
				run(['set', 'ONLY_KEY'], { interactive: false }),
				(e: unknown) => e instanceof ValueCliUsageError && /cannot prompt/.test(e.message),
			);
		}
	});

	void it('forwards `yes` so a forced secret delete is confirmed', async () => {
		await assert.rejects(runSecretCli(['remove', 'K', '--force']), ValueCliUsageError);
		// Confirmed, it reaches its first store call, which fails offline with no Region.
		const saved = { ...process.env };
		for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE']) delete process.env[key];
		process.env.AWS_CONFIG_FILE = '/nonexistent/aws-config';
		process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/aws-credentials';
		try {
			await assert.rejects(
				runSecretCli(['remove', 'K', '--force'], { yes: true }),
				(e: unknown) => !(e instanceof ValueCliUsageError) && /Region is missing/.test(String(e)),
			);
		} finally {
			process.env = saved;
		}
	});
});

