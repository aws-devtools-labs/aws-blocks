// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveDevConfig } from './config.js';
import { createSpawnChild, findProjectRoot, isCi, logLevelFor, PromptInterrupted, promptLine } from './context.js';
import { CliError } from './errors.js';
import { parseArgv } from './parse.js';
import { shellQuote } from './runners/launch.js';
import { fixtureApp, runCli } from './test-helpers.js';

describe('the confirmation prompt', () => {
	const ask = () => {
		const input = new PassThrough();
		const answer = promptLine('Delete? [y/N] ', { input, output: new PassThrough(), terminal: true });
		return { input, answer };
	};

	it('resolves with the line typed', async () => {
		const { input, answer } = ask();
		input.write('yes\r');
		assert.strictEqual(await answer, 'yes');
	});

	it('rejects with PromptInterrupted on Ctrl-C and at the end of the input', async () => {
		const ctrlC = ask();
		ctrlC.input.write('\x03');
		await assert.rejects(ctrlC.answer, PromptInterrupted);
		const eof = ask();
		eof.input.end();
		await assert.rejects(eof.answer, PromptInterrupted);
	});
});

describe('project root detection', () => {
	it('walks up to the package.json that has an aws-blocks/ directory', () => {
		const root = fixtureApp();
		const deep = join(root, 'src', 'components');
		mkdirSync(deep, { recursive: true });
		assert.strictEqual(findProjectRoot(root), root);
		assert.strictEqual(findProjectRoot(deep), root);
		// aws-blocks/ itself may hold a package.json (an npm workspace); it is not the root.
		writeFileSync(join(root, 'aws-blocks', 'package.json'), '{}');
		assert.strictEqual(findProjectRoot(join(root, 'aws-blocks')), root);
	});

	it('finds nothing outside an app', () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-cli-none-'));
		writeFileSync(join(dir, 'package.json'), '{}');
		assert.strictEqual(findProjectRoot(dir), undefined);
	});

	it('starts from -C, and reports a clean error outside an app', async () => {
		const root = fixtureApp();
		const elsewhere = mkdtempSync(join(tmpdir(), 'blocks-cli-elsewhere-'));
		const run = await runCli(['-C', root, 'dev'], { cwd: elsewhere });
		assert.strictEqual(run.code, 0, run.stderr);
		assert.strictEqual(run.spawned[0].cwd, root);

		const outside = await runCli(['dev'], { cwd: elsewhere });
		assert.strictEqual(outside.code, 1);
		assert.match(outside.stderr, /^Error: not inside an AWS Blocks app/);
		assert.match(outside.stderr, /Try: run the command from your app directory, or pass -C <app-dir>/);

		const missing = await runCli(['-C', join(elsewhere, 'nope'), 'dev'], { cwd: elsewhere });
		assert.strictEqual(missing.code, 2);
	});
});

