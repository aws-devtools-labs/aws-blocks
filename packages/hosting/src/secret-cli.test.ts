// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { runSecretCli } from './secret-cli.js';

// argv parsing + validation only (no live SSM/Secrets Manager). The set/list/
// remove SDK calls are exercised during deploy verification.

void describe('runSecretCli() argv parsing', () => {
	void it('rejects an unknown subcommand', async () => {
		await assert.rejects(runSecretCli(['frobnicate']), /Unknown secret subcommand/);
	});

	void it('requires a key and value for set (usage shows the consumer label)', async () => {
		await assert.rejects(runSecretCli(['set'], { label: 'ampx hosting secret' }), /Usage: ampx hosting secret set/);
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY']), /Usage: secret set/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runSecretCli(['remove']), /Usage: secret remove/);
	});

	void it('validates the key before any store call', async () => {
		await assert.rejects(runSecretCli(['set', '1bad', 'value']), /Invalid secret key/);
	});
});
