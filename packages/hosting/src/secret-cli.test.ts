// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { runValueCli } from './secret-cli.js';

// argv parsing + validation only (no live SSM/Secrets Manager).

void describe('runValueCli() — kind fixed by wrapper', () => {
	void it('requires a key for set (usage shows the label)', async () => {
		await assert.rejects(
			runValueCli(['set'], { kind: 'secret', label: 'blocks secret' }),
			/Usage: blocks secret set/,
		);
	});

	void it('key-only set falls through to the hidden prompt (errors when stdin is not a TTY)', async () => {
		await assert.rejects(
			runValueCli(['set', 'ONLY_KEY'], { kind: 'config' }),
			/stdin is not a TTY.*--value-stdin/s,
		);
	});

	void it('rejects value both positionally and via --value-stdin', async () => {
		await assert.rejects(
			runValueCli(['set', 'K', 'v', '--value-stdin'], { kind: 'secret' }),
			/via stdin OR as an argument, not both/,
		);
	});

	void it('validates the key before any store call', async () => {
		await assert.rejects(runValueCli(['set', '1bad', 'v'], { kind: 'secret' }), /Invalid key/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runValueCli(['remove'], { kind: 'config', label: 'config' }), /Usage: config remove/);
	});

	void it('rejects --stage without a value', async () => {
		await assert.rejects(
			runValueCli(['set', 'K', 'v', '--stage'], { kind: 'secret' }),
			/--stage.*requires a value/,
		);
	});

	void it('strips --stage/--prefix from positionals (reaches the prompt)', async () => {
		await assert.rejects(
			runValueCli(['set', 'ONLY_KEY', '--stage', 'prod', '--prefix', '/p'], { kind: 'config' }),
			/stdin is not a TTY/,
		);
	});

	void it('rejects an unknown subcommand', async () => {
		await assert.rejects(runValueCli(['frobnicate'], { kind: 'secret' }), /Unknown subcommand/);
	});
});

void describe('runValueCli() — kind from argv (single-bin style)', () => {
	void it('requires secret|config as the first arg', async () => {
		await assert.rejects(runValueCli(['nope', 'set', 'K']), /Expected 'secret' or 'config'/);
	});

	void it('accepts `secret set` shape', async () => {
		await assert.rejects(runValueCli(['secret', 'set', 'ONLY_KEY']), /stdin is not a TTY/);
	});

	void it('accepts `config set` shape', async () => {
		await assert.rejects(runValueCli(['config', 'set', 'ONLY_KEY']), /stdin is not a TTY/);
	});
});
