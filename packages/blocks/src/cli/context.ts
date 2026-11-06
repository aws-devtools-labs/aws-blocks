// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run context of one `cdk-blocks` invocation: project-root detection, the
 * environment for child processes (`--profile`, `--region`, `BLOCKS_LOG_LEVEL`),
 * the interactive/CI decision and the injectable process seams.
 */

import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import type * as CoreScriptsModule from '@aws-blocks/core/scripts';
import { loadCoreScripts } from './core-load.js';
import { CliError, UsageError } from './errors.js';
import { Output, type OutputStream } from './output.js';
import type { Globals, ParsedInvocation } from './parse.js';

/** The `@aws-blocks/core/scripts` module. Tests replace parts of it. */
export type CoreScripts = typeof CoreScriptsModule;

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** Send the child's stdout to stderr, so that stdout carries only the CLI's JSON document. */
	stdoutToStderr?: boolean;
	/**
	 * The child runs until it is stopped: `cdk-blocks dev` and `cdk-blocks sandbox` in
	 * watch mode. The CLI stops it at once on a SIGTERM or SIGHUP (a supervisor,
	 * `timeout`, a closed terminal, `kill <pid>`), whether or not the signal also
	 * reached the child's process group: it sends one SIGTERM, which the
	 * sandbox runner's idempotent cleanup takes twice without harm. For a
	 * {@link SpawnSpec.watcher} child the CLI signals the runner under it instead.
	 *
	 * Otherwise the CLI forwards a SIGTERM at once, and ignores SIGHUP, does not
	 * forward it and waits for the child. Core's production deploy defers SIGHUP
	 * and runs to its end, so after a closed terminal the CLI still reports its
	 * result; a runner that does not defer it ends with the hangup, and the CLI
	 * reports that.
	 */
	longRunning?: boolean;
	/**
	 * The child is `tsx watch` (`cdk-blocks dev`). A second SIGTERM makes it SIGKILL
	 * its runner, which then leaves the frontend running, so the CLI never sends
	 * it one while the runner lives: it SIGTERMs the runner, which the group
	 * signal may have reached already (the dev server's cleanup is idempotent
	 * and keeps its listeners until it exits), and SIGTERMs `tsx watch` once the
	 * runner is gone. With no runner left, `tsx watch` exits 143 at once, except
	 * after a runner that a signal ended (one that a SIGTERM reached before it
	 * could handle signals, a `kill -9`, the OOM killer): `tsx watch` then waits for
	 * it forever, on a SIGTERM and on a Ctrl-C alike, so the CLI SIGKILLs it after
	 * {@link WATCHER_EXIT_MS}.
	 */
	watcher?: boolean;
}

export interface ChildResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** The CLI received SIGINT while the child ran. */
	interrupted: boolean;
	/** The CLI stopped a long-running child on a SIGTERM or SIGHUP: the stop was requested. */
	stopped?: boolean;
	/** The CLI received SIGTERM while a child that is not long-running ran, and forwarded it. */
	terminated?: boolean;
}

/** Run a child process to completion. */
export type SpawnFn = (spec: SpawnSpec) => Promise<ChildResult>;

/** The process seams of the CLI. `bin.ts` passes the real ones; tests pass fakes. */
export interface CliDeps {
	stdout: OutputStream;
	stderr: OutputStream;
	stdinIsTTY: boolean;
	/**
	 * The environment. The CLI sets AWS_PROFILE, AWS_REGION and BLOCKS_LOG_LEVEL on it
	 * for the run, and `cdk-blocks whoami` loads `.env.production` into it, as core's deploy does.
	 */
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Ask a question on stderr and read one line from stdin; rejects with {@link PromptInterrupted} on Ctrl-C. */
	prompt(question: string): Promise<string>;
	spawn: SpawnFn;
	/** Change the working directory, for the core functions that run in this process. */
	chdir(dir: string): void;
	/**
	 * The process argv, which the core functions that run in this process read
	 * `--telemetry-file` from. The CLI makes that path absolute in place.
	 */
	argv: string[];
	/**
	 * Load `@aws-blocks/core/scripts`. A seam rather than a static import, so that
	 * `cdk-blocks --help` and usage errors do not load core, and tests can replace it.
	 */
	core(): Promise<CoreScripts>;
}

