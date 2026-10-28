// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { forceDeleteWarning, runValueCli } from './secret-cli.js';

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

	void it('rejects a positional value for a SECRET (would land in argv / shell history) (B7)', async () => {
		await assert.rejects(
			runValueCli(['set', 'STRIPE_KEY', 'sk_live_x'], { kind: 'secret' }),
			/must not be passed on the command line.*value-stdin/s,
		);
	});

	void it('validates the key before any store call', async () => {
		await assert.rejects(runValueCli(['set', '1bad', 'v'], { kind: 'secret' }), /Invalid key/);
	});

	void it('requires a key for remove', async () => {
		await assert.rejects(runValueCli(['remove'], { kind: 'config', label: 'config' }), /Usage: config remove/);
	});

	void it('strips --force from positionals (not treated as the key)', async () => {
		// --force alone leaves no key → the usage error proves the flag was parsed, not consumed as <KEY>.
		await assert.rejects(runValueCli(['remove', '--force'], { kind: 'secret' }), /Usage: .*remove <KEY>/);
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

	void it('rejects --region without a value', async () => {
		await assert.rejects(
			runValueCli(['set', 'K', 'v', '--region'], { kind: 'secret' }),
			/--region.*requires a value/,
		);
	});

	void it('strips --region (and --region=) from positionals (reaches the prompt)', async () => {
		await assert.rejects(
			runValueCli(['set', 'ONLY_KEY', '--region', 'us-east-1'], { kind: 'config' }),
			/stdin is not a TTY/,
		);
		await assert.rejects(
			runValueCli(['set', 'ONLY_KEY', '--region=eu-west-1'], { kind: 'config' }),
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

void describe('removeValue --force safeguards (PR #850 review, S3)', () => {
	void it('the warning names the stage and says the delete is immediate and unrecoverable', () => {
		const w = forceDeleteWarning('secret', 'DB_PASSWORD', 'dev');
		assert.match(w, /'DB_PASSWORD'/);
		assert.match(w, /stage 'dev'/);
		assert.match(w, /immediately/);
		assert.match(w, /no recovery/i);
	});

	void it('with no stage, the warning says the value is shared by every stage, production included', () => {
		assert.match(forceDeleteWarning('secret', 'K', undefined), /every stage, including production/);
		assert.match(forceDeleteWarning('secret', 'K', ''), /every stage, including production/);
	});

	void it('the CLI refuses `remove --force` on a secret without --yes in every stage, before any store call', async () => {
		// Any stage name: production can't be told apart reliably (`prod-us-east-1`, `prd`, `live`).
		for (const stageArgs of [
			['--stage', 'prod'],
			['--stage', 'prod-us-east-1'],
			['--stage', 'prd'],
			['--stage', 'live'],
			['--stage', 'dev'],
			['--stage='],
			[],
		]) {
			await assert.rejects(
				runValueCli(['remove', 'DB_PASSWORD', '--force', ...stageArgs], { kind: 'secret' }),
				/Refusing to force-delete .*--yes/s,
				stageArgs.join(' ') || 'no stage',
			);
		}
	});

	void it('--yes is parsed as a flag, not taken as the key', async () => {
		await assert.rejects(runValueCli(['remove', '--force', '--yes'], { kind: 'secret' }), /Usage: .*remove <KEY>/);
	});
});
