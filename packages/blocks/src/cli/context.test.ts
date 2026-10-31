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
import { createSpawnChild, findProjectRoot, isCi, logLevelFor, PromptInterrupted, promptLine } from './context.js';
import { CliError } from './errors.js';
import { parseArgv } from './parse.js';
import { runnerArgs, shellQuote } from './runners/launch.js';
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

	it('forwards nothing to a long-running child that a SIGTERM to the process group reached', async () => {
		const child = await start({ longRunning: true });
		// A supervisor, `timeout` or CI signals the whole process group: the CLI and the child.
		process.emit('SIGTERM');
		process.kill(child.pid, 'SIGTERM');
		const result = await child.running;
		await sleep(GRACE_MS * 2);
		assert.strictEqual(result.interrupted, false);
		assert.deepStrictEqual(child.received(), ['SIGTERM'], 'only the group signal itself');
	});

	it('forwards one SIGTERM after the grace period to a long-running child that SIGTERM and SIGHUP to the CLI did not reach', async () => {
		const child = await start({ longRunning: true });
		process.emit('SIGHUP');
		process.emit('SIGTERM');
		process.emit('SIGTERM');
		await sleep(GRACE_MS / 2);
		assert.deepStrictEqual(child.received(), []);
		const result = await child.running;
		assert.strictEqual(result.interrupted, false);
		assert.deepStrictEqual(child.received(), ['SIGTERM'], 'exactly one SIGTERM, which tsx passes on');
	});

	it('stops `blocks dev` and its frontend on a SIGTERM to its process group, leaving nothing running', { timeout: 60_000 }, async () => {
		const root = mkdtempSync(join(tmpdir(), 'blocks-cli-dev-sigterm-'));
		const [port, frontendPort] = await freePorts(2);
		// A frontend like `npx next dev`: a leader that exits on SIGTERM at once, and the server under it,
		// which closes its port at once but goes on (Next writes `.next`) for a moment, longer than the
		// bound on the check below, so a dev server that does not wait for all of it fails the test.
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
				blocks: { dev: { port, frontendCommand: 'node frontend.cjs', frontendPort } },
			}),
		);
		mkdirSync(join(root, 'aws-blocks'));
		writeFileSync(join(root, 'aws-blocks', 'index.ts'), 'export {};\n');
		const bin = fileURLToPath(new URL('./bin.js', import.meta.url));
		// Its own process group, so that the SIGTERM reaches the CLI, `tsx watch` and the dev server, as `timeout` sends it.
		const cli = spawn(process.execPath, [bin, 'dev'], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
			frontendGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(serverPid)], { encoding: 'utf-8' }).trim());
			assert.notStrictEqual(frontendGroup, cli.pid, 'the dev server runs its frontend in a process group of its own');
			process.kill(-(cli.pid ?? 0), 'SIGTERM');
			await exited;
			// The dev server waits until the group has drained, so it is gone by now. The bound allows only for
			// reaping a member that the dev server's fallback SIGKILL ended; it is shorter than the server's stop.
			for (const deadline = Date.now() + 250; isGroupRunning(frontendGroup) && Date.now() < deadline; ) await sleep(25);
			assert.strictEqual(isGroupRunning(frontendGroup), false, `the frontend outlived blocks dev\n${output}`);
			assert.doesNotMatch(output, /Force killing/);
		} finally {
			if (frontendGroup && isGroupRunning(frontendGroup)) process.kill(-frontendGroup, 'SIGKILL');
			if (cli.exitCode === null && cli.signalCode === null) process.kill(-(cli.pid ?? 0), 'SIGKILL');
			rmSync(root, { recursive: true, force: true, maxRetries: 5 });
		}
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
			assert.deepStrictEqual(JSON.parse(stdout), { code: 7, signal: null, interrupted: false });
			assert.strictEqual(readFileSync(join(dir, 'done'), 'utf-8'), 'SIGHUP');
		} finally {
			try {
				process.kill(-(cli.pid ?? 0), 'SIGKILL');
			} catch {
				// The group has exited.
			}
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
		writeFileSync(path, `\uFEFF${JSON.stringify({ devDependencies: { vite: '*' }, blocks: { dev: { port: 3001 } } })}`);
		const config = resolveDevConfig(root);
		assert.strictEqual(config.port, 3001);
		assert.strictEqual(config.source, 'vite');
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
		assert.strictEqual(resolveDevConfig(root, { 'frontend-command': 'npm run web' }).frontendCommand, 'npm run web');
		assert.throws(
			() => resolveDevConfig(fixtureApp({ blocks: { dev: { frontend: false, frontendCommand: 'npm run web' } } })),
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
});
