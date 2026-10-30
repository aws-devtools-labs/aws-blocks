// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { afterEach, describe, it, mock } from 'node:test';
import { ValueCliUsageError } from '@aws-blocks/hosting/scripts';
import { runConfigCli } from './config.js';
import { runSecretCli } from './secret.js';

// argv parsing + validation only (no live SSM/Secrets Manager). The set/list/
// remove SDK calls are exercised end-to-end during deploy verification.

void describe('blocks secret / config CLI argv parsing', () => {
	void it('rejects an unknown subcommand', async () => {
		await assert.rejects(runSecretCli(['frobnicate']), /Unknown subcommand/);
		await assert.rejects(runConfigCli(['frobnicate']), /Unknown subcommand/);
	});

	void it('requires a key for set (label reflects the kind)', async () => {
		await assert.rejects(runSecretCli(['set']), /Usage: blocks secret set/);
		await assert.rejects(runConfigCli(['set']), /Usage: blocks config set/);
	});

	void it('key-only set falls through to the hidden prompt (TTY error, not usage)', async () => {
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY']), /stdin is not a TTY/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runSecretCli(['remove']), /Usage: blocks secret remove/);
		await assert.rejects(runConfigCli(['remove']), /Usage: blocks config remove/);
	});

	void it('validates the key before any store call', async () => {
		await assert.rejects(runSecretCli(['set', '1bad', 'value']), /Invalid key/);
	});
});

void describe('blocks secret / config CLI options forwarding', () => {
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
		// The forced delete warns before any store call; stop there.
		mock.method(console, 'warn', () => {
			throw new Error('reached the forced delete');
		});
		await assert.rejects(runSecretCli(['remove', 'K', '--force'], { yes: true }), /reached the forced delete/);
	});
});

