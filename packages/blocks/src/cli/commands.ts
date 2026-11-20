// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command handlers of the CDK Blocks task runner. Each lifecycle command runs the same
 * core function, under the same runtime, as the generated npm-script wrapper
 * it replaces; see `runners/launch.ts`.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AwsIdentity } from '@aws-cdk-blocks/core/scripts';
import {
	frontendPortWarning,
	keepsOwnClient,
	resolveDevConfig,
	resolveDevPort,
	unknownDevConfigWarnings,
} from './config.js';
import {
	applyStageEnv,
	blocksVersion,
	type ChildResult,
	type Context,
	isCi,
	PromptInterrupted,
	readStageEnvFile,
	REGION_PATTERN,
	type SpawnSpec,
	STAGE_ENV_FILES,
	stageEnv,
} from './context.js';
import { loadDevPidfile } from './core-load.js';
import {
	blocksCommand,
	CliError,
	ExitCode,
	type ExitCodeValue,
	exitCodeForChild,
	UsageError,
} from './errors.js';
import { commandHelp, rootHelp } from './help.js';
import { suggest, suggestCommand } from './parse.js';
import { ALIASES, COMMANDS, type CommandInput, type CommandSpec, findCommand } from './registry.js';
import {
	type DeployStage,
	forgetLastDeploy,
	LAST_DEPLOY_FILE,
	type LastDeploy,
	readLastDeploy,
} from './runners/last-deploy.js';
import {
	DEV_FAILURE_FILE_ENV,
	DEV_OPTIONS_ENV,
	DEV_STATE,
	DEV_UNDER_WATCH_ENV,
	devCrashCode,
	type RunnerLaunch,
	type RunnerName,
	resolveTsxCli,
	resolveTsxLoader,
	runnerArgs,
	runnerPath,
	shellQuote,
	TSX_IMPORT_ENV,
	tsxTsconfigEnv,
} from './runners/launch.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

interface ChildRun extends Pick<SpawnSpec, 'longRunning' | 'watcher'> {
	operation: string;
	/**
	 * The tool, for a child that is not a lifecycle runner (`blocks-vendorize`): its own
	 * output explains a failure, and `--verbose` adds nothing to it. Absent for a runner.
	 */
	tool?: string;
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	where?: string[];
	/**
	 * The file in which the dev server runner under `tsx watch` records its state
	 * (`BLOCKS_DEV_FAILURE_FILE`, see `DEV_STATE`). A failure reason there fails
	 * the command (exit 1) with no `Error:` line: the runner printed that reason
	 * itself. Otherwise a stop that the CLI made, or an exit 143 of `tsx watch`
	 * (`npm run dev:stop` while the backend is not running), succeeds, and a
	 * `tsx watch` that exits 0 by itself, with no runner that stopped cleanly
	 * under it, fails: it does when its runner dies and it watches no file.
	 */
	failureFile?: string;
}

/** What the dev server runner recorded in `failureFile` (see {@link ChildRun.failureFile}); `undefined` before any runner started. */
function readDevState(failureFile: string): string | undefined {
	try {
		const state = readFileSync(failureFile, 'utf-8');
		return state.trim() === '' ? undefined : state;
	} catch {
		return undefined; // No runner started.
	}
}

/**
 * The exit code of `npm run dev`, from what its runner recorded in `failureFile`
 * (see {@link ChildRun.failureFile}); `undefined` to map `result` as for any child.
 */
function devExitCode(run: ChildRun, failureFile: string, result: ChildResult): number | undefined {
	const state = readDevState(failureFile);
	// A dev server that crashed after it started: `dev` restarts it, unless the CLI was stopped meanwhile.
	if (devCrashCode(state) !== undefined) {
		if (result.interrupted) return undefined;
		return result.stopped ? ExitCode.Ok : ExitCode.Failure;
	}
	// The runner printed the reason and its hint; printing it again would only repeat it.
	if (state !== undefined && state !== DEV_STATE.running && state !== DEV_STATE.stopped) return ExitCode.Failure;
	if (result.interrupted) return undefined;
	if (result.stopped || result.code === 128 + 15) return ExitCode.Ok;
	if (result.code !== 0 || state === DEV_STATE.stopped) return undefined;
	throw new CliError(
		state === DEV_STATE.running
			? 'npm run dev ended: its dev server was killed (by a signal, or out of memory); its output is above.'
			: 'npm run dev ended: its dev server did not start; its output is above.',
		{ where: run.where ?? [`project: ${run.cwd}`], runner: true },
	);
}

/**
 * A child command line, safe to echo with --verbose: the password in a URL's
 * userinfo (`postgres://user:***@host`) and the value of `--url` are masked,
 * because a forwarded argument can carry credentials.
 */
export function redactArgs(args: readonly string[]): string[] {
	return args.map((arg, i) => {
		if (args[i - 1] === '--url') return '***';
		if (arg.startsWith('--url=')) return '--url=***';
		return arg.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^@/\s]*@/gi, '$1:***@');
	});
}

/** A word of a printed command, quoted for a POSIX shell where needed. */
function shellWord(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : shellQuote(word, 'linux');
}

/** The `--profile` and `--region` of this run, for a printed command that must act on the same target. */
function awsOptions(ctx: Context): string[] {
	const { profile, region } = ctx.globals;
	return [...(profile ? ['--profile', profile] : []), ...(region ? ['--region', region] : [])].map(shellWord);
}

/**
 * The command line that re-runs the task against the same target, for
 * core's guidance ("Then re-run …"): with the -C, --profile and --region of this run.
 */
function invocation(ctx: Context, ...words: string[]): string {
	const { cwd } = ctx.globals;
	return blocksCommand(...words, ...(cwd === undefined ? [] : ['-C', cwd].map(shellWord)), ...awsOptions(ctx));
}

/**
 * Run a child process and map its result to the CLI exit code. A failure
 * prints the CLI error after the child's own output; Ctrl-C exits 130.
 */