describe('run environment', () => {
	it('maps --profile, --region and the log level onto the child environment', async () => {
		const run = await runCli(['--profile', 'dev', '--region', 'eu-west-1', '--quiet', 'dev'], {
			cwd: fixtureApp(),
		});
		const { env } = run.spawned[0];
		assert.strictEqual(env.AWS_PROFILE, 'dev');
		assert.strictEqual(env.AWS_REGION, 'eu-west-1');
		assert.strictEqual(env.BLOCKS_LOG_LEVEL, 'quiet');
		// --quiet keeps the dev server's RPC errors: it sets the log level, not BLOCKS_DEV_QUIET.
		assert.strictEqual(env.BLOCKS_DEV_QUIET, undefined);
		const own = await runCli(['--quiet', 'dev'], { cwd: fixtureApp(), env: { BLOCKS_DEV_QUIET: '1' } });
		assert.strictEqual(own.spawned[0].env.BLOCKS_DEV_QUIET, '1', 'a user-set BLOCKS_DEV_QUIET is kept');
	});

	it('rejects arguments after -- before a non-passthrough command runs (exit 2)', async () => {
		for (const argv of [
			['deploy', '--', '--wait-live'],
			['dev', '--', '--port', '4000'],
		]) {
			const run = await runCli(argv, { cwd: fixtureApp() });
			assert.strictEqual(run.code, 2, argv.join(' '));
			assert.match(run.stderr, /^Error: unexpected arguments after --: /);
			assert.deepStrictEqual(run.spawned, []);
		}
	});

	it('orders the log level debug > verbose > quiet > inherited', () => {
		const level = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
			logLevelFor(parseArgv([...argv, 'dev']).globals, env);
		assert.strictEqual(level(['--debug', '-v', '-q']), 'debug');
		assert.strictEqual(level(['-v', '-q']), 'verbose');
		assert.strictEqual(level(['-q']), 'quiet');
		assert.strictEqual(level([], { BLOCKS_LOG_LEVEL: 'verbose' }), 'verbose');
		assert.strictEqual(level([], { BLOCKS_LOG_LEVEL: 'loud' }), 'normal');
	});

	it('treats CI=false and CI=0 as not CI', () => {
		assert.strictEqual(isCi({ CI: 'true' }), true);
		assert.strictEqual(isCi({ CI: '1' }), true);
		assert.strictEqual(isCi({ CI: 'false' }), false);
		assert.strictEqual(isCi({ CI: '0' }), false);
		assert.strictEqual(isCi({}), false);
	});

	it('quotes shell words for the sandbox dev command', () => {
		assert.strictEqual(shellQuote("/a b/it's.js", 'linux'), `'/a b/it'\\''s.js'`);
		assert.strictEqual(shellQuote('C:\\Program Files\\node.exe', 'win32'), '"C:\\Program Files\\node.exe"');
	});

	it('refuses a Windows shell word with " or %, which cmd.exe cannot quote', () => {
		for (const word of ['C:\\a"b\\node.exe', 'C:\\100%\\tsx.js', 'C:\\%PATH%\\x']) {
			assert.throws(
				() => shellQuote(word, 'win32'),
				(error: unknown) => error instanceof CliError && /contains " or %/.test(error.message),
			);
		}
		assert.strictEqual(shellQuote('/a"b%c', 'linux'), `'/a"b%c'`);
	});

	it('accepts only an AWS Region code in --region and AWS_REGION (exit 2)', async () => {
		const cwd = fixtureApp();
		for (const region of ['us-east-1', 'eu-central-2', 'us-gov-west-1', 'cn-north-1', 'ap-southeast-4']) {
			const run = await runCli(['--region', region, 'dev'], { cwd });
			assert.strictEqual(run.code, 0, `${region}: ${run.stderr}`);
			const env = await runCli(['dev'], { cwd, env: { AWS_REGION: region } });
			assert.strictEqual(env.code, 0, `${region}: ${env.stderr}`);
		}
		for (const region of ['us-east-1; rm -rf ~', 'US-EAST-1', 'useast1', 'us-east', '../x', 'us-east-1\n']) {
			const flag = await runCli(['--region', region, 'dev'], { cwd });
			assert.strictEqual(flag.code, 2, JSON.stringify(region));
			assert.match(flag.stderr, /option --region must be an AWS Region code/);
			assert.strictEqual(flag.spawned.length, 0);
			const env = await runCli(['dev'], { cwd, env: { AWS_REGION: region } });
			assert.strictEqual(env.code, 2, JSON.stringify(region));
			assert.match(env.stderr, /AWS_REGION must be an AWS Region code/);
		}
		// --region replaces a bad AWS_REGION, and help never needs a Region.
		assert.strictEqual(
			(await runCli(['--region', 'us-west-2', 'dev'], { cwd, env: { AWS_REGION: 'bad' } })).code,
			0,
		);
		assert.strictEqual((await runCli(['dev', '--help'], { cwd, env: { AWS_REGION: 'bad' } })).code, 0);
	});
});

