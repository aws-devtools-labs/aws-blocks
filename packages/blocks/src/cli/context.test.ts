// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolveDevConfig } from './config.js';
import {
	childPids,
	createSpawnChild,
	findProjectRoot,
	isCi,
	logLevelFor,
	PromptInterrupted,
	promptLine,
} from './context.js';
import { CliError } from './errors.js';
import { parseArgv } from './parse.js';
import { DEV_FAILURE_FILE_ENV, DEV_OPTIONS_ENV, DEV_STATE, runnerArgs, runnerPath, shellQuote } from './runners/launch.js';
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
		const file = await runCli(['-C', join(root, 'package.json'), 'generate', 'spec'], { cwd: elsewhere });
		assert.strictEqual(file.code, 2);
		assert.match(file.stderr, /^Error: .*package\.json is not a directory \(from -C\/--cwd\)\.\n/);
		assert.deepStrictEqual(file.spawned, []);
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

	it('accepts only an AWS Region code in --region, and in AWS_REGION for a command that uses AWS (exit 2)', async () => {
		const cwd = fixtureApp();
		const good = ['us-east-1', 'eu-central-2', 'us-gov-west-1', 'cn-north-1', 'ap-southeast-4', 'eusc-de-east-1'];
		for (const region of good) {
			const run = await runCli(['--region', region, 'dev'], { cwd });
			assert.strictEqual(run.code, 0, `${region}: ${run.stderr}`);
			const env = await runCli(['deploy'], { cwd, env: { AWS_REGION: region } });
			assert.strictEqual(env.code, 0, `${region}: ${env.stderr}`);
		}
		for (const region of ['us-east-1; rm -rf ~', 'US-EAST-1', 'useast1', 'us-east', '../x', 'us-east-1\n']) {
			const flag = await runCli(['--region', region, 'dev'], { cwd });
			assert.strictEqual(flag.code, 2, JSON.stringify(region));
			assert.match(flag.stderr, /option --region must be an AWS Region code/);
			assert.strictEqual(flag.spawned.length, 0);
			const env = await runCli(['deploy'], { cwd, env: { AWS_REGION: region } });
			assert.strictEqual(env.code, 2, JSON.stringify(region));
			assert.match(env.stderr, /AWS_REGION must be an AWS Region code/);
			assert.strictEqual(env.spawned.length, 0);
		}
		// A local command ignores a stray AWS_REGION; --region replaces it; help never needs a Region.
		assert.strictEqual((await runCli(['dev'], { cwd, env: { AWS_REGION: 'bad' } })).code, 0);
		assert.strictEqual(
			(await runCli(['--region', 'us-west-2', 'deploy'], { cwd, env: { AWS_REGION: 'bad' } })).code,
			0,
		);
		assert.strictEqual((await runCli(['deploy', '--help'], { cwd, env: { AWS_REGION: 'bad' } })).code, 0);
		assert.strictEqual((await runCli(['--region', 'nope', 'help'], { cwd })).code, 0);
		assert.strictEqual((await runCli(['--region', 'nope', 'help', 'deploy'], { cwd })).code, 0);
	});
});

/** Ports that nothing listened on a moment ago. */
async function freePorts(count: number): Promise<number[]> {
	const servers = Array.from({ length: count }, () => createServer());
	const ports = await Promise.all(
		servers.map(async (server) => {
			server.listen(0, '127.0.0.1');
			await once(server, 'listening');
			const address = server.address();
			assert.ok(address !== null && typeof address === 'object');
			return address.port;
		}),
	);
	await Promise.all(servers.map((server) => once(server.close(), 'close')));
	return ports;
}

async function isListening(port: number): Promise<boolean> {
	const socket = connect(port, '127.0.0.1');
	try {
		await once(socket, 'connect');
		return true;
	} catch {
		return false;
	} finally {
		socket.destroy();
	}
}