export type LogLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

const LOG_LEVELS: readonly LogLevel[] = ['quiet', 'normal', 'verbose', 'debug'];

/** The log level from the flags; `--debug` wins over `--verbose`, which wins over `--quiet`. */
export function logLevelFor(globals: Globals, env: NodeJS.ProcessEnv): LogLevel {
	if (globals.debug) return 'debug';
	if (globals.verbose) return 'verbose';
	if (globals.quiet) return 'quiet';
	const inherited = env.BLOCKS_LOG_LEVEL as LogLevel | undefined;
	return inherited && LOG_LEVELS.includes(inherited) ? inherited : 'normal';
}

/** True when `CI` is set to anything but `false` or `0`. */
export function isCi(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0';
}

/** An AWS Region code: `us-east-1`, `eu-central-2`, `us-gov-west-1`, `cn-north-1`, `eusc-de-east-1`. */
export const REGION_PATTERN = /^[a-z]{2,}(-[a-z]+)+-\d+$/;

/** The environment variables that hold access keys, which CDK reads before AWS_PROFILE. */
const ACCESS_KEY_VARIABLES = [
	'AWS_ACCESS_KEY_ID',
	'AWS_SECRET_ACCESS_KEY',
	'AWS_SESSION_TOKEN',
	'AMAZON_ACCESS_KEY_ID',
	'AMAZON_SECRET_ACCESS_KEY',
	'AMAZON_SESSION_TOKEN',
] as const;

/**
 * The project root: the nearest directory at or above `start` that holds both a
 * `package.json` and an `aws-blocks/` directory.
 */