describe('signals sent to the CLI while a child runs', () => {
	/**
	 * Start a fake child that records the first signal it receives in a file and
	 * exits; then deliver `signals` to the CLI's listeners, in order.
	 */
	async function deliver(signals: NodeJS.Signals[], sigintReachedChild: boolean) {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-cli-signals-'));
		const log = join(dir, 'signals.log');
		const ready = join(dir, 'ready');
		const script = `
const { writeFileSync } = require('node:fs');
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => {
		writeFileSync(${JSON.stringify(log)}, signal);
		process.exit(0);
	});
}
writeFileSync(${JSON.stringify(ready)}, '');
setInterval(() => {}, 1000);
`;
		const spawn = createSpawnChild({ sigintReachedChild: () => sigintReachedChild });
		const running = spawn({ command: process.execPath, args: ['-e', script], cwd: dir, env: process.env });
		// A real child process: poll for the file it writes once its handlers are installed.
		while (!existsSync(ready)) await sleep(10);
		for (const signal of signals) process.emit(signal);
		const result = await running;
		return { result, received: readFileSync(log, 'utf-8') };
	}

	it('forwards a SIGINT sent to the CLI alone, and still reports the interruption', async () => {
		const { result, received } = await deliver(['SIGINT'], false);
		assert.strictEqual(received, 'SIGINT');
		assert.strictEqual(result.interrupted, true);
	});

	it('does not repeat a Ctrl-C that already reached the child', async () => {
		// The SIGTERM after it stops the child; had the SIGINT been forwarded, the child would record it first.
		const { result, received } = await deliver(['SIGINT', 'SIGTERM'], true);
		assert.strictEqual(received, 'SIGTERM');
		assert.strictEqual(result.interrupted, true);
	});

	it('forwards SIGTERM, and SIGHUP as SIGTERM, which tsx passes on', async () => {
		assert.strictEqual((await deliver(['SIGTERM'], false)).received, 'SIGTERM');
		const hangup = await deliver(['SIGHUP'], false);
		assert.strictEqual(hangup.received, 'SIGTERM');
		assert.strictEqual(hangup.result.interrupted, false);
	});
});

describe('per-app dev config', () => {
	it('detects next before vite, and runs the backend only without either', () => {
		assert.strictEqual(resolveDevConfig(fixtureApp({ devDependencies: { vite: '*', next: '*' } })).source, 'next');
		assert.deepStrictEqual(resolveDevConfig(fixtureApp({ devDependencies: { vite: '*' } })), {
			frontendCommand: 'npx vite --port 3100 --strictPort',
			frontendPort: 3100,
			source: 'vite',
		});
		assert.deepStrictEqual(resolveDevConfig(fixtureApp({})), { source: 'none' });
	});

	it('uses package.json "blocks.dev" instead of detection, and flags over both', () => {
		const root = fixtureApp({
			dependencies: { vite: '*' },
			blocks: { dev: { port: 3001, frontendCommand: 'npm run web', frontendPort: 5173 } },
		});
		assert.deepStrictEqual(resolveDevConfig(root), {
			port: 3001,
			host: undefined,
			frontendCommand: 'npm run web',
			frontendPort: 5173,
			source: 'package.json',
		});
		const flagged = resolveDevConfig(root, { port: '4000', 'no-frontend': true });
		assert.strictEqual(flagged.port, 4000);
		assert.strictEqual(flagged.frontendCommand, undefined);
	});

	it('starts a detected frontend on the resolved frontend port', () => {
		const vite = fixtureApp({ devDependencies: { vite: '*' } });
		const flagged = resolveDevConfig(vite, { 'frontend-port': '3200' });
		assert.strictEqual(flagged.frontendCommand, 'npx vite --port 3200 --strictPort');
		assert.strictEqual(flagged.frontendPort, 3200);
		assert.strictEqual(flagged.source, 'vite');
		// "blocks.dev" without a frontendCommand keeps detection on, and its frontendPort applies.
		const next = fixtureApp({
			devDependencies: { next: '*' },
			blocks: { dev: { port: 3001, frontendPort: 3300 } },
		});
		assert.deepStrictEqual(resolveDevConfig(next), {
			port: 3001,
			host: undefined,
			frontendCommand: 'npx next dev --webpack --hostname 127.0.0.1 --port 3300',
			frontendPort: 3300,
			source: 'next',
		});
		// A configured command is the app's own: the port flag never rewrites it.
		const own = fixtureApp({ devDependencies: { vite: '*' }, blocks: { dev: { frontendCommand: 'npm run web' } } });
		assert.strictEqual(resolveDevConfig(own, { 'frontend-port': '3200' }).frontendCommand, 'npm run web');
	});

	it('rejects invalid ports and conflicting flags as usage errors', () => {
		const root = fixtureApp({ blocks: { dev: { port: 'abc' } } });
		assert.throws(() => resolveDevConfig(root), /"blocks\.dev\.port" must be a port number/);
		assert.throws(
			() => resolveDevConfig(fixtureApp(), { 'no-frontend': true, 'frontend-command': 'x' }),
			/cannot be combined/,
		);
	});
});
