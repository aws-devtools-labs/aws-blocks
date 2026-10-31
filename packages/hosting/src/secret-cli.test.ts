// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { forceDeleteWarning, runValueCli, ValueCliInterruptedError, ValueCliUsageError } from './secret-cli.js';

afterEach(() => mock.restoreAll());

/** Stops a forced delete at its warning, before any store call: proves the confirmation passed. */
function stopAtForceWarning(): void {
	mock.method(console, 'warn', () => {
		throw new Error('reached the forced delete');
	});
}

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

	void it('refuses an unknown option before any store call, instead of taking it as part of the value', async () => {
		for (const argv of [
			['set', 'K', 'value', '--profile', 'p'],
			['set', 'K', 'v', '--output', 'json'],
			['list', '--no-input'],
			['remove', 'K', '-q'],
		]) {
			await assert.rejects(
				runValueCli(argv, { kind: 'config', label: 'blocks config' }),
				(e: unknown) => e instanceof ValueCliUsageError && /^Unknown option "-/.test(e.message),
				argv.join(' '),
			);
		}
	});

	void it('refuses an extra argument to list or remove before any store call', async () => {
		await assert.rejects(
			runValueCli(['list', 'extra'], { kind: 'secret', label: 'blocks secret' }),
			(e: unknown) =>
				e instanceof ValueCliUsageError && /"extra": blocks secret list takes no arguments/.test(e.message),
		);
		await assert.rejects(
			runValueCli(['remove', 'K', 'extra'], { kind: 'config', label: 'blocks config' }),
			(e: unknown) =>
				e instanceof ValueCliUsageError && /"extra": blocks config remove takes one KEY/.test(e.message),
		);
	});

	void it('takes every token after -- as a positional, so a value can start with "-"', async () => {
		// The key check runs before any store call: "-1" reached it as the key, not as an option.
		await assert.rejects(runValueCli(['set', '--', '-1', 'v'], { kind: 'config' }), /Invalid key "-1"/);
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

void describe('runValueCli() — interactive / yes options', () => {
	void it('`yes: true` confirms `remove --force` as --yes does', async () => {
		stopAtForceWarning();
		await assert.rejects(
			runValueCli(['remove', 'DB_PASSWORD', '--force'], { kind: 'secret', yes: true }),
			/reached the forced delete/,
		);
	});

	void it('key-only set with `interactive: false` refuses the prompt with a ValueCliUsageError', async () => {
		await assert.rejects(
			runValueCli(['set', 'ONLY_KEY'], { kind: 'secret', interactive: false }),
			(e: unknown) => e instanceof ValueCliUsageError && /cannot prompt/.test(e.message),
		);
	});

	void it('usage failures are ValueCliUsageError instances', async () => {
		for (const argv of [['frobnicate'], ['set'], ['remove'], ['set', '--stage'], ['remove', 'K', '--force']]) {
			await assert.rejects(
				runValueCli(argv, { kind: 'secret' }),
				(e: unknown) => e instanceof ValueCliUsageError,
				argv.join(' '),
			);
		}
	});
});

/** Run `fn` with a terminal-like stdin that `feed` writes to, and capture what it writes to stdout and stderr. */
async function withTerminal<T>(
	feed: (input: PassThrough) => void,
	fn: () => Promise<T>,
): Promise<{ result: Promise<T>; stdout: string; stderr: string }> {
	const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
	const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
	Object.defineProperty(process, 'stdin', { configurable: true, get: () => input });
	let stdout = '';
	let stderr = '';
	mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	});
	mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	try {
		const result = fn();
		// The prompt reads from the interface it creates once its import resolves.
		while (input.listenerCount('keypress') === 0 && input.listenerCount('data') === 0) await setImmediatePromise();
		feed(input);
		await result.catch(() => {});
		return { result, stdout, stderr };
	} finally {
		mock.restoreAll();
		if (stdin) Object.defineProperty(process, 'stdin', stdin);
	}
}

void describe('runValueCli() — the hidden prompt', () => {
	void it('rejects with ValueCliInterruptedError on Ctrl-C and on Ctrl-D, before any store call', async () => {
		// Ctrl-C after some input; Ctrl-D on an empty line (on a non-empty one it deletes a character).
		for (const keys of ['partial\x03', '\x04']) {
			const { result } = await withTerminal(
				(input) => input.write(keys),
				() => runValueCli(['set', 'ZZ_CTRL'], { kind: 'secret' }),
			);
			await assert.rejects(result, (e: unknown) => e instanceof ValueCliInterruptedError, JSON.stringify(keys));
		}
	});

	void it('writes the prompt to stderr, so stdout carries only the result', async () => {
		const { stdout, stderr } = await withTerminal(
			(input) => input.write('\x03'),
			() => runValueCli(['set', 'ZZ_PIPEOUT'], { kind: 'secret' }),
		);
		// The test runner reports on this process's stdout too: check only for the prompt.
		assert.doesNotMatch(stdout, /Enter value/);
		assert.match(stderr, /Enter value for secret 'ZZ_PIPEOUT' \(hidden\): /);
	});
});

