// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
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