export function findProjectRoot(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		const appDir = join(dir, 'aws-blocks');
		if (existsSync(join(dir, 'package.json')) && existsSync(appDir) && statSync(appDir).isDirectory()) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The env file that core's deploy (`production`) and sandbox (`sandbox`) load from the project root. */
export const STAGE_ENV_FILES = { production: '.env.production', sandbox: '.env.local' } as const;

/** The variables that the stage's env file sets, or `undefined` when the project has no such file. */
export function readStageEnvFile(
	root: string,
	stage: keyof typeof STAGE_ENV_FILES,
): Record<string, string | undefined> | undefined {
	const file = join(root, STAGE_ENV_FILES[stage]);
	return existsSync(file) ? parseEnv(readFileSync(file, 'utf-8')) : undefined;
}

/**
 * Apply the stage's env file to `env` in place, as core applies it to
 * `process.env` (`loadProductionEnv`, `loadEnvFile`): a variable already set,
 * even to an empty string, keeps its value.
 */
export function applyStageEnv(env: NodeJS.ProcessEnv, root: string, stage: keyof typeof STAGE_ENV_FILES): void {
	for (const [key, value] of Object.entries(readStageEnvFile(root, stage) ?? {})) {
		if (!(key in env)) env[key] = value;
	}
}

/** A copy of `env` with the stage's env file applied by {@link applyStageEnv}. `env` is not changed. */
export function stageEnv(env: NodeJS.ProcessEnv, root: string, stage: keyof typeof STAGE_ENV_FILES): NodeJS.ProcessEnv {
	const copy = { ...env };
	applyStageEnv(copy, root, stage);
	return copy;
}

/** The installed `@aws-blocks/blocks` version. */
export function blocksVersion(): string {
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as {
		version: string;
	};
	return pkg.version;
}

export class Context {
	readonly globals: Globals;
	readonly out: Output;
	readonly env: NodeJS.ProcessEnv;
	/** The directory the command runs as if started in (`-C`, or the working directory). */
	readonly startDir: string;
	readonly logLevel: LogLevel;
	/** Prompts are allowed: stdin is a TTY, `--no-input` is absent and `CI` is not set. */
	readonly interactive: boolean;
	private root: string | undefined | null = null;

	constructor(
		readonly parsed: ParsedInvocation,
		readonly deps: CliDeps,
	) {
		this.globals = parsed.globals;
		this.env = deps.env;
		this.startDir = resolve(deps.cwd, this.globals.cwd ?? '.');
		if (this.globals.cwd !== undefined && !statSync(this.startDir, { throwIfNoEntry: false })?.isDirectory()) {
			throw new UsageError(
				existsSync(this.startDir)
					? `${this.startDir} is not a directory (from -C/--cwd).`
					: `directory ${this.startDir} does not exist (from -C/--cwd).`,
			);
		}
		this.logLevel = logLevelFor(this.globals, this.env);
		this.out = new Output(
			deps.stdout,
			deps.stderr,
			this.globals.output,
			this.logLevel === 'quiet',
			this.env,
			// --version prints only the version; it does not query it.
			parsed.command && !this.globals.version ? this.globals.query : undefined,
		);
		this.interactive = !this.globals.noInput && deps.stdinIsTTY && !isCi(this.env);

		if (this.globals.profile) {
			this.env.AWS_PROFILE = this.globals.profile;
			// CDK and the AWS SDK use access keys from the environment before AWS_PROFILE, so an explicit
			// --profile would lose to exported keys. Set to empty, not deleted, so that a stage env file
			// (`.env.production`, `.env.local`), which never overrides a set variable, cannot bring them back.
			const keys = ACCESS_KEY_VARIABLES.filter((name) => this.env[name]);
			for (const name of ACCESS_KEY_VARIABLES) this.env[name] = '';
			if (keys.length > 0 && parsed.command?.aws) {
				this.out.warn(`--profile ${this.globals.profile} is given, so this run ignores ${keys.join(', ')}.`);
			}
		}
		// The Region reaches child command lines, store names and console URLs: accept only a Region code.
		// An explicit --region is always checked; an inherited AWS_REGION only for a command that uses AWS,
		// so a stray one does not stop local commands. Help (`--help`, `cdk-blocks help`) and --version never use it.
		if (parsed.command && parsed.command.path[0] !== 'help' && !this.globals.help && !this.globals.version) {
			if (this.globals.region !== undefined && !REGION_PATTERN.test(this.globals.region)) {
				throw new UsageError(
					`option --region must be an AWS Region code such as us-east-1, not ${JSON.stringify(this.globals.region)}.`,
				);
			}
			if (
				parsed.command.aws &&
				this.globals.region === undefined &&
				this.env.AWS_REGION &&
				!REGION_PATTERN.test(this.env.AWS_REGION)
			) {
				throw new UsageError(
					`AWS_REGION must be an AWS Region code such as us-east-1, not ${JSON.stringify(this.env.AWS_REGION)}.`,
					{ hint: 'export AWS_REGION=us-east-1, or pass --region <region>' },
				);
			}
		}
		if (this.globals.region) this.env.AWS_REGION = this.globals.region;
		// BLOCKS_LOG_LEVEL=quiet hides the dev server's request lines and keeps its RPC
		// errors; BLOCKS_DEV_QUIET (which hides errors too) is left to the user.
		this.env.BLOCKS_LOG_LEVEL = this.logLevel;
		// Core's progress, the CDK milestones and raw CDK output go to stderr; results
		// (BLOCKS_DEPLOYED, the final URLs, the deployment target) stay on stdout.
		this.env.BLOCKS_LOG_STREAM = 'stderr';
		// Core's in-process commands (sandbox console) read --telemetry-file from the
		// process argv after enterRoot() changed directory: make it absolute first.
		if (this.globals.telemetryFile !== undefined) {
			const file = resolve(deps.cwd, this.globals.telemetryFile);
			const end = deps.argv.includes('--') ? deps.argv.indexOf('--') : deps.argv.length;
			for (let i = 0; i < end; i++) {
				if (deps.argv[i].startsWith('--telemetry-file=')) deps.argv[i] = `--telemetry-file=${file}`;
				else if (deps.argv[i] === '--telemetry-file' && i + 1 < end) deps.argv[++i] = file;
			}
		}
	}

	/** The project root, if the command runs inside an AWS Blocks app. */
	findRoot(): string | undefined {
		if (this.root === null) this.root = findProjectRoot(this.startDir);
		return this.root;
	}

	/** The project root, or a CLI error when the command runs outside an AWS Blocks app. */
	requireRoot(): string {
		const root = this.findRoot();
		if (!root) {
			throw new CliError(
				`not inside an AWS Blocks app: no package.json with an aws-blocks/ directory at or above ${this.startDir}.`,
				{
					hint: 'run the command from your app directory, or pass -C <app-dir>',
				},
			);
		}
		return root;
	}

	/** Run the in-process core functions from the project root, as the npm scripts did. */
	enterRoot(): string {
		const root = this.requireRoot();
		this.deps.chdir(root);
		return root;
	}

	core(): Promise<CoreScripts> {
		return this.deps.core();
	}
}

/** How long the CLI waits after a SIGINT for the child to exit before it forwards one, and for a runner to stop before it signals its `tsx watch`. */
export const STOP_GRACE_MS = 10_000;

/** How long the CLI waits for `tsx watch` to exit once no runner is left under it, before it SIGKILLs it (see {@link SpawnSpec.watcher}). */
export const WATCHER_EXIT_MS = 1000;

/**
 * The pids of the children of `pid` (POSIX `ps`); none when `ps` fails, and none
 * on Windows: there a signal is `TerminateProcess`, so no runner runs a cleanup
 * to wait for, and a `ps` on `PATH` (Git for Windows' MSYS one) takes no `-A`.
 * Its stderr never reaches the user's terminal.
 */
export function childPids(
	pid: number,
	platform: NodeJS.Platform = process.platform,
	list: () => string = () =>
		execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }),
): number[] {
	if (platform === 'win32') return [];
	try {
		return list()
			.split('\n')
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter(([, parent]) => parent === pid)
			.map(([child]) => child);
	} catch {
		return [];
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export interface SpawnChildOptions {
	/** Default: {@link STOP_GRACE_MS}. */
	graceMs?: number;
}

/**
 * Run a child process to completion with the CLI's stdio.
 *
 * The child shares the CLI's process group, so a Ctrl-C in the terminal
 * reaches it directly, and it exits within its own cleanup budget (the dev
 * server in about 2 s, the sandbox in up to about 6 s). The CLI records the
 * SIGINT, waits for the child and then exits 130. A SIGINT sent to the CLI's
 * PID alone (a supervisor, an IDE, `kill -INT`) does not reach the child, so
 * when the child is still running after the grace period, the CLI forwards
 * one SIGINT. It never forwards one sooner, and never a second: on a second
 * SIGINT, `tsx watch` SIGKILLs the dev server before it cleans up. A `tsx watch`
 * left with no runner that does not exit is SIGKILLed (see {@link SpawnSpec.watcher}).
 *
 * SIGTERM and SIGHUP follow {@link SpawnSpec.longRunning} and
 * {@link SpawnSpec.watcher}: a long-running child is stopped at once, once.
 * Otherwise SIGTERM is forwarded at once: core's deploy coalesces the duplicate
 * SIGTERM that a process-group signal and this forward produce, and treats the
 * first one as a warning.
 */
export function createSpawnChild(options: SpawnChildOptions = {}): SpawnFn {
	const graceMs = options.graceMs ?? STOP_GRACE_MS;
	return (spec) =>
		new Promise((resolvePromise, reject) => {
			const child = spawnProcess(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				stdio: ['inherit', spec.stdoutToStderr ? 2 : 'inherit', 'inherit'],
			});
			let interrupted = false;
			let stopping = false;
			let terminated = false;
			let exited = false;
			let reaping = false;
			let escalation: NodeJS.Timeout | undefined;
			const escalate = (signal: NodeJS.Signals) => {
				escalation ??= setTimeout(() => {
					if (!stopping) child.kill(signal);
				}, graceMs);
			};
			/**
			 * Once none of `runners` lives, give `tsx watch` WATCHER_EXIT_MS to exit, then SIGKILL it:
			 * after a runner that a signal ended, it waits for that runner's exit forever. With no
			 * runner, it has nothing to clean up.
			 */
			const reapWatcher = async (runners: number[]) => {
				if (reaping) return;
				reaping = true;
				while (!exited && runners.some(isAlive)) await sleep(25);
				for (const deadline = Date.now() + WATCHER_EXIT_MS; !exited && Date.now() < deadline; ) await sleep(25);
				if (!exited) child.kill('SIGKILL');
			};
			const onInterrupt = () => {
				interrupted = true;
				escalate('SIGINT');
				// The Ctrl-C reached the runner, which exits after its cleanup, and `tsx watch` after it.
				if (spec.watcher && child.pid !== undefined) void reapWatcher(childPids(child.pid));
			};
			const stop = async () => {
				if (stopping) return;
				stopping = true;
				if (!spec.watcher || child.pid === undefined) {
					child.kill('SIGTERM');
					return;
				}
				const runners = childPids(child.pid);
				for (const pid of runners) {
					try {
						process.kill(pid, 'SIGTERM');
					} catch {
						// Already gone.
					}
				}
				for (const deadline = Date.now() + graceMs; !exited && Date.now() < deadline && runners.some(isAlive); )
					await sleep(25);
				if (exited) return;
				child.kill('SIGTERM');
				await reapWatcher(runners);
			};
			const forward = () => {
				terminated = true;
				child.kill('SIGTERM');
			};
			const onTerm = spec.longRunning ? () => void stop() : forward;
			// Ignored unless the child is long-running; the listener keeps a hangup from ending the CLI.
			const onHangup = spec.longRunning ? onTerm : () => {};
			process.on('SIGINT', onInterrupt);
			process.on('SIGTERM', onTerm);
			process.on('SIGHUP', onHangup);
			const cleanup = () => {
				exited = true;
				clearTimeout(escalation);
				process.off('SIGINT', onInterrupt);
				process.off('SIGTERM', onTerm);
				process.off('SIGHUP', onHangup);
			};
			child.on('error', (error) => {
				cleanup();
				reject(error);
			});
			child.on('exit', (code, signal) => {
				cleanup();
				resolvePromise({ code, signal, interrupted, stopped: stopping, terminated });
			});
		});
}

export const spawnChild: SpawnFn = createSpawnChild();

/** The prompt ended without an answer: Ctrl-C, or the end of the input. */
export class PromptInterrupted extends Error {
	constructor() {
		super('the prompt was interrupted');
		this.name = 'PromptInterrupted';
	}
}

export interface PromptStreams {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	/** Treat the streams as a terminal (Ctrl-C handling). Default: whether `output` is a TTY. */
	terminal?: boolean;
}

/**
 * Ask on stderr and read one line from stdin.
 *
 * @throws {PromptInterrupted} On Ctrl-C at the prompt, or the end of the input before an answer.
 */
export function promptLine(
	question: string,
	streams: PromptStreams = { input: process.stdin, output: process.stderr },
): Promise<string> {
	const rl = createInterface(streams);
	return new Promise((resolvePromise, reject) => {
		let answered = false;
		// In a terminal, readline reads Ctrl-C as a key, so the process gets no SIGINT.
		rl.on('SIGINT', () => rl.close());
		rl.on('close', () => {
			if (!answered) reject(new PromptInterrupted());
		});
		rl.question(question, (answer) => {
			answered = true;
			rl.close();
			resolvePromise(answer);
		});
	});
}

/** The real process seams. */
export function processDeps(): CliDeps {
	return {
		stdout: process.stdout,
		stderr: process.stderr,
		stdinIsTTY: process.stdin.isTTY === true,
		env: process.env,
		cwd: process.cwd(),
		prompt: promptLine,
		spawn: spawnChild,
		chdir: (dir) => process.chdir(dir),
		argv: process.argv,
		core: loadCoreScripts,
	};
}
