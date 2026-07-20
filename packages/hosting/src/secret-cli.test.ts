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

	// ── --stage flag parsing (no live store; assert via validation paths) ──
	void it('rejects --stage without a value', async () => {
		await assert.rejects(runSecretCli(['set', 'K', 'v', '--stage']), /--stage.*requires a value/);
	});

	void it('strips --stage <name> from positionals (set still needs KEY + value)', async () => {
		// With the stage flag removed, only a key remains → usage error (proves
		// the flag+value were extracted, not treated as the value).
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY', '--stage', 'prod']), /Usage:.*set <KEY> <value>/);
	});

	void it('still validates the key when a stage is present', async () => {
		await assert.rejects(runSecretCli(['set', '1bad', 'value', '--stage', 'prod']), /Invalid secret key/);
	});

	void it('accepts --stage=<name> form (key-only still errors on usage)', async () => {
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY', '--stage=prod']), /Usage:.*set <KEY> <value>/);
	});
});