/** Whether any process of the group `pgid` is running, or exited and not yet reaped. */
function isGroupRunning(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

describe('the children of a watcher', () => {
	it('runs no ps on Windows, where a signal is TerminateProcess and runs no runner cleanup', () => {
		let listed = 0;
		const list = () => {
			listed++;
			return '  41  40\n  42   1\n';
		};
		assert.deepStrictEqual(childPids(40, 'win32', list), []);
		assert.strictEqual(listed, 0);
		assert.deepStrictEqual(childPids(40, 'linux', list), [41]);
		assert.deepStrictEqual(
			childPids(40, 'linux', () => {
				throw new Error('ps: unknown option -- A');
			}),
			[],
		);
	});
});

// On Windows, child.kill() ends the child without running its handlers.
// These tests signal a real child process, so they run on the real clock: fake
// timers cannot advance it. The grace period is shortened to keep them quick, and
// the waits check that a signal did not arrive, which has no event to await.
describe('signals sent to the CLI while a child runs', { skip: process.platform === 'win32' }, () => {
	const GRACE_MS = 300;

	/**
	 * Start a fake child that appends each signal it receives to a log, and exits
	 * 50 ms after a SIGTERM; with `exitOnSigint`, after a SIGINT too, as the dev
	 * server and the sandbox clean up after a Ctrl-C. SIGINT is otherwise ignored.
	 */
	async function start(options: { exitOnSigint?: boolean; longRunning?: boolean } = {}) {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-cli-signals-'));
		const log = join(dir, 'signals.log');
		const ready = join(dir, 'ready');
		const script = `
const { appendFileSync, writeFileSync } = require('node:fs');
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => {
		appendFileSync(${JSON.stringify(log)}, signal + '\\n');
		if (signal === 'SIGTERM' || (signal === 'SIGINT' && ${options.exitOnSigint === true})) {
			setTimeout(() => process.exit(0), 50);
		}
	});
}
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`;
		const spawn = createSpawnChild({ graceMs: GRACE_MS });
		const running = spawn({
			command: process.execPath,
			args: ['-e', script],
			cwd: dir,
			env: process.env,
			longRunning: options.longRunning,
		});
		// A real child process: poll for the file it writes once its handlers are installed.
		while (!existsSync(ready) || readFileSync(ready, 'utf-8') === '') await sleep(10);
		const received = () => (existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : []);
		return { running, pid: Number(readFileSync(ready, 'utf-8')), received };
	}

	it('forwards one SIGINT after the grace period to a child that is still running', async () => {
		const child = await start();
		// A SIGINT sent to the CLI's PID alone, repeated: nothing reaches the child before the grace period.
		process.emit('SIGINT');
		process.emit('SIGINT');
		await sleep(GRACE_MS / 2);
		assert.deepStrictEqual(child.received(), []);
		while (child.received().length === 0) await sleep(10);
		await sleep(GRACE_MS * 2);
		process.emit('SIGINT');
		await sleep(GRACE_MS * 2);
		assert.deepStrictEqual(child.received(), ['SIGINT'], 'exactly one SIGINT is forwarded');
		process.emit('SIGTERM');
		const result = await child.running;
		assert.strictEqual(result.interrupted, true);
		assert.deepStrictEqual(child.received(), ['SIGINT', 'SIGTERM']);
	});

	it('forwards nothing to a child that the Ctrl-C reached, which exits within the grace period', async () => {
		const child = await start({ exitOnSigint: true });
		// A Ctrl-C in the terminal signals the whole process group: the CLI and the child.
		process.emit('SIGINT');
		process.kill(child.pid, 'SIGINT');
		const result = await child.running;
		await sleep(GRACE_MS * 2);
		assert.strictEqual(result.interrupted, true);
		assert.deepStrictEqual(child.received(), ['SIGINT'], 'only the Ctrl-C itself');
	});

	it('forwards SIGTERM at once to a child that is not long-running, as core deploy coalesces it', async () => {
		const term = await start();
		process.emit('SIGTERM');
		assert.strictEqual((await term.running).interrupted, false);
		assert.deepStrictEqual(term.received(), ['SIGTERM']);
	});

	it('sends one SIGTERM at once to a long-running child that a SIGTERM to the process group also reached', async () => {
		const child = await start({ longRunning: true });
		// A supervisor, `timeout` or CI signals the whole process group: the CLI and the child.
		// The sandbox runner's cleanup is idempotent, so the duplicate is harmless.
		const started = Date.now();
		process.emit('SIGTERM');
		process.kill(child.pid, 'SIGTERM');
		const result = await child.running;
		assert.ok(Date.now() - started < GRACE_MS, 'at once, before the grace period');
		await sleep(GRACE_MS * 2);
		assert.strictEqual(result.interrupted, false);
		// The group signal and the forward can arrive together, and a pending signal is delivered once.
		const received = child.received();
		assert.ok(
			received.length >= 1 && received.length <= 2 && received.every((signal) => signal === 'SIGTERM'),
			`the group signal and at most one forward: ${received.join(', ')}`,
		);
	});

	it('forwards one SIGTERM at once to a long-running child that SIGTERM and SIGHUP to the CLI did not reach', async () => {
		const child = await start({ longRunning: true });
		const started = Date.now();
		process.emit('SIGHUP');
		process.emit('SIGTERM');
		process.emit('SIGTERM');
		const result = await child.running;
		assert.ok(Date.now() - started < GRACE_MS, 'before the grace period');
		assert.strictEqual(result.interrupted, false);
		assert.deepStrictEqual(child.received(), ['SIGTERM'], 'exactly one SIGTERM');
	});

	/**
	 * Start `blocks dev` in a process group of its own, with a frontend like `npx next dev`, send it
	 * `signal` (to the group, or to the CLI's pid alone), and check that it and its frontend stop
	 * within `withinMs`, leaving nothing running. Returns the CLI's exit code.
	 */
	async function stopDev(target: 'group' | 'pid', signal: NodeJS.Signals, withinMs: number): Promise<number | null> {
		const root = mkdtempSync(join(tmpdir(), 'blocks-cli-dev-sigterm-'));
		const [port, frontendPort] = await freePorts(2);
		// A leader that exits on SIGTERM at once, and the server under it, which closes its port at once
		// but goes on (Next writes `.next`) for a moment, longer than the bound on the check below, so a
		// dev server that does not wait for all of it fails the test.
		writeFileSync(
			join(root, 'frontend.cjs'),
			[
				"const { spawn } = require('node:child_process');",
				"const { writeFileSync } = require('node:fs');",
				`const server = spawn(process.execPath, ['-e', ${JSON.stringify(
					[
						"const http = require('node:http');",
						`const listener = http.createServer((req, res) => res.end('ok')).listen(${frontendPort}, '127.0.0.1');`,
						"process.on('SIGTERM', () => { listener.close(); setTimeout(() => process.exit(0), 500); });",
					].join('\n'),
				)}], { stdio: 'inherit' });`,
				"writeFileSync('frontend.pids', process.pid + ' ' + server.pid);",
				"process.on('SIGTERM', () => process.exit(0));",
			].join('\n'),
		);
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'dev-sigterm-app',
				type: 'module',
				blocks: { dev: { port, frontendCommand: `node frontend.cjs ${frontendPort}`, frontendPort } },
			}),
		);
		mkdirSync(join(root, 'aws-blocks'));
		writeFileSync(join(root, 'aws-blocks', 'index.ts'), 'export {};\n');
		const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
		const cli = spawn(process.execPath, [bin, 'dev'], {
			cwd: root,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		cli.stdout.on('data', (chunk) => (output += chunk));
		cli.stderr.on('data', (chunk) => (output += chunk));
		const exited = once(cli, 'close');
		const pidsFile = join(root, 'frontend.pids');
		let frontendGroup = 0;
		try {
			while (!(existsSync(pidsFile) && (await isListening(port)) && (await isListening(frontendPort)))) {
				assert.strictEqual(cli.exitCode, null, output);
				await sleep(100);
			}
			const serverPid = Number(readFileSync(pidsFile, 'utf-8').split(' ')[1]);
			frontendGroup = Number(
				execFileSync('ps', ['-o', 'pgid=', '-p', String(serverPid)], { encoding: 'utf-8' }).trim(),
			);
			assert.notStrictEqual(
				frontendGroup,
				cli.pid,
				'the dev server runs its frontend in a process group of its own',
			);
			const started = Date.now();
			process.kill(target === 'group' ? -(cli.pid ?? 0) : (cli.pid ?? 0), signal);
			const [code] = await exited;
			const took = Date.now() - started;
			// The dev server waits until the group has drained, so it is gone by now. The bound allows only for
			// reaping a member that the dev server's fallback SIGKILL ended; it is shorter than the server's stop.
			for (const deadline = Date.now() + 250; isGroupRunning(frontendGroup) && Date.now() < deadline; )
				await sleep(25);
			assert.strictEqual(isGroupRunning(frontendGroup), false, `the frontend outlived blocks dev\n${output}`);
			assert.strictEqual(isGroupRunning(cli.pid ?? 0), false, `a process of blocks dev outlived it\n${output}`);
			assert.doesNotMatch(output, /Force killing|Killing process/);
			assert.ok(took <= withinMs, `stopped after ${took} ms, not within ${withinMs} ms\n${output}`);
			return code as number | null;
		} finally {
			if (frontendGroup && isGroupRunning(frontendGroup)) process.kill(-frontendGroup, 'SIGKILL');
			if (isGroupRunning(cli.pid ?? 0)) process.kill(-(cli.pid ?? 0), 'SIGKILL');
			rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
	}

	it('stops `blocks dev` and its frontend on a SIGTERM to its process group, leaving nothing running', {
		timeout: 60_000,
	}, async () => {
		// As `timeout`, a supervisor or CI sends it: the CLI, `tsx watch` and the dev server all get it.
		assert.strictEqual(await stopDev('group', 'SIGTERM', 3000), 0);
	});

	it('stops `blocks dev` and its frontend within 1.5 s on a SIGTERM or SIGHUP to its pid alone', {
		timeout: 60_000,
	}, async () => {
		// As `kill <pid>`, an IDE's stop button or a harness that kills a background job sends it.
		// A stop the CLI requested is a success, whether `tsx watch` exits 0 or, with no runner left, 143.
		assert.strictEqual(await stopDev('pid', 'SIGTERM', 1500), 0);
		assert.strictEqual(await stopDev('pid', 'SIGHUP', 1500), 0);
	});

	it('otherwise ignores SIGHUP and does not forward it, as core defers it during a deploy', async () => {
		const listeners = process.listenerCount('SIGHUP');
		const child = await start();
		// A listener keeps the default action, which would end the CLI, from applying.
		assert.strictEqual(process.listenerCount('SIGHUP'), listeners + 1);
		process.emit('SIGHUP');
		process.emit('SIGHUP');
		await sleep(GRACE_MS);
		assert.deepStrictEqual(child.received(), []);
		process.emit('SIGTERM');
		await child.running;
		assert.deepStrictEqual(child.received(), ['SIGTERM']);
		assert.strictEqual(process.listenerCount('SIGHUP'), listeners, 'the listener is removed once the child exits');
	});

	it('outlives a hangup of its process group, and reports the exit code of a runner that defers it', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-cli-hangup-'));
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'hangup-app', type: 'module' }));
		// TypeScript, so it loads only with the tsx loader. It defers a SIGHUP, as core's deploy does, and keeps
		// running for a moment after it (a real process: the hangup is an OS signal to its process group).
		writeFileSync(
			join(dir, 'runner.ts'),
			[
				"import { writeFileSync } from 'node:fs';",
				'const seen: string[] = [];',
				"process.on('SIGHUP', () => {",
				"\tseen.push('SIGHUP');",
				"\tsetTimeout(() => { writeFileSync('done', seen.join()); process.exit(7); }, 500);",
				'});',
				"writeFileSync('ready', String(process.pid));",
				'setInterval(() => {}, 1000);',
			].join('\n'),
		);
		// The CLI's side: the runner command line and the spawn that the lifecycle commands use.
		const launcher = [
			`import { createSpawnChild } from ${JSON.stringify(new URL('./context.js', import.meta.url).href)};`,
			`import { runnerArgs } from ${JSON.stringify(new URL('./runners/launch.js', import.meta.url).href)};`,
			"const args = runnerArgs(process.cwd(), 'runner.ts');",
			'const result = await createSpawnChild()({ command: process.execPath, args, cwd: process.cwd(), env: process.env });',
			'process.stdout.write(JSON.stringify(result));',
			'process.exitCode = result.code ?? 1;',
		].join('\n');
		assert.ok(!runnerArgs(dir, 'runner.ts').some((arg) => /cli\.mjs$/.test(arg)), 'no tsx process in between');
		// Its own process group, so that the hangup reaches the launcher and the runner, as a closed terminal does.
		const cli = spawn(process.execPath, ['--input-type=module', '-e', launcher], {
			cwd: dir,
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		cli.stdout.on('data', (chunk) => (stdout += chunk));
		cli.stderr.on('data', (chunk) => (stderr += chunk));
		const exited = once(cli, 'close');
		try {
			const ready = join(dir, 'ready');
			while (!existsSync(ready) || readFileSync(ready, 'utf-8') === '') await sleep(10);
			process.kill(-(cli.pid ?? 0), 'SIGHUP');
			assert.strictEqual((await exited)[0], 7, stderr);
			assert.deepStrictEqual(JSON.parse(stdout), {
				code: 7,
				signal: null,
				interrupted: false,
				stopped: false,
				terminated: false,
			});
			assert.strictEqual(readFileSync(join(dir, 'done'), 'utf-8'), 'SIGHUP');
		} finally {
			try {
				process.kill(-(cli.pid ?? 0), 'SIGKILL');
			} catch {
				// The group has exited.
			}
		}
	});

	/** A backend-only app on a free port, for a real `blocks dev`; returns its root and port. */
	async function devApp(): Promise<{ root: string; port: number }> {
		const [port] = await freePorts(1);
		const root = fixtureApp({ name: 'dev-app', blocks: { dev: { port, frontend: false } } });
		return { root, port };
	}

	/** `promise`, or a rejection after `ms`, so that a process that hangs fails the test rather than outliving it. */
	function within<T>(promise: Promise<T>, ms: number, what: () => string): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`still running after ${ms} ms\n${what()}`)), ms);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	/** Wait until `port` listens, failing after 30 s. */
	async function listening(port: number, what: () => string): Promise<void> {
		for (const deadline = Date.now() + 30_000; !(await isListening(port)); await sleep(100)) {
			assert.ok(Date.now() < deadline, `nothing listens on :${port}\n${what()}`);
		}
	}

	/** The pids whose parent is `pid`. */
	function childrenOf(pid: number): number[] {
		return execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8' })
			.split('\n')
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter(([, parent]) => parent === pid)
			.map(([child]) => child);
	}

	/** Start `blocks dev` in `root` in a process group of its own. */
	function startCli(root: string) {
		const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
		const cli = spawn(process.execPath, [bin, 'dev'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		cli.stdout.on('data', (chunk) => (output += chunk));
		cli.stderr.on('data', (chunk) => (output += chunk));
		const exited = once(cli, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
		const kill = () => {
			if (isGroupRunning(cli.pid ?? 0)) process.kill(-(cli.pid ?? 0), 'SIGKILL');
		};
		return { cli, exited, output: () => output, kill };
	}

	it('exits 1 when its dev server fails to start, rather than waiting for a file change or exiting 0', {
		timeout: 60_000,
	}, async () => {
		const { root } = await devApp();
		// Core fails before it loads the backend: tsx watch has no app file to wait on.
		mkdirSync(join(root, '.env.local'));
		const dev = startCli(root);
		try {
			const [code] = await within(dev.exited, 20_000, dev.output);
			assert.strictEqual(code, 1, dev.output());
			assert.match(dev.output(), /❌ .*\.env\.local/);
			// The runner printed the reason; the CLI does not repeat it.
			assert.doesNotMatch(dev.output(), /Error:/);
			assert.strictEqual(isGroupRunning(dev.cli.pid ?? 0), false, dev.output());
		} finally {
			dev.kill();
		}
	});

	it('ends on a Ctrl-C after its runner was killed, which leaves tsx watch waiting forever', {
		timeout: 60_000,
	}, async () => {
		const { root, port } = await devApp();
		const dev = startCli(root);
		try {
			await listening(port, dev.output);
			const [watcher] = childrenOf(dev.cli.pid ?? 0);
			const [runner] = childrenOf(watcher);
			assert.ok(watcher && runner, dev.output());
			// The OOM killer, or `kill -9` of the runner.
			process.kill(runner, 'SIGKILL');
			// Until tsx watch has reaped it, and seen it exit: a Ctrl-C before that would find it running.
			while (childrenOf(watcher).includes(runner)) await sleep(25);
			await sleep(250);
			const started = Date.now();
			process.kill(-(dev.cli.pid ?? 0), 'SIGINT');
			const [code] = await within(dev.exited, 10_000, dev.output);
			assert.strictEqual(code, 130, dev.output());
			assert.ok(Date.now() - started < 5000, `exited ${Date.now() - started} ms after the Ctrl-C`);
			assert.strictEqual(isGroupRunning(dev.cli.pid ?? 0), false, dev.output());
		} finally {
			dev.kill();
		}
	});

	it('records how its dev server runner ended, for blocks dev', { timeout: 60_000 }, async () => {
		const { root, port } = await devApp();
		const file = join(mkdtempSync(join(tmpdir(), 'blocks-dev-state-')), 'failure');
		const run = () => {
			const watcher = spawn(process.execPath, runnerArgs(root, runnerPath('dev-server'), { watch: true }), {
				cwd: root,
				detached: true,
				stdio: 'ignore',
				env: {
					...process.env,
					[DEV_OPTIONS_ENV]: JSON.stringify({ backendPath: join(root, 'aws-blocks', 'index.ts'), port }),
					[DEV_FAILURE_FILE_ENV]: file,
				},
			});
			return { watcher, exited: once(watcher, 'close') };
		};
		const first = run();
		try {
			await listening(port, () => '');
			assert.strictEqual(readFileSync(file, 'utf-8'), DEV_STATE.running);
			// `blocks dev stop`: a SIGTERM to tsx watch, which relays it.
			process.kill(first.watcher.pid ?? 0, 'SIGTERM');
			await within(first.exited, 10_000, () => 'tsx watch');
			assert.strictEqual(readFileSync(file, 'utf-8'), DEV_STATE.stopped);
		} finally {
			if (isGroupRunning(first.watcher.pid ?? 0)) process.kill(-(first.watcher.pid ?? 0), 'SIGKILL');
		}
		const second = run();
		try {
			await listening(port, () => '');
			const [runner] = childrenOf(second.watcher.pid ?? 0);
			process.kill(runner, 'SIGKILL');
			while (childrenOf(second.watcher.pid ?? 0).includes(runner)) await sleep(25);
			// Nothing ran in the runner: `blocks dev` reads `running` as a runner that a signal killed.
			assert.strictEqual(readFileSync(file, 'utf-8'), DEV_STATE.running);
		} finally {
			if (isGroupRunning(second.watcher.pid ?? 0)) process.kill(-(second.watcher.pid ?? 0), 'SIGKILL');
		}
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

	it('reads a package.json that starts with a UTF-8 byte order mark, as npm does', () => {
		const root = fixtureApp({});
		const path = join(root, 'package.json');
		writeFileSync(
			path,
			`\uFEFF${JSON.stringify({ devDependencies: { vite: '*' }, blocks: { dev: { port: 3001 } } })}`,
		);
		const config = resolveDevConfig(root);
		assert.strictEqual(config.port, 3001);
		assert.strictEqual(config.source, 'vite');
	});

	it('refuses a package.json that is not a JSON object with one clear error (exit 1)', async () => {
		const root = fixtureApp({});
		const path = join(root, 'package.json');
		for (const [content, kind] of [
			['null', 'null'],
			['[]', 'an array'],
			['"x"', 'a string'],
			['42', 'a number'],
		]) {
			writeFileSync(path, content);
			for (const argv of [['dev'], ['dev', 'stop'], ['generate', 'client'], ['sandbox']]) {
				const run = await runCli(argv, { cwd: root, env: { AWS_REGION: 'us-east-1' } });
				assert.strictEqual(run.code, 1, `${content} ${argv.join(' ')}: ${run.stderr}`);
				assert.strictEqual(
					run.stderr.split('\n')[0],
					`Error: ${path} must be a JSON object, not ${kind}.`,
					`${content} ${argv.join(' ')}`,
				);
				assert.deepStrictEqual(run.spawned, [], `${content} ${argv.join(' ')}`);
			}
		}
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

	it('runs the backend only with "frontend": false, even with vite or next installed', () => {
		const root = fixtureApp({
			dependencies: { vite: '*', next: '*' },
			blocks: { dev: { port: 3001, frontend: false } },
		});
		assert.deepStrictEqual(resolveDevConfig(root), {
			port: 3001,
			host: undefined,
			frontendCommand: undefined,
			frontendPort: undefined,
			source: 'package.json',
		});
		// A frontend command flag still starts one.
		assert.strictEqual(
			resolveDevConfig(root, { 'frontend-command': 'npm run web' }).frontendCommand,
			'npm run web',
		);
		assert.throws(
			() =>
				resolveDevConfig(fixtureApp({ blocks: { dev: { frontend: false, frontendCommand: 'npm run web' } } })),
			/"blocks\.dev\.frontend": false cannot be combined/,
		);
		assert.throws(
			() => resolveDevConfig(fixtureApp({ blocks: { dev: { frontend: true } } })),
			/"blocks\.dev\.frontend" can only be false/,
		);
	});

	it('rejects invalid ports and conflicting flags as usage errors', () => {
		const root = fixtureApp({ blocks: { dev: { port: 'abc' } } });
		assert.throws(() => resolveDevConfig(root), /"blocks\.dev\.port" must be a port number/);
		assert.throws(
			() => resolveDevConfig(fixtureApp(), { 'no-frontend': true, 'frontend-command': 'x' }),
			/cannot be combined/,
		);
	});

	it('accepts only decimal port numbers from 1 to 65535 in --port and --frontend-port (exit 2)', async () => {
		const cwd = fixtureApp();
		for (const value of ['1e3', '0x10', '0b1010000001011010', ' 41082 ', '-1', '0', '65536', '1.5']) {
			for (const flag of ['--port', '--frontend-port']) {
				const run = await runCli(['dev', flag, value], { cwd });
				assert.strictEqual(run.code, 2, `${flag} ${value}: ${run.stderr}`);
				assert.ok(
					run.stderr.includes(
						`option ${flag} must be a port number from 1 to 65535, not ${JSON.stringify(value)}.`,
					),
					run.stderr,
				);
				assert.strictEqual(run.spawned.length, 0);
			}
		}
		assert.strictEqual(resolveDevConfig(cwd, { port: '4000', 'frontend-port': '65535' }).port, 4000);
		assert.throws(
			() => resolveDevConfig(fixtureApp({ blocks: { dev: { port: '1e3' } } })),
			/"blocks\.dev\.port" must be a port number/,
		);
	});

	it('warns when a frontendCommand you set does not contain the frontend port', async () => {
		const warning =
			/^Warning: the frontend command "npx vite --port 3100 --strictPort" does not contain the frontend port 41079,/m;
		const hardCoded = fixtureApp({
			dependencies: { vite: '*' },
			blocks: { dev: { frontendCommand: 'npx vite --port 3100 --strictPort', frontendPort: 3100 } },
		});
		assert.match((await runCli(['dev', '--frontend-port', '41079'], { cwd: hardCoded })).stderr, warning);
		const flag = await runCli(
			['dev', '--frontend-command', 'npx vite --port 3100 --strictPort', '--frontend-port', '41079'],
			{
				cwd: fixtureApp(),
			},
		);
		assert.match(flag.stderr, warning);
		// The port in the command, or a detected frontend: nothing to warn about.
		for (const [cwd, argv] of [
			[hardCoded, ['dev']],
			[fixtureApp(), ['dev', '--frontend-port', '41079']],
			[
				fixtureApp({ blocks: { dev: { frontendCommand: 'node web.js', frontendPort: 3100 } } }),
				['dev', '--no-frontend'],
			],
		] as const) {
			assert.doesNotMatch((await runCli([...argv], { cwd })).stderr, /frontend command/, argv.join(' '));
		}
		assert.match(
			(await runCli(['dev'], { cwd: fixtureApp({ blocks: { dev: { frontendCommand: 'node web.js' } } }) }))
				.stderr,
			/"node web\.js" does not contain the frontend port 3100,/,
		);
	});
});