/** Answer each Secrets Manager call with `answer(commandName, input)`, recording the calls; no AWS. */
function fakeSecretsManager(answer: (command: string, input: Record<string, unknown>) => unknown): string[] {
	const calls: string[] = [];
	mock.method(
		SecretsManagerClient.prototype,
		'send',
		async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			calls.push(command.constructor.name);
			return answer(command.constructor.name, command.input);
		},
	);
	mock.method(console, 'warn', () => {});
	return calls;
}

function awsError(name: string, message: string): Error {
	return Object.assign(new Error(message), { name });
}

void describe('runValueCli() — Secrets Manager edge cases', () => {
	void it('restores a secret that remove scheduled for deletion, then sets it', async () => {
		const calls = fakeSecretsManager((command) => {
			if (command === 'CreateSecretCommand') {
				throw awsError(
					'InvalidRequestException',
					"You can't create this secret because a secret with this name is already scheduled for deletion.",
				);
			}
			return {};
		});
		const input = Object.assign(new PassThrough(), { isTTY: false });
		const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
		Object.defineProperty(process, 'stdin', { configurable: true, get: () => input });
		try {
			input.end('v\n');
			await runValueCli(['set', 'ZZ_DBG', '--value-stdin'], { kind: 'secret', prefix: 'blocks/secrets' });
		} finally {
			if (stdin) Object.defineProperty(process, 'stdin', stdin);
		}
		assert.deepStrictEqual(calls, ['CreateSecretCommand', 'RestoreSecretCommand', 'PutSecretValueCommand']);
	});

	void it('reports a forced remove of a secret that does not exist as not set, and deletes nothing', async () => {
		const calls = fakeSecretsManager((command) => {
			if (command === 'DescribeSecretCommand') {
				throw awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.");
			}
			return {};
		});
		const log = mock.method(console, 'log', () => {});
		await runValueCli(['remove', 'ZZ_NOPE', '--force', '--yes'], { kind: 'secret', prefix: 'blocks/secrets' });
		assert.deepStrictEqual(calls, ['DescribeSecretCommand']);
		assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /'ZZ_NOPE' was not set/);
	});
});

void describe('runValueCli() — list', () => {
	void it('suggests an add command that the kind accepts when nothing is set', async () => {
		fakeSecretsManager(() => ({ SecretList: [] }));
		const log = mock.method(console, 'log', () => {});
		await runValueCli(['list'], { kind: 'secret', label: 'blocks secret', prefix: 'blocks/secrets' });
		assert.strictEqual(
			log.mock.calls.at(-1)?.arguments[0],
			'No secret values set. Add one: blocks secret set <KEY>',
		);
	});
});

void describe('runValueCli() — usage errors', () => {
	void it('reports an invalid key, an empty value and a missing subcommand as ValueCliUsageError', async () => {
		const input = Object.assign(new PassThrough(), { isTTY: false });
		const stdin = Object.getOwnPropertyDescriptor(process, 'stdin');
		Object.defineProperty(process, 'stdin', { configurable: true, get: () => input });
		try {
			input.end('');
			await assert.rejects(
				runValueCli(['set', 'K', '--value-stdin'], { kind: 'secret' }),
				(e: unknown) => e instanceof ValueCliUsageError && /No value provided for 'K'/.test(e.message),
			);
		} finally {
			if (stdin) Object.defineProperty(process, 'stdin', stdin);
		}
		for (const argv of [
			['set', 'bad-key', 'v'],
			['set', '1BAD', 'v'],
			['remove', 'bad-key'],
		]) {
			await assert.rejects(
				runValueCli(argv, { kind: 'config' }),
				(e: unknown) => e instanceof ValueCliUsageError && /^Invalid key/.test(e.message),
				argv.join(' '),
			);
		}
		await assert.rejects(
			runValueCli([], { kind: 'secret', label: 'blocks secret' }),
			(e: unknown) =>
				e instanceof ValueCliUsageError &&
				e.message === 'blocks secret needs a subcommand: set, list or remove.',
		);
	});
});
