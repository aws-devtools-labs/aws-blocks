// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The run context of one `blocks` invocation: project-root detection, the
 * environment for child processes (`--profile`, `--region`, `BLOCKS_LOG_LEVEL`),
 * the interactive/CI decision and the injectable process seams.
 */

import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import type * as CoreScriptsModule from '@aws-blocks/core/scripts';
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
}

export interface ChildResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** The CLI received SIGINT while the child ran. */
	interrupted: boolean;
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
	 * for the run, and `blocks whoami` loads `.env.production` into it, as core's deploy does.
	 */
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Ask a question on stderr and read one line from stdin; rejects with {@link PromptInterrupted} on Ctrl-C. */
	prompt(question: string): Promise<string>;
	spawn: SpawnFn;
	/** Change the working directory, for the core functions that run in this process. */
	chdir(dir: string): void;
	/**
	 * Load `@aws-blocks/core/scripts`. A seam rather than a static import, so that
	 * `blocks --help` and usage errors do not load core, and tests can replace it.
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
		if (this.globals.cwd !== undefined && !existsSync(this.startDir)) {
			throw new UsageError(`directory ${this.startDir} does not exist (from -C/--cwd).`);
		}
		this.logLevel = logLevelFor(this.globals, this.env);
		const query =
			this.globals.query !== undefined && parsed.command
				? { path: this.globals.query, command: `blocks ${parsed.command.path.join(' ')}` }
				: undefined;
		this.out = new Output(
			deps.stdout,
			deps.stderr,
			this.globals.output,
			this.logLevel === 'quiet',
			this.env,
			query,
		);
		this.interactive = !this.globals.noInput && deps.stdinIsTTY && !isCi(this.env);

		if (this.globals.profile) this.env.AWS_PROFILE = this.globals.profile;
		// The Region reaches child command lines, store names and console URLs: accept only a Region code.
		// An explicit --region is always checked; an inherited AWS_REGION only for a command that uses AWS,
		// so a stray one does not stop local commands. Help and --version never use it.
		if (parsed.command && !this.globals.help && !this.globals.version) {
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

/**
 * True when this process is in the foreground process group of its controlling
 * terminal, so a Ctrl-C there reached every process of the group. Windows
 * delivers Ctrl-C to every process on the console. When it cannot tell, true.
 */
export function inTerminalForeground(): boolean {
	if (process.platform === 'win32') return true;
	try {
		if (process.platform === 'linux') {
			// After "(comm) ": state ppid pgrp session tty_nr tpgid.
			const stat = readFileSync('/proc/self/stat', 'utf-8');
			const [, , pgrp, , tty, tpgid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
			return tty !== '0' && tpgid === pgrp;
		}
		const [tpgid, pgid] = execFileSync('ps', ['-o', 'tpgid=,pgid=', '-p', String(process.pid)], {
			encoding: 'utf-8',
		})
			.trim()
			.split(/\s+/);
		return Number(tpgid) > 0 && tpgid === pgid;
	} catch {
		return true;
	}
}

export interface SpawnChildOptions {
	/**
	 * Whether a SIGINT the CLI received reached the child too: a Ctrl-C in the
	 * terminal does. Default: {@link inTerminalForeground}.
	 */
	sigintReachedChild?: () => boolean;
}

/**
 * Run a child process to completion with the CLI's stdio.
 *
 * The child shares the CLI's process group, so a Ctrl-C in the terminal
 * reaches it directly; the CLI waits for it to exit and then exits 130. A
 * SIGINT sent to the CLI's PID alone (a supervisor, an IDE, `kill -INT`) is
 * forwarded, so it stops the child too. It is not forwarded after a Ctrl-C: a
 * second SIGINT makes `tsx watch` SIGKILL the dev server before it cleans up.
 *
 * SIGTERM is forwarded, and SIGHUP is forwarded as SIGTERM, which `tsx`
 * passes on to the runner (it does not pass on SIGHUP). Core's deploy
 * coalesces the duplicate SIGTERM that a process-group signal and this
 * forward produce, and treats the first one as a warning, as it does a hangup.
 */
export function createSpawnChild(options: SpawnChildOptions = {}): SpawnFn {
	const sigintReachedChild = options.sigintReachedChild ?? inTerminalForeground;
	return (spec) =>
		new Promise((resolvePromise, reject) => {
			const child = spawnProcess(spec.command, spec.args, {
				cwd: spec.cwd,
				env: spec.env,
				stdio: ['inherit', spec.stdoutToStderr ? 2 : 'inherit', 'inherit'],
			});
			let interrupted = false;
			const onInterrupt = () => {
				interrupted = true;
				if (!sigintReachedChild()) child.kill('SIGINT');
			};
			const onTerm = () => {
				child.kill('SIGTERM');
			};
			process.on('SIGINT', onInterrupt);
			process.on('SIGTERM', onTerm);
			process.on('SIGHUP', onTerm);
			const cleanup = () => {
				process.off('SIGINT', onInterrupt);
				process.off('SIGTERM', onTerm);
				process.off('SIGHUP', onTerm);
			};
			child.on('error', (error) => {
				cleanup();
				reject(error);
			});
			child.on('exit', (code, signal) => {
				cleanup();
				resolvePromise({ code, signal, interrupted });
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
		core: () => import('@aws-blocks/core/scripts'),
	};
}
