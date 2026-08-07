// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { runSecretCli } from './secret.js';

// These validate argv parsing + validation only (no live SSM). The set/list/
// remove SDK calls are exercised end-to-end during deploy verification.

void describe('runSecretCli() argv parsing', () => {
	void it('rejects an unknown subcommand', async () => {
		await assert.rejects(runSecretCli(['frobnicate']), /Unknown secret subcommand/);
	});

	void it('requires a key and value for set', async () => {
		await assert.rejects(runSecretCli(['set']), /Usage: blocks secret set/);
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY']), /Usage: blocks secret set/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runSecretCli(['remove']), /Usage: blocks secret remove/);
	});

	void it('validates the key before any SSM call', async () => {
		// Invalid key shape must fail fast with a clear message, not attempt SSM.
		await assert.rejects(runSecretCli(['set', '1bad', 'value']), /Invalid secret key/);
	});
});