async function runChild(ctx: Context, run: ChildRun): Promise<number> {
	if (ctx.logLevel === 'verbose' || ctx.logLevel === 'debug') {
		// Copy-pasteable into a POSIX shell: a word with a space, a quote or JSON is quoted.
		const words = redactArgs([run.command, ...run.args]).map(shellWord);
		ctx.out.progress(`> ${words.join(' ')}`);
	}
	let result: ChildResult;
	try {
		result = await ctx.deps.spawn({
			command: run.command,
			args: run.args,
			cwd: run.cwd,
			env: { ...ctx.env, ...run.env },
			stdoutToStderr: ctx.out.format === 'json',
			longRunning: run.longRunning,
			watcher: run.watcher,
		});
	} catch (error) {
		throw new CliError(
			`${run.operation} could not start: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
	if (run.failureFile) {
		const code = devExitCode(run, run.failureFile, result);
		if (code !== undefined) return code;
	}

	// A child that is not long-running and exited 0 finished its work before the
	// Ctrl-C reached it (`npm run vendorize` copied the package): report that.
	// A long-running child (`npm run dev`) exits 0 when Ctrl-C stops it, which is an interruption.
	const completed = result.code === 0 && !run.longRunning;
	const code = result.interrupted && !completed ? ExitCode.Interrupted : exitCodeForChild(result.code, result.signal);
	if (code === ExitCode.Interrupted) {
		ctx.out.progress(`${run.operation} interrupted.`);
		return code;
	}
	if (result.interrupted) ctx.out.progress(`${run.operation} finished before the interrupt stopped it.`);
	// The CLI forwarded a SIGTERM, which the child ended on: core aborted the deploy (exit 143), or it had no handler.
	if (result.terminated && (result.code === 128 + 15 || result.signal === 'SIGTERM')) {
		ctx.out.progress(`${run.operation} stopped by SIGTERM.`);
		return ExitCode.Terminated;
	}
	if (code !== ExitCode.Ok) {
		const where = run.where ?? [`project: ${run.cwd}`];
		if (run.tool) {
			// A tool stopped by a signal may have printed nothing.
			const ended =
				result.code === null
					? `was stopped by ${result.signal}.`
					: `exited with code ${result.code}; its output is above.`;
			throw new CliError(`${run.operation} failed: ${run.tool} ${ended}`, { where, exitCode: code });
		}
		const detail = result.code === null ? `signal ${result.signal}` : `exit code ${result.code}`;
		throw new CliError(`${run.operation} failed (${detail}).`, { where, exitCode: code, runner: true });
	}
	return code;
}

interface RunnerRun
	extends Pick<SpawnSpec, 'longRunning'>,
		Pick<RunnerLaunch, 'watch' | 'conditions'>,
		Pick<ChildRun, 'tool'> {
	runner: RunnerName;
	operation: string;
	/** Passed to the runner as JSON in `process.argv[2]`. */
	options?: unknown;
	/** Arguments after the options. */
	args?: string[];
	env?: NodeJS.ProcessEnv;
	where?: string[];
	/** The directory the runner runs from. Default: the project root, which the command then requires. */
	cwd?: string;
	failureFile?: string;
}

/**
 * The `--telemetry-file` argument that core's telemetry client reads from the
 * runner's argv, absolute because the runner runs from the project root.
 */
function telemetryArgs(ctx: Context): string[] {
	const file = ctx.globals.telemetryFile;
	return file === undefined ? [] : [`--telemetry-file=${resolve(ctx.deps.cwd, file)}`];
}

/**
 * The environment of the dev server runner, which always runs under `tsx watch`
 * (see {@link DEV_UNDER_WATCH_ENV}). An explicit host also opts the
 * local realtime WebSocket into that host's origins, which it reads from
 * `BLOCKS_DEV_HOST`, unless `BLOCKS_DEV_HOST` is already set in the environment:
 * an inherited opt-in (for example a hostname behind `--host 0.0.0.0`) wins.
 */
function devServerEnv(env: NodeJS.ProcessEnv, options: { backendPath: string; host?: string }): NodeJS.ProcessEnv {
	const exportHost = options.host !== undefined && !env.BLOCKS_DEV_HOST;
	return {
		[DEV_OPTIONS_ENV]: JSON.stringify(options),
		[DEV_UNDER_WATCH_ENV]: '1',
		...(exportHost ? { BLOCKS_DEV_HOST: options.host } : {}),
	};
}

/**
 * Run a lifecycle runner with the app's `tsx`, from the project root (see
 * {@link runnerArgs}). The runner's client generation (core's deploy and
 * sandbox) loads the same `tsx`, and both compile the backend with
 * `cdk-blocks/tsconfig.json` when the app has one (see {@link tsxTsconfigEnv}).
 */
function runRunner(ctx: Context, run: RunnerRun): Promise<number> {
	const root = run.cwd ?? ctx.requireRoot();
	const options = run.options === undefined ? [] : [JSON.stringify(run.options)];
	return runChild(ctx, {
		operation: run.operation,
		command: process.execPath,
		args: runnerArgs(root, runnerPath(run.runner), {
			watch: run.watch,
			conditions: run.conditions,
			args: [...options, ...(run.args ?? []), ...telemetryArgs(ctx)],
		}),
		cwd: root,
		env: { [TSX_IMPORT_ENV]: resolveTsxLoader(root), ...tsxTsconfigEnv(root, ctx.env), ...run.env },
		where: run.where,
		tool: run.tool,
		longRunning: run.longRunning,
		watcher: run.watch,
		failureFile: run.failureFile,
	});
}

function requireFile(path: string, what: string, hint?: string): string {
	if (!existsSync(path)) throw new CliError(`cannot find ${what} at ${path}.`, { hint });
	return path;
}

/**
 * Ask for confirmation. Without a terminal, require `--yes` (exit 2).
 *
 * @returns `undefined` to go ahead; otherwise the exit code to return, after a
 * message that nothing was deleted: 1 when declined, 130 on Ctrl-C at the prompt.
 */
async function confirm(
	ctx: Context,
	question: string,
	yesCommand: string,
	where: string[],
): Promise<ExitCodeValue | undefined> {
	if (ctx.globals.yes) return undefined;
	if (!ctx.interactive) {
		throw new UsageError('confirmation required, and this run cannot prompt (no TTY, --no-input or CI).', {
			where,
			hint: yesCommand,
		});
	}
	let answer: string;
	try {
		answer = await ctx.deps.prompt(`${question} [y/N] `);
	} catch (error) {
		if (!(error instanceof PromptInterrupted)) throw error;
		ctx.out.progress('\nInterrupted; nothing was deleted.');
		return ExitCode.Interrupted;
	}
	if (/^y(es)?$/i.test(answer.trim())) return undefined;
	ctx.out.progress('Cancelled; nothing was deleted.');
	return ExitCode.Failure;
}

/** The production stack name; a CLI error when `.cdk-blocks/config.json` is missing. */
async function productionStack(ctx: Context, root: string): Promise<string> {
	const core = await ctx.core();
	try {
		return core.getStackName({ sandbox: false, projectRoot: root });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new CliError(message, {
			cause: error,
			where: [`project: ${root}`],
			// Lists the production stacks, so that the id can be the one whose `<id>-prod` exists.
			hint: /not valid JSON/.test(message)
				? undefined
				: [
						`aws cloudformation describe-stacks --query "Stacks[?ends_with(StackName, '-prod')].StackName"`,
						...awsOptions(ctx),
					].join(' '),
		});
	}
}

/** The sandbox stack name, when this machine has created a sandbox id; reading never creates one. */
async function sandboxStack(ctx: Context, root: string): Promise<string | null> {
	if (!existsSync(join(root, '.cdk-blocks-sandbox', 'sandbox-id.txt'))) return null;
	const core = await ctx.core();
	try {
		return core.getStackName({ sandbox: true, projectRoot: root });
	} catch {
		return null;
	}
}

/**
 * The Region and the credentials that CDK would use, read from local configuration
 * only, with the same credentials label as the deploy's own target line. `env`
 * is the environment the runner deploys with: {@link stageEnv} for a stage
 * whose env file core loads. When environment access keys take precedence over
 * an exported AWS_PROFILE, it says so on stderr, even with --quiet: the command
 * is about to act on whatever account those keys belong to.
 */
async function targetLabel(
	ctx: Context,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<{ region: string | null; label: string }> {
	const core = await ctx.core();
	const target = await core.describeDeploymentCredentials({ env, projectRoot: root });
	const region = target.region && /^[a-z0-9-]+$/.test(target.region) ? target.region : null;
	if (target.keysOverrideProfile) warnKeysOverrideProfile(ctx, env);
	return { region, label: `Region ${region ?? 'not set'}, credentials: ${target.credentials}` };
}

/** Say on stderr, even with --quiet, that environment access keys win over the exported profile. */
function warnKeysOverrideProfile(ctx: Context, env: NodeJS.ProcessEnv): void {
	const profile = env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE;
	ctx.out.error(
		`Warning: access keys in the environment are set, so CDK uses them instead of the profile ${JSON.stringify(profile)}.\n` +
			'  Unset AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or pass --profile, to use the profile.\n',
	);
}

export type DeployResult = Pick<LastDeploy, 'apiUrl' | 'url' | 'stack' | 'account' | 'region'> & {
	/** Production only: whether `--wait-live` confirmed the new build live; null without `--wait-live`. */
	live?: boolean | null;
};

/**
 * Print the result of the deploy of `stage` that just ran, as JSON, from the
 * entry its runner recorded in `.cdk-blocks-sandbox/last-deploy.json`:
 * - the stack outputs core read when it deployed, not that stage's outputs document
 *   again, which a later deploy of the same stage rewrites with only its own stacks
 *   and a failed one can blank;
 * - not `.cdk-blocks-sandbox/config.json`, which a dev server or sandbox rewrites with its own (local) URL;
 * - the account and Region the runner deployed with: it loaded the stage env
 *   files, so its credentials can differ from this process's. Never queries AWS.
 */
function emitDeployResult(ctx: Context, root: string, stage: DeployStage, operation: string): void {
	if (ctx.out.format !== 'json') return;
	const last = readLastDeploy(root, stage);
	if (!last) {
		throw new CliError(
			`${operation} finished, but recorded no result in ${LAST_DEPLOY_FILE}; the output above says why.`,
			{ where: [`project: ${root}`] },
		);
	}
	const result: DeployResult = {
		apiUrl: last.apiUrl,
		url: last.url,
		stack: last.stack,
		account: last.account,
		region: last.region,
		...(stage === 'production' ? { live: last.live ?? null } : {}),
	};
	ctx.out.result(result, '');
}

// ── Develop ──────────────────────────────────────────────────────────────────

export async function dev(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	const config = resolveDevConfig(root, input.flags);
	for (const warning of unknownDevConfigWarnings(root)) ctx.out.warn(warning);
	const portWarning = frontendPortWarning(config);
	if (portWarning) ctx.out.warn(portWarning);
	const backendPath = requireFile(join(root, 'cdk-blocks', 'index.ts'), 'the backend entry');
	if (ctx.logLevel === 'verbose' || ctx.logLevel === 'debug') {
		ctx.out.progress(
			`Frontend: ${config.frontendCommand ?? 'none (backend only)'} (from ${config.source}); port ${config.port ?? 3000}`,
		);
	}
	const { source: _source, ...devConfig } = config;
	const port = config.port ?? 3000;
	const { claimDevSession, DEV_SESSION_ENV } = await loadDevPidfile();
	// Claim the session before anything starts, so that a `dev stop` from now on finds it: until the dev
	// server has loaded and taken the record over, the stop SIGTERMs this process, which stops what it started.
	// A listener keeps that SIGTERM from ending the CLI before it spawns `tsx watch`; from then on the spawn's
	// own listener stops the child. Nothing in between awaits, so the signal is handled once both are in place.
	const keepAlive = (): void => {};
	process.on('SIGTERM', keepAlive);
	let session = claimDevSession(root, port);
	if (!session.acquired) {
		process.off('SIGTERM', keepAlive);
		// One dev server per app, whatever its port: stop the one that runs, on its port.
		const running = session.port;
		const stop = running === 3000 ? blocksCommand('dev', 'stop') : blocksCommand('dev', 'stop', '--port', String(running));
		throw new CliError(`${session.reason}. Not starting a second one.`, {
			where: [`project: ${root}`],
			hint: stop,
		});
	}
	let release: (() => void) | undefined = session.release;
	try {
		// The dev server records a fatal startup failure here (see ChildRun.failureFile).
		const failureDir = mkdtempSync(join(tmpdir(), 'blocks-dev-'));
		try {
			return await superviseDevServer(join(failureDir, 'failure'));
		} finally {
			rmSync(failureDir, { recursive: true, force: true });
		}
	} finally {
		process.off('SIGTERM', keepAlive);
		release?.();
	}

	/**
	 * Run the dev server under `tsx watch` until it is stopped, and start it again, after a
	 * backoff, when it crashes after it started (see {@link decideDevRestart}).
	 */
	async function superviseDevServer(failureFile: string): Promise<number> {
		let restarts: number[] = [];
		for (;;) {
			// A record that the last session left (a crash) must not be read as this session's: a runner
			// that exits before it records anything (tsx's preflight, a failing import) would look like a
			// new crash, and a restarted runner would not see its start as a first start (runners/fail.ts).
			rmSync(failureFile, { force: true });
			const code = await runRunner(ctx, {
				runner: 'dev-server',
				operation: 'npm run dev',
				watch: true,
				env: {
					...devServerEnv(ctx.env, { backendPath, ...devConfig }),
					[DEV_FAILURE_FILE_ENV]: failureFile,
					[DEV_SESSION_ENV]: String(process.pid),
				},
				longRunning: true,
				failureFile,
			});
			const crash = code === ExitCode.Failure ? devCrashCode(readDevState(failureFile)) : undefined;
			if (crash === undefined) return code;
			const decision = decideDevRestart(restarts, Date.now());
			restarts = decision.recent;
			const { maxRestarts, windowMs } = DEV_RESTART_POLICY;
			if (!decision.restart) {
				throw new CliError(
					`npm run dev ended: its dev server crashed ${maxRestarts + 1} times within ${windowMs / 1000} s, so it was not restarted again. ` +
						`Fix the error in its output above, then run ${blocksCommand('dev')} again.`,
					{ where: [`project: ${root}`], runner: true },
				);
			}
			ctx.out.error(
				`\n⚠️  The dev server crashed (exit code ${crash}); restarting it in ${decision.delayMs} ms ` +
					`(restart ${decision.recent.length} of ${maxRestarts} within ${windowMs / 1000} s).\n`,
			);
			// The crashed dev server removed its record: claim the session again, so that a `dev stop`
			// from now on finds this CLI, which stops what it started, as it does during the first start.
			release?.();
			release = undefined;
			session = claimDevSession(root, port);
			if (!session.acquired) {
				throw new CliError(`${session.reason}, so the crashed dev server was not restarted.`, {
					where: [`project: ${root}`],
				});
			}
			release = session.release;
			const signal = await waitUnlessStopped(decision.delayMs);
			if (signal === 'SIGINT') {
				ctx.out.progress('npm run dev interrupted.');
				return ExitCode.Interrupted;
			}
			if (signal !== undefined) return ExitCode.Ok;
		}
	}
}

/** How `npm run dev` restarts a dev server that crashed after it started (see {@link decideDevRestart}). */
export interface DevRestartPolicy {
	/** Restarts allowed within `windowMs`; the next crash ends `npm run dev`. */
	maxRestarts: number;
	/** The sliding window (ms) over which restarts are counted. */
	windowMs: number;
	/** The first backoff (ms); it doubles for each restart already in the window. */
	backoffMs: number;
	/** The longest backoff (ms). */
	maxBackoffMs: number;
}

/** The default: 5 restarts within 60 s, after a backoff of 500 ms that doubles up to 5 s. */
export const DEV_RESTART_POLICY: DevRestartPolicy = {
	maxRestarts: 5,
	windowMs: 60_000,
	backoffMs: 500,
	maxBackoffMs: 5_000,
};

/**
 * Decide whether to restart a dev server that crashed at `now`, given the times of
 * the restarts so far. Only restarts within the window count, so a backend that
 * crashes once in a while is always restarted, and one that crashes again at once
 * after every restart stops after `maxRestarts`, instead of looping. `recent` is
 * the restarts to pass to the next decision, this one included when it restarts.
 */
export function decideDevRestart(
	restarts: readonly number[],
	now: number,
	policy: DevRestartPolicy = DEV_RESTART_POLICY,
): { restart: boolean; delayMs: number; recent: number[] } {
	const recent = restarts.filter((t) => now - t < policy.windowMs);
	if (recent.length >= policy.maxRestarts) return { restart: false, delayMs: 0, recent };
	const delayMs = Math.min(policy.backoffMs * 2 ** recent.length, policy.maxBackoffMs);
	return { restart: true, delayMs, recent: [...recent, now] };
}

/**
 * Wait `ms`, unless a SIGINT, SIGTERM or SIGHUP arrives first (a Ctrl-C, `npm run dev:stop`,
 * a closed terminal): resolves that signal, or `undefined` when the wait ran out.
 */
function waitUnlessStopped(ms: number): Promise<NodeJS.Signals | undefined> {
	const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
	return new Promise((resolvePromise) => {
		const done = (signal?: NodeJS.Signals): void => {
			clearTimeout(timer);
			for (const s of signals) process.off(s, done);
			resolvePromise(signal);
		};
		const timer = setTimeout(() => done(), ms);
		for (const s of signals) process.on(s, done);
	});
}

export async function devStop(ctx: Context, input: CommandInput): Promise<number> {
	if (input.flags.all === true && input.flags.port !== undefined) {
		throw new UsageError('--all stops every dev server this app recorded: it cannot be combined with --port.', {
			hint: `npm run dev:stop -- --port <port>, or npm run dev:stop -- --all`,
		});
	}
	const root = ctx.enterRoot();
	const core = await ctx.core();
	const dir = join(root, '.cdk-blocks-sandbox');
	const recorded = existsSync(dir)
		? readdirSync(dir)
				.map((name) => /^dev-server\.(\d+)\.pid$/.exec(name)?.[1])
				.filter((port): port is string => port !== undefined)
				.map(Number)
		: [];
	let ports: number[];
	if (input.flags.all === true) {
		ports = recorded;
	} else {
		const port = resolveDevPort(root, input.flags);
		for (const warning of unknownDevConfigWarnings(root)) ctx.out.warn(warning);
		ports = [port];
		// Without --port, a server started with `npm run dev -- --port N` is still the one to stop when it is
		// the only one recorded. With several, the user picks.
		if (input.flags.port === undefined && !recorded.includes(port)) {
			if (recorded.length === 1) {
				ports = recorded;
				ctx.out.progress(`No dev server is recorded on :${port}; stopping the one on :${recorded[0]}.`);
			} else if (recorded.length > 1) {
				ctx.out.warn(
					`No dev server is recorded on :${port}, but this app recorded ones on ${recorded.map((p) => `:${p}`).join(', ')}. ` +
						`Stop one with npm run dev:stop -- --port <port>, or all of them with npm run dev:stop -- --all.`,
				);
			}
		}
	}
	const results = [];
	for (const port of ports) results.push(await core.stopDevServer(port));
	// A port still bound after the stop is a problem, not an outcome: it goes to stderr, as in core's runStopCli.
	const warnings = results.filter((r) => core.isStopWarning(r));
	for (const r of warnings) ctx.out.error(`${core.stopMessage(r)}\n`);
	const outcomes = results.filter((r) => !core.isStopWarning(r));
	const text =
		results.length > 0 ? outcomes.map((r) => core.stopMessage(r)).join('\n') : 'No dev server was recorded for this app.';
	const value = {
		stopped: results.map(({ port, stopped, alreadyStopped, portFree, via, holders }) => ({
			port,
			stopped,
			alreadyStopped,
			portFree,
			via,
			holders,
		})),
	};
	if (ctx.out.format === 'json' || text !== '') ctx.out.result(value, text);
	return warnings.length > 0 ? ExitCode.Failure : ExitCode.Ok;
}

/** How `npm run sandbox` runs: watch mode, or one deploy (`deploy`), or one deploy with a hosted preview (`preview`). */
type SandboxMode = 'watch' | 'deploy' | 'preview';

async function startSandbox(ctx: Context, mode: SandboxMode): Promise<number> {
	const deployOnly = mode !== 'watch';
	const operation = deployOnly ? `npm run sandbox:${mode}` : 'npm run sandbox';
	const root = ctx.requireRoot();
	const backendPath = requireFile(join(root, 'cdk-blocks', 'index.cdk.ts'), 'the CDK entry');
	const config = resolveDevConfig(root);
	for (const warning of unknownDevConfigWarnings(root)) ctx.out.warn(warning);
	const portWarning = deployOnly ? undefined : frontendPortWarning(config);
	if (portWarning) ctx.out.warn(portWarning);
	const { source: _source, ...devConfig } = config;
	const tsx = resolveTsxCli(root);
	// startSandbox runs its dev server from one shell string. It is the dev server
	// runner under `tsx watch`, with the same options as `npm run dev`.
	const devCommand = [process.execPath, tsx, 'watch', runnerPath('dev-server')]
		.map((word) => shellQuote(word))
		.join(' ');
	const stack = await sandboxStack(ctx, root);
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'sandbox'));
	ctx.out.progress(`Sandbox stack: ${stack ?? '(created on the first deploy)'}; ${label}`);
	forgetLastDeploy(root, 'sandbox');
	const code = await runRunner(ctx, {
		runner: 'sandbox',
		operation,
		options: {
			backendPath,
			deployOnly,
			preview: mode === 'preview',
			devCommand,
			clientPort: config.port ?? 3000,
			invocation: deployOnly ? invocation(ctx, 'sandbox', mode) : invocation(ctx, 'sandbox'),
			destroyInvocation: invocation(ctx, 'sandbox', 'destroy'),
			previewInvocation: invocation(ctx, 'sandbox', 'preview'),
		},
		env: devServerEnv(ctx.env, { backendPath: join(root, 'cdk-blocks', 'index.ts'), ...devConfig }),
		// Watch mode runs until stopped. A deploy-only run is not long-running: the CLI does not stop it on a
		// hangup, but core's sandbox deploy does not defer SIGHUP, so a hangup of the whole process group ends it.
		longRunning: !deployOnly,
	});
	// After an interruption or a failure there is no result to report.
	if (deployOnly && code === ExitCode.Ok) emitDeployResult(ctx, root, 'sandbox', operation);
	return code;
}

export function sandbox(ctx: Context): Promise<number> {
	return startSandbox(ctx, 'watch');
}

export function sandboxDeploy(ctx: Context): Promise<number> {
	return startSandbox(ctx, 'deploy');
}

export function sandboxPreview(ctx: Context): Promise<number> {
	return startSandbox(ctx, 'preview');
}

export async function sandboxDestroy(ctx: Context): Promise<number> {
	const root = ctx.requireRoot();
	const backendPath = requireFile(join(root, 'cdk-blocks', 'index.cdk.ts'), 'the CDK entry');
	if (!existsSync(join(root, '.cdk-blocks-sandbox', 'sandbox-id.txt'))) {
		// The CDK app would create a sandbox id, and `cdk destroy` of a stack that does not exist succeeds.
		ctx.out.text(
			'No sandbox on this machine (.cdk-blocks-sandbox/sandbox-id.txt is missing); nothing to delete.\n' +
				'A sandbox deployed from another clone or before a `git clean` keeps running: delete its stack in the AWS console.',
		);
		return ExitCode.Ok;
	}
	const core = await ctx.core();
	let stack: string;
	try {
		stack = core.getStackName({ sandbox: true, projectRoot: root });
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	}
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'sandbox'));
	const where = [`stack: ${stack}`, label, `project: ${root}`];
	ctx.out.progress(`Deleting your sandbox stack ${stack}; ${label}.`);
	ctx.out.progress('The production stack is not affected.');
	// A sandbox is disposable, and scripts run `sandbox destroy` unattended: ask only in a terminal.
	const declined = ctx.interactive
		? await confirm(ctx, 'Delete the sandbox stack?', blocksCommand('sandbox', 'destroy', '--yes'), where)
		: undefined;
	if (declined !== undefined) return declined;
	const code = await runRunner(ctx, {
		runner: 'sandbox-destroy',
		operation: 'npm run sandbox:destroy',
		conditions: 'cdk',
		options: { backendPath, invocation: invocation(ctx, 'sandbox', 'destroy') },
		where,
	});
	if (code === ExitCode.Ok) forgetDeployRecords(root, 'sandbox', stack);
	return code;
}

/**
 * Each stage's CDK outputs document, by basename, mirroring core's `OUTPUTS_FILE`.
 *
 * Spelled here rather than imported: core is resolved lazily and version-checked
 * (`core-load.ts`), so a static value import would bypass that guard and fail
 * with Node's raw error on a skewed install. A test pins these against core.
 */
const OUTPUTS_BASENAME: Readonly<Record<DeployStage, string>> = {
	sandbox: 'outputs.json',
	production: 'outputs.production.json',
};

/**
 * Remove what this machine recorded about the deleted stack of `stage`, so that
 * `sandbox console`, `--output json` and tests that target that stage no longer
 * point at it: its entry in `last-deploy.json`, its stack in that stage's outputs
 * document (and in the pre-split `outputs.json` for production), its
 * `config.<stage>.json` (see core's `deployedConfigFile`), and a `config.json`
 * that an older deploy of that stage wrote. The other stage's records stay, and
 * so does the sandbox id: the next deploy reuses it.
 */
function forgetDeployRecords(root: string, stage: DeployStage, stack: string): void {
	forgetLastDeploy(root, stage);
	const dir = join(root, '.cdk-blocks-sandbox');
	const readJson = (name: string): Record<string, unknown> | undefined => {
		let value: unknown;
		try {
			value = JSON.parse(readFileSync(join(dir, name), 'utf-8'));
		} catch {
			return undefined;
		}
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value))
			: undefined;
	};
	// A production destroy scrubs the sandbox document too: an app that deployed
	// production before the per-stage split recorded its stack there, and nothing
	// rewrites that file until the next sandbox deploy. Stack names carry the
	// stage, so this can never drop a sandbox entry.
	const documents = [OUTPUTS_BASENAME[stage]];
	if (stage === 'production') documents.push(OUTPUTS_BASENAME.sandbox);
	for (const name of documents) {
		const outputs = readJson(name);
		if (!outputs || !Object.hasOwn(outputs, stack)) continue;
		delete outputs[stack];
		if (Object.keys(outputs).length === 0) rmSync(join(dir, name));
		else writeFileSync(join(dir, name), `${JSON.stringify(outputs, null, 2)}\n`);
	}
	// The name as a literal, not core's `deployedConfigFile`: this CLI may run against an
	// app whose installed core predates that export, and the file name is fixed.
	rmSync(join(dir, `config.${stage}.json`), { force: true });
	// Core 0.8.0 and earlier: a deploy wrote its URL to the dev server's config.json.
	if (readJson('config.json')?.environment === stage) rmSync(join(dir, 'config.json'));
}

/**
 * Open the console for this machine's sandbox stack, never another stack in
 * `.cdk-blocks-sandbox/outputs.json`. A production deploy no longer rewrites that
 * file, since each stage now writes its own document, but one written before
 * that split still holds production's stack alone, so the stack is derived here
 * and the document is only ever corroboration. The Region is the one the sandbox
 * was deployed to, when `last-deploy.json` recorded it; otherwise the sandbox's
 * configured Region. When neither record names the stack (a sandbox that the old
 * npm-script wrappers deployed, then a production deploy), CloudFormation is
 * asked: only a stack that does not exist is refused.
 */
export async function sandboxConsole(ctx: Context): Promise<number> {
	const root = ctx.enterRoot();
	const stack = await sandboxStack(ctx, root);
	if (stack === null) {
		throw new CliError('no sandbox on this machine (.cdk-blocks-sandbox/sandbox-id.txt is missing).', {
			where: [`project: ${root}`],
			hint: blocksCommand('sandbox', 'deploy'),
		});
	}
	const last = readLastDeploy(root, 'sandbox');
	let outputs: unknown;
	try {
		outputs = JSON.parse(readFileSync(join(root, '.cdk-blocks-sandbox', OUTPUTS_BASENAME.sandbox), 'utf-8'));
	} catch {
		// No outputs: only last-deploy.json can show that the sandbox was deployed.
	}
	const recorded =
		last?.stack === stack || (typeof outputs === 'object' && outputs !== null && Object.hasOwn(outputs, stack));
	const core = await ctx.core();
	const env = stageEnv(ctx.env, root, 'sandbox');
	const configured = await core.describeDeploymentCredentials({ env, projectRoot: root });
	// The Region goes into a URL: only a Region code.
	const region = [last?.stack === stack ? last.region : null, configured.region].find(
		(candidate): candidate is string => typeof candidate === 'string' && REGION_PATTERN.test(candidate),
	);
	if (!recorded && (await core.deployedStackExists({ stackName: stack, region, env, projectRoot: root })) === false) {
		throw new CliError(`the sandbox stack ${stack} does not exist${region ? ` in ${region}` : ''}.`, {
			where: [`project: ${root}`, `credentials: ${configured.credentials}`],
			hint: blocksCommand('sandbox', 'deploy'),
		});
	}
	await core.openConsole({ stackId: stack, region });
	return ExitCode.Ok;
}

// ── Deploy ───────────────────────────────────────────────────────────────────

/**
 * The `--wait-live` flags as core reads them from `process.argv`: `--wait-live`
 * and one `--wait-live-timeout=N`. A bad budget is a usage error here, before
 * any AWS call: core only warns and falls back to its default.
 */
function waitLiveArgs(flags: CommandInput['flags']): string[] {
	const waitLive = flags['wait-live'];
	const timeout = flags['wait-live-timeout'];
	if (timeout !== undefined && waitLive === undefined) {
		// Suggest the value only when --wait-live accepts it.
		const valid = /^\d+$/.test(String(timeout)) && Number(timeout) >= 1 && Number(timeout) <= 3600;
		throw new UsageError('option --wait-live-timeout needs --wait-live.', {
			hint: `npm run deploy -- --wait-live=${valid ? String(timeout) : 'SECONDS'}`,
		});
	}
	if (typeof waitLive === 'string' && timeout !== undefined) {
		throw new UsageError('give the --wait-live budget once: --wait-live=SECONDS or --wait-live-timeout=SECONDS.');
	}
	if (waitLive === undefined) return [];
	const [option, value] = typeof waitLive === 'string' ? ['--wait-live', waitLive] : ['--wait-live-timeout', timeout];
	if (value === undefined) return ['--wait-live'];
	const seconds = /^\d+$/.test(String(value)) ? Number(value) : Number.NaN;
	if (!(seconds >= 1 && seconds <= 3600)) {
		throw new UsageError(
			`option ${option} must be a whole number of seconds from 1 to 3600, not ${JSON.stringify(value)}.`,
		);
	}
	return ['--wait-live', `--wait-live-timeout=${seconds}`];
}

export async function deploy(ctx: Context, input: CommandInput): Promise<number> {
	const args = waitLiveArgs(input.flags);
	const root = ctx.requireRoot();
	const cdkAppPath = requireFile(join(root, 'cdk-blocks', 'index.cdk.ts'), 'the CDK entry');
	const stack = await productionStack(ctx, root);
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'production'));
	ctx.out.progress(`Deploying the production stack ${stack}; ${label}; project ${root}.`);
	forgetLastDeploy(root, 'production');
	let code: number;
	try {
		code = await runRunner(ctx, {
			runner: 'deploy',
			operation: 'npm run deploy',
			options: { cdkAppPath, projectRoot: root, invocation: invocation(ctx, 'deploy') },
			args,
			where: [`stack: ${stack}`, label, `project: ${root}`],
		});
	} catch (error) {
		// The deploy succeeded, and only --wait-live failed: report the result, then fail.
		if (!(error instanceof CliError) || readLastDeploy(root, 'production')?.live !== false) throw error;
		emitDeployResult(ctx, root, 'production', 'npm run deploy');
		throw new CliError(
			'npm run deploy deployed the stack, but --wait-live could not confirm that the new build is live; the output above says why.',
			{ where: [`stack: ${stack}`, label, `project: ${root}`], hint: 'check the frontend, or re-run with a longer --wait-live' },
		);
	}
	if (code !== ExitCode.Ok) return code;
	// CDK deploys the stacks that index.cdk.ts defines, whatever .cdk-blocks/config.json says.
	const deployed = readLastDeploy(root, 'production')?.stack;
	if (deployed && deployed !== stack) {
		ctx.out.error(
			`Warning: CDK deployed the stack ${deployed}, not ${stack}, which .cdk-blocks/config.json names.\n` +
				`  npm run destroy and npm run whoami use ${stack}; set "stackId" in .cdk-blocks/config.json so that <stackId>-prod is ${deployed}.\n`,
		);
	}
	emitDeployResult(ctx, root, 'production', 'npm run deploy');
	return code;
}

export async function destroy(ctx: Context): Promise<number> {
	const root = ctx.requireRoot();
	const cdkAppPath = requireFile(join(root, 'cdk-blocks', 'index.cdk.ts'), 'the CDK entry');
	const stack = await productionStack(ctx, root);
	// Core's production destroy loads `.env.production`, as its deploy does.
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'production'));
	const where = [`stack: ${stack} (production)`, label, `project: ${root}`];
	ctx.out.progress(`This deletes the production stack ${stack}; ${label}; project ${root}.`);
	const declined = await confirm(ctx, `Delete the production stack ${stack}?`, blocksCommand('destroy', '--yes'), where);
	if (declined !== undefined) return declined;
	const code = await runRunner(ctx, {
		runner: 'destroy',
		operation: 'npm run destroy',
		options: { cdkAppPath, projectRoot: root, stackName: stack, invocation: invocation(ctx, 'destroy') },
		where,
	});
	if (code === ExitCode.Ok) forgetDeployRecords(root, 'production', stack);
	return code;
}

/**
 * The identity and Region that `npm run deploy` uses. Like core's deploy, it
 * loads `.env.production` into the environment of this process (an exported
 * variable wins): the credential chain of the AWS SDK reads `process.env`, so
 * a copy would not reach AWS_PROFILE, AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE
 * or the web-identity variables. When `.env.local` (the sandbox's env file)
 * sets an AWS variable to another value, it warns that `npm run sandbox` can
 * use another identity or Region.
 */
export async function whoami(ctx: Context): Promise<number> {
	const root = ctx.findRoot();
	const core = await ctx.core();
	const env = ctx.env;
	if (root) {
		const sandboxEnv = stageEnv(env, root, 'sandbox');
		applyStageEnv(env, root, 'production');
		const differ = Object.keys(readStageEnvFile(root, 'sandbox') ?? {})
			.filter((key) => key.startsWith('AWS_') && env[key] !== sandboxEnv[key])
			.sort();
		if (differ.length > 0) {
			ctx.out.warn(
				`${STAGE_ENV_FILES.sandbox} sets ${differ.join(', ')} unlike ${STAGE_ENV_FILES.production}, so "npm run sandbox" can use another identity or Region than this one, which "npm run deploy" uses.`,
			);
		}
	}
	const projectRoot = root ?? ctx.startDir;
	// The same warning as the deploy commands: the identity below is that of the keys, not of the profile.
	if ((await core.describeDeploymentCredentials({ env, projectRoot })).keysOverrideProfile) {
		warnKeysOverrideProfile(ctx, env);
	}
	let identity: AwsIdentity;
	try {
		identity = await core.readAwsIdentity({ invocation: invocation(ctx, 'whoami'), env, projectRoot });
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	}
	if (!identity.region) {
		throw new CliError('no AWS Region is set, so the identity cannot be checked.', {
			where: [`credentials: ${identity.credentials}`],
			hint: `npm run whoami -- --region <region>, or set region in your AWS profile`,
		});
	}
	let production: string | null = null;
	let noProduction = '(not in a CDK Blocks app)';
	if (root) {
		try {
			production = core.getStackName({ sandbox: false, projectRoot: root });
		} catch (error) {
			// Reported as null, with the reason in the text.
			const message = error instanceof Error ? error.message : String(error);
			if (!existsSync(join(root, '.cdk-blocks', 'config.json'))) noProduction = '(no .cdk-blocks/config.json)';
			else if (/not valid JSON/.test(message)) {
				noProduction = '(invalid .cdk-blocks/config.json)';
				ctx.out.warn(message);
			} else noProduction = '(no stackId in .cdk-blocks/config.json)';
		}
	}
	const sandboxName = root ? await sandboxStack(ctx, root) : null;
	const result = {
		account: identity.account ?? null,
		arn: identity.arn ?? null,
		credentials: identity.credentials,
		region: identity.region,
		projectRoot: root ?? null,
		stacks: { sandbox: sandboxName, production },
	};
	const region = /^[a-z0-9-]+$/.test(identity.region) ? identity.region : JSON.stringify(identity.region);
	const text = [
		`Account:     ${result.account ?? 'unknown'}`,
		`Identity:    ${result.arn ?? 'unknown'}`,
		`Credentials: ${result.credentials}`,
		`Region:      ${region}`,
		`Sandbox:     ${sandboxName ?? (root ? '(created by the first "npm run sandbox")' : '(not in an AWS CDK Blocks app)')}`,
		`Production:  ${production ?? noProduction}`,
	].join('\n');
	ctx.out.result(result, text);
	return ExitCode.Ok;
}

// ── Configure ────────────────────────────────────────────────────────────────

/**
 * Run an in-process tool. Its usage errors (hosting's `ValueCliUsageError`:
 * missing key, unknown subcommand, a prompt or confirmation the run cannot
 * give) exit 2; Ctrl-C or Ctrl-D at its prompt (`ValueCliInterruptedError`)
 * exits 130; any other error exits 1.
 */
async function inProcess(ctx: Context, run: () => Promise<void>): Promise<number> {
	try {
		await run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Error && error.name === 'ValueCliUsageError') throw new UsageError(message);
		if (error instanceof Error && error.name === 'ValueCliInterruptedError') {
			ctx.out.progress('Interrupted; nothing was set.');
			return ExitCode.Interrupted;
		}
		throw new CliError(message, { cause: error });
	}
	return typeof process.exitCode === 'number' && process.exitCode !== 0 ? ExitCode.Failure : ExitCode.Ok;
}

/**
 * `--no-input`/`CI` and the global `--yes`, for the in-process secret and config CLIs. Stdin that is not
 * a terminal is left to the tool, which says so (`stdin is not a TTY`) rather than blaming `--no-input`.
 */
function valueCliOptions(ctx: Context): { interactive: boolean; yes: boolean } {
	return { interactive: !ctx.globals.noInput && !isCi(ctx.env), yes: ctx.globals.yes };
}

/** A bare `npm run secret` or `npm run config` is a usage error that points to its help. */
function requireValueVerb(name: 'secret' | 'config', input: CommandInput): void {
	if (input.flags.help !== true && input.passthrough.length === 0) {
		throw new UsageError(`"npm run ${name}" needs a verb: set, list or remove.`, { hint: blocksCommand(name, '--help') });
	}
}

export async function secret(ctx: Context, input: CommandInput): Promise<number> {
	requireValueVerb('secret', input);
	// A verb's help works outside an app too, with the default store prefix.
	if (input.flags.help !== true || ctx.findRoot()) ctx.enterRoot();
	const core = await ctx.core();
	return inProcess(ctx, () => core.runSecretCli(input.passthrough, valueCliOptions(ctx)));
}

export async function config(ctx: Context, input: CommandInput): Promise<number> {
	requireValueVerb('config', input);
	if (input.flags.help !== true || ctx.findRoot()) ctx.enterRoot();
	const core = await ctx.core();
	return inProcess(ctx, () => core.runConfigCli(input.passthrough, valueCliOptions(ctx)));
}

// ── Generate ─────────────────────────────────────────────────────────────────

const BLOCKS_DIST = fileURLToPath(new URL('..', import.meta.url));

export function generateClient(ctx: Context, input: CommandInput): Promise<number> {
	// With both paths given, the tool needs no app, as \`blocks-generate-client <foundation> <output>\` does not.
	const app = ctx.findRoot();
	const root = input.positionals.length === 2 ? (app ?? ctx.startDir) : ctx.requireRoot();
	// Checked here, as generate spec checks it, so both report a missing backend the same way.
	const [backendArg, outputArg] = input.positionals;
	requireFile(backendArg ? resolve(ctx.startDir, backendArg) : join(root, 'cdk-blocks', 'index.ts'), 'the backend entry');
	const output = outputArg ? resolve(ctx.startDir, outputArg) : join(root, 'cdk-blocks', 'client.js');
	if (app && output === join(app, 'cdk-blocks', 'client.js') && input.flags.force !== true && keepsOwnClient(app)) {
		throw new UsageError(
			'this app generates its own cdk-blocks/client.js (package.json "blocks.dev.generateClient" is false), and "npm run generate-client" would replace it with the generic client.',
			{ where: [`project: ${app}`], hint: `npm run blocks:generate-client, or npm run generate-client -- --force` },
		);
	}
	return runChild(ctx, {
		operation: 'npm run generate-client',
		tool: 'blocks-generate-client',
		command: process.execPath,
		args: [
			join(BLOCKS_DIST, 'generate-client-cli.js'),
			...input.positionals.map((p) => resolve(ctx.startDir, p)),
			...telemetryArgs(ctx),
		],
		cwd: root,
		// The worker imports the backend through tsx, so it needs the backend's jsx and paths too.
		env: tsxTsconfigEnv(root, ctx.env),
	});
}

export function generateSpec(ctx: Context, input: CommandInput): Promise<number> {
	const [backendArg, outputArg] = input.positionals;
	// With the backend given, the spec needs no app; its default output sits next to the backend.
	const backendPath = backendArg ? resolve(ctx.startDir, backendArg) : join(ctx.requireRoot(), 'cdk-blocks', 'index.ts');
	const root = ctx.findRoot();
	const outputPath = outputArg ? resolve(ctx.startDir, outputArg) : join(dirname(backendPath), 'blocks.spec.json');
	requireFile(backendPath, 'the backend entry');
	return runRunner(ctx, {
		runner: 'generate-spec',
		operation: 'npm run spec',
		// Its own `❌` line says why it failed, as blocks-generate-client's does.
		tool: 'blocks-generate-spec',
		options: { backendPath, outputPath },
		// Importing the backend creates its local mock storage (`.cdk-blocks/local/data/`) in the working
		// directory: outside an app, that is the backend's directory, not wherever the user is.
		cwd: root ?? dirname(backendPath),
	});
}

export async function generateTypes(ctx: Context, input: CommandInput): Promise<number> {
	const { flags } = input;
	if (flags.check === true && flags.watch === true) {
		throw new UsageError('choose --check or --watch, not both.', { hint: blocksCommand('generate', 'types', '--help') });
	}
	for (const name of ['out', 'include', 'module']) {
		const values = ([] as unknown[]).concat(flags[name] ?? []);
		if (values.some((value) => value === '')) {
			throw new UsageError(`option --${name} needs a non-empty value.`, { hint: blocksCommand('generate', 'types', '--help') });
		}
	}
	const root = ctx.enterRoot();
	const argv: string[] = [];
	if (flags.check === true) argv.push('--check');
	if (flags.watch === true) argv.push('--watch');
	// typegen runs from the root; a relative --out or --include names a path from where the user is.
	if (typeof flags.out === 'string') {
		const out = resolve(ctx.startDir, flags.out);
		if (existsSync(out) && statSync(out).isDirectory()) {
			throw new UsageError(`option --out names a directory (${out}); give the .d.ts file to write.`, {
				hint: blocksCommand('generate', 'types', '--out', shellWord(join(flags.out, 'hosting-values.d.ts'))),
			});
		}
		argv.push('--out', out);
	}
	for (const glob of Array.isArray(flags.include) ? flags.include : []) {
		const negated = glob.startsWith('!');
		const fromRoot = relative(root, resolve(ctx.startDir, negated ? glob.slice(1) : glob))
			.split(sep)
			.join('/');
		argv.push('--include', `${negated ? '!' : ''}${fromRoot}`);
	}
	for (const spec of Array.isArray(flags.module) ? flags.module : []) argv.push('--module', spec);
	const core = await ctx.core();
	// `--watch` runs until its signal is aborted, so Ctrl-C (SIGINT) or SIGTERM aborts it here,
	// as the `hosting-typegen` bin does: the watcher then stops, core's `runTypegenCli` resolves
	// and records its `generate:types` event, and the CLI exits normally. Without a listener
	// the signal would kill the process before that. A one-shot run keeps the default
	// handling, so Ctrl-C still stops it at once.
	// Stopping the watcher with Ctrl-C or SIGTERM deliberately exits 0 and records SUCCESS,
	// matching the `hosting-typegen` bin: stopping a watcher is how it normally ends.
	const controller = flags.watch === true ? new AbortController() : undefined;
	const abort = (): void => controller?.abort();
	if (controller) {
		process.once('SIGINT', abort);
		process.once('SIGTERM', abort);
	}
	let code: number;
	try {
		code = await core.runTypegenCli(argv, controller && { signal: controller.signal });
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	} finally {
		process.off('SIGINT', abort);
		process.off('SIGTERM', abort);
	}
	return code === 0 ? ExitCode.Ok : ExitCode.Failure;
}

// ── Data and blocks ──────────────────────────────────────────────────────────

/**
 * The absolute path of a package's bin: from the app's own install first, then
 * from the dependencies of `aws-cdk-blocks`.
 */
export function resolvePackageBin(root: string, packageName: string, bin: string): string | undefined {
	for (const from of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
		let entry: string;
		try {
			entry = createRequire(from).resolve(packageName);
		} catch {
			continue;
		}
		for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
			const manifest = join(dir, 'package.json');
			if (!existsSync(manifest)) continue;
			const pkg = JSON.parse(readFileSync(manifest, 'utf-8')) as { name?: string; bin?: Record<string, string> };
			if (pkg.name !== packageName) continue;
			const target = pkg.bin?.[bin];
			if (target) return join(dir, target);
			break;
		}
	}
	return undefined;
}

export async function db(ctx: Context, input: CommandInput): Promise<number> {
	const verbs = findCommand(['db'])?.verbs ?? [];
	// bb-database reads no `--`: drop the one that ended the CLI's own options.
	const dashes = input.passthrough.indexOf('--');
	const passthrough = input.passthrough.filter((_, i) => i !== dashes);
	const [verb] = passthrough;
	const oneOf = `${verbs.slice(0, -1).join(', ')} or ${verbs.at(-1)}`;
	if (verb === undefined) {
		throw new UsageError(`"npm run db" needs a verb: ${oneOf}.`, { hint: blocksCommand('db', '--help') });
	}
	if (!verbs.includes(verb)) {
		const hint = suggest(verb, verbs);
		throw new UsageError(`unknown db verb "${verb}"; expected ${oneOf}.${hint ? ` Did you mean "${hint}"?` : ''}`, {
			hint: blocksCommand('db', '--help'),
		});
	}
	const help = input.flags.help === true;
	// A verb's help works outside an app too, when @aws-cdk-blocks/bb-database is installed next to aws-cdk-blocks.
	const root = help ? (ctx.findRoot() ?? ctx.startDir) : ctx.requireRoot();
	const cli = resolvePackageBin(root, '@aws-cdk-blocks/bb-database', 'bb-database');
	if (!cli) {
		throw new CliError('cannot find the bb-database CLI of @aws-cdk-blocks/bb-database.', {
			hint: 'npm install @aws-cdk-blocks/bb-database',
		});
	}
	// The CLI's own --yes and --no-input are not forwarded with the other tokens, and bb-database has the same
	// two questions to skip or refuse: pass them on, so a run that cannot prompt fails at once with exit code 2.
	const answers = help ? [] : [...(ctx.globals.yes ? ['--yes'] : []), ...(ctx.interactive ? [] : ['--no-input'])];
	return runChild(ctx, {
		operation: `npm run db -- ${verb}`,
		tool: 'bb-database',
		command: process.execPath,
		args: [cli, ...passthrough, ...answers],
		cwd: root,
		// bb-database's help names the task that runs it. It runs from the project root and resolves the
		// paths in its own options from the task's starting directory (including -C).
		env: { BB_DATABASE_COMMAND: 'npm run db --', BB_DATABASE_START_DIR: ctx.startDir },
	});
}

// ── Project ──────────────────────────────────────────────────────────────────

export function vendorize(ctx: Context, input: CommandInput): Promise<number> {
	// The tool takes one package and --force; check them here, so a mistake is a usage error (exit 2).
	const tokens = input.passthrough.filter((token) => token !== '--');
	const option = tokens.find((token) => token.startsWith('-') && token !== '--force');
	if (option !== undefined) {
		throw new UsageError(`unknown option "${option}" for "npm run vendorize"; it takes only --force.`, {
			hint: blocksCommand('vendorize', '--help'),
		});
	}
	const packages = tokens.filter((token) => !token.startsWith('-'));
	if (packages.length === 0) {
		throw new UsageError('"npm run vendorize" needs the <package> argument.', { hint: blocksCommand('vendorize', '--help') });
	}
	if (packages.length > 1) {
		throw new UsageError(`unexpected argument "${packages[1]}" for "npm run vendorize".`, {
			hint: blocksCommand('vendorize', '--help'),
		});
	}
	const root = ctx.requireRoot();
	return runChild(ctx, {
		operation: 'npm run vendorize',
		tool: 'blocks-vendorize',
		command: process.execPath,
		args: [join(BLOCKS_DIST, 'vendorize.js'), ...input.passthrough],
		cwd: root,
	});
}

export interface HelpTarget {
	command: CommandSpec;
	/** The tokens after the command, for a passthrough command: `set` in `npm run help secret set`. */
	rest: string[];
}

/**
 * Resolve `npm run help <tokens>` to a command, through aliases. Tokens after a
 * passthrough command are its own subcommands; after any other command they
 * are an unknown command.
 */
export function helpTarget(tokens: readonly string[]): HelpTarget {
	const asked = tokens.join(' ');
	for (let n = tokens.length; n > 0; n--) {
		const path = tokens.slice(0, n).join(' ');
		const command =
			findCommand(tokens.slice(0, n)) ??
			findCommand(ALIASES.find((a) => a.name.join(' ') === path)?.target ?? []);
		if (!command) continue;
		if (n === tokens.length || command.passthrough) return { command, rest: tokens.slice(n) };
		break;
	}
	const names = [...COMMANDS.map((c) => c.path.join(' ')), ...ALIASES.map((a) => a.name.join(' '))];
	const hint = suggestCommand(asked, names);
	throw new UsageError(`unknown command "${asked}".${hint ? ` Did you mean "${hint}"?` : ''}`, {
		hint: blocksCommand('--help'),
	});
}

/**
 * Show the help of a passthrough tool's verb: run the tool with exactly
 * `<verb> --help`. Every tool behind a passthrough command checks for `--help`
 * before any side effect, and no other argument of the user reaches it.
 */
export function verbHelp(ctx: Context, command: CommandSpec, verb: string): Promise<number> {
	if (!command.handler || !command.verbs?.includes(verb)) {
		throw new Error(`"${blocksCommand(...command.path)}" has no verb "${verb}".`);
	}
	return command.handler(ctx, { flags: { help: true }, positionals: [], passthrough: [verb, '--help'] });
}

/**
 * `npm run help [task...]`. For a verb of a passthrough command
 * (`npm run help secret set`) it shows the tool's own help for that verb; any
 * further tokens are ignored and never reach the tool.
 */
export async function help(ctx: Context, input: CommandInput): Promise<number> {
	if (input.positionals.length === 0) {
		ctx.out.text(rootHelp(blocksVersion()));
		return ExitCode.Ok;
	}
	const { command, rest } = helpTarget(input.positionals);
	if (rest[0] !== undefined && command.verbs?.includes(rest[0])) return verbHelp(ctx, command, rest[0]);
	ctx.out.text(commandHelp(command));
	return ExitCode.Ok;
}
