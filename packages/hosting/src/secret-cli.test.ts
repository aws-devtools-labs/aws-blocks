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

	void it('requires a key for set (usage shows the consumer label)', async () => {
		await assert.rejects(runSecretCli(['set'], { label: 'ampx hosting secret' }), /Usage: ampx hosting secret set/);
	});

	void it('key-only set falls through to the hidden prompt (errors when stdin is not a TTY)', async () => {
		// No positional value and no --value-stdin → interactive hidden prompt.
		// The test runner's stdin is not a TTY, so it errors with the stdin hint
		// instead of the old usage error.
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY']), /stdin is not a TTY.*--value-stdin/s);
	});

	void it('rejects passing a value both positionally and via --value-stdin', async () => {
		await assert.rejects(
			runSecretCli(['set', 'K', 'someval', '--value-stdin']),
			/via stdin OR as an argument, not both/,
		);
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

	void it('strips --stage <name> from positionals (the flag+value are not the value)', async () => {
		// With the stage flag removed, only a key remains → the hidden-prompt path
		// (TTY hint here), proving the flag+value were extracted, not treated as
		// the value.
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY', '--stage', 'prod']), /stdin is not a TTY/);
	});

	void it('still validates the key when a stage is present', async () => {
		await assert.rejects(runSecretCli(['set', '1bad', 'value', '--stage', 'prod']), /Invalid secret key/);
	});

	void it('accepts --stage=<name> form (key-only falls through to the prompt)', async () => {
		await assert.rejects(runSecretCli(['set', 'ONLY_KEY', '--stage=prod']), /stdin is not a TTY/);
	});

	// ── --prefix / --store flag parsing (for the standalone `hosting-secret` bin) ──
	void it('rejects --prefix without a value', async () => {
		await assert.rejects(runSecretCli(['set', 'K', 'v', '--prefix']), /--prefix.*requires a value/);
	});

	void it('rejects --store without a value', async () => {
		await assert.rejects(runSecretCli(['set', 'K', 'v', '--store']), /--store.*requires a value/);
	});

	void it('rejects an invalid --store value', async () => {
		await assert.rejects(runSecretCli(['set', 'K', 'v', '--store', 'vault']), /--store.*must be 'ssm' or 'secrets-manager'/);
	});

	void it('strips --prefix/--store from positionals (they are not the value)', async () => {
		// Flags removed, only a key remains → hidden-prompt path (TTY hint here),
		// proving --prefix <path> and --store <s> were extracted, not treated as the value.
		await assert.rejects(
			runSecretCli(['set', 'ONLY_KEY', '--prefix', '/myapp/secrets', '--store', 'ssm']),
			/stdin is not a TTY/,
		);
	});

	void it('accepts --prefix=<path> / --store=<s> forms', async () => {
		await assert.rejects(
			runSecretCli(['set', 'ONLY_KEY', '--prefix=/myapp/secrets', '--store=secrets-manager']),
			/stdin is not a TTY/,
		);
	});
});
