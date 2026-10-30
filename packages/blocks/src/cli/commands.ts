// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Command handlers of the `blocks` CLI. Each lifecycle command runs the same
 * core function, under the same runtime, as the generated npm-script wrapper
 * it replaces; see `runners/launch.ts`.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AwsIdentity } from '@aws-blocks/core/scripts';
import { resolveDevConfig } from './config.js';
import {
	blocksVersion,
	type ChildResult,
	type Context,
	PromptInterrupted,
	STAGE_ENV_FILES,
	stageEnv,
} from './context.js';
import { CliError, ExitCode, type ExitCodeValue, exitCodeForChild, UsageError } from './errors.js';
import { commandHelp, rootHelp } from './help.js';
import { suggest } from './parse.js';
import { ALIASES, COMMANDS, type CommandInput, type CommandSpec, findCommand } from './registry.js';
import { LAST_DEPLOY_FILE, readDeployTarget } from './runners/deploy-target.js';
import {
	DEV_OPTIONS_ENV,
	type RunnerName,
	resolveTsxCli,
	resolveTsxLoader,
	runnerPath,
	shellQuote,
	TSX_IMPORT_ENV,
} from './runners/launch.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

interface ChildRun {
	operation: string;
	command: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	where?: string[];
}

/**
 * A child command line, safe to echo with --verbose: the password in a URL's
 * userinfo (`postgres://user:***@host`) and the value of `--url` are masked,
 * because `blocks db … --url <connection-string>` forwards credentials.
 */
export function redactArgs(args: readonly string[]): string[] {
	return args.map((arg, i) => {
		if (args[i - 1] === '--url') return '***';
		if (arg.startsWith('--url=')) return '--url=***';
		return arg.replace(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^@/\s]*@/gi, '$1:***@');
	});
}

/**
 * Run a child process and map its result to the CLI exit code. A failure
 * prints the CLI error after the child's own output; Ctrl-C exits 130.
 */
async function runChild(ctx: Context, run: ChildRun): Promise<number> {
	if (ctx.logLevel === 'verbose' || ctx.logLevel === 'debug') {
		ctx.out.progress(`> ${redactArgs([run.command, ...run.args]).join(' ')}`);
	}
	let result: ChildResult;
	try {
		result = await ctx.deps.spawn({
			command: run.command,
			args: run.args,
			cwd: run.cwd,
			env: { ...ctx.env, ...run.env },
			stdoutToStderr: ctx.out.format === 'json',
		});
	} catch (error) {
		throw new CliError(
			`${run.operation} could not start: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
	}
	const code = result.interrupted ? ExitCode.Interrupted : exitCodeForChild(result.code, result.signal);
	if (code === ExitCode.Interrupted) {
		ctx.out.progress(`${run.operation} interrupted.`);
		return code;
	}
	if (code !== ExitCode.Ok) {
		const detail = result.code === null ? `signal ${result.signal}` : `exit code ${result.code}`;
		throw new CliError(`${run.operation} failed (${detail}).`, {
			where: run.where ?? [`project: ${run.cwd}`],
			exitCode: code,
		});
	}
	return code;
}

interface RunnerRun {
	runner: RunnerName;
	operation: string;
	/** Passed to the runner as JSON in `process.argv[2]`. */
	options?: unknown;
	/** Arguments after the options. */
	args?: string[];
	/** `tsx` arguments before the runner, for example `watch` or `--conditions=cdk`. */
	tsxArgs?: string[];
	env?: NodeJS.ProcessEnv;
	where?: string[];
}

/**
 * Run a lifecycle runner under the app's `tsx`, from the project root. The
 * runner's client generation (core's deploy and sandbox) loads the same `tsx`.
 */
function runRunner(ctx: Context, run: RunnerRun): Promise<number> {
	const root = ctx.requireRoot();
	const options = run.options === undefined ? [] : [JSON.stringify(run.options)];
	return runChild(ctx, {
		operation: run.operation,
		command: process.execPath,
		args: [resolveTsxCli(root), ...(run.tsxArgs ?? []), runnerPath(run.runner), ...options, ...(run.args ?? [])],
		cwd: root,
		env: { [TSX_IMPORT_ENV]: resolveTsxLoader(root), ...run.env },
		where: run.where,
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

/** The production stack name; a CLI error when `.blocks/config.json` is missing. */
async function productionStack(ctx: Context, root: string): Promise<string> {
	const core = await ctx.core();
	try {
		return core.getStackName({ sandbox: false, projectRoot: root });
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	}
}

/** The sandbox stack name, when this machine has created a sandbox id; reading never creates one. */
async function sandboxStack(ctx: Context, root: string): Promise<string | null> {
	if (!existsSync(join(root, '.blocks-sandbox', 'sandbox-id.txt'))) return null;
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
 * an exported AWS_PROFILE (or --profile), it says so on stderr, even with
 * --quiet: the command is about to act on whatever account those keys belong to.
 */
async function targetLabel(
	ctx: Context,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<{ region: string | null; label: string }> {
	const core = await ctx.core();
	const target = await core.describeDeploymentCredentials({ env, projectRoot: root });
	const region = target.region && /^[a-z0-9-]+$/.test(target.region) ? target.region : null;
	if (target.keysOverrideProfile) {
		const profile = env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE;
		ctx.out.error(
			`Warning: access keys in the environment are set, so CDK uses them instead of the profile ${JSON.stringify(profile)}.\n` +
				'  Unset AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to use the profile.\n',
		);
	}
	return { region, label: `Region ${region ?? 'not set'}, credentials: ${target.credentials}` };
}

export interface DeployResult {
	apiUrl: string | null;
	url: string | null;
	stack: string | null;
	account: string | null;
	region: string | null;
}

/**
 * The result of the last deploy in `root`, from the stack outputs it wrote to
 * `.blocks-sandbox/outputs.json`: the stack that carries `ApiUrl`, as core picks
 * it, its `ApiUrl` and its hosting URL. Not from `.blocks-sandbox/config.json`,
 * which a dev server or sandbox rewrites with its own (local) URL.
 */
export function readDeployResult(root: string): Omit<DeployResult, 'account' | 'region'> {
	let apiUrl: string | null = null;
	let url: string | null = null;
	let stack: string | null = null;
	try {
		const outputs = JSON.parse(readFileSync(join(root, '.blocks-sandbox', 'outputs.json'), 'utf-8')) as Record<
			string,
			Record<string, string>
		>;
		const entry = Object.entries(outputs).find(([, values]) => values?.ApiUrl) ?? Object.entries(outputs)[0];
		if (entry) {
			stack = entry[0];
			apiUrl = entry[1]?.ApiUrl ?? null;
			const urlKey = Object.keys(entry[1] ?? {}).find((key) => key.includes('HostingUrl'));
			url = urlKey ? entry[1][urlKey] : null;
		}
	} catch {
		// No outputs.json: the deploy wrote no result.
	}
	return { apiUrl, url, stack };
}

/**
 * Print the deploy result as JSON. The account and Region are the ones the deploy
 * runner recorded (`.blocks-sandbox/last-deploy.json`): it loaded the stage env
 * files, so its credentials can differ from this process's. Never queries AWS.
 */
function emitDeployResult(ctx: Context, root: string): void {
	if (ctx.out.format !== 'json') return;
	const target = readDeployTarget(root);
	const result: DeployResult = {
		...readDeployResult(root),
		account: target?.account ?? null,
		region: target?.region ?? null,
	};
	ctx.out.result(result, '');
}

// ── Develop ──────────────────────────────────────────────────────────────────

export async function dev(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	const config = resolveDevConfig(root, input.flags);
	const backendPath = requireFile(join(root, 'aws-blocks', 'index.ts'), 'the backend entry');
	if (ctx.logLevel === 'verbose' || ctx.logLevel === 'debug') {
		ctx.out.progress(
			`Frontend: ${config.frontendCommand ?? 'none (backend only)'} (from ${config.source}); port ${config.port ?? 3000}`,
		);
	}
	const { source: _source, ...devConfig } = config;
	return runRunner(ctx, {
		runner: 'dev-server',
		operation: 'blocks dev',
		tsxArgs: ['watch'],
		env: { [DEV_OPTIONS_ENV]: JSON.stringify({ backendPath, ...devConfig }) },
	});
}

export async function devStop(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.enterRoot();
	const core = await ctx.core();
	let ports: number[];
	if (input.flags.all === true) {
		const dir = join(root, '.blocks-sandbox');
		ports = existsSync(dir)
			? readdirSync(dir)
					.map((name) => /^dev-server\.(\d+)\.pid$/.exec(name)?.[1])
					.filter((port): port is string => port !== undefined)
					.map(Number)
			: [];
	} else {
		ports = [resolveDevConfig(root, { port: input.flags.port }).port ?? 3000];
	}
	const results = [];
	for (const port of ports) results.push(await core.stopDevServer(port));
	const text =
		results.length > 0
			? results.map((r) => core.stopMessage(r)).join('\n')
			: 'No dev server was recorded for this app.';
	ctx.out.result(
		{
			stopped: results.map(({ port, stopped, alreadyStopped, portFree, via }) => ({
				port,
				stopped,
				alreadyStopped,
				portFree,
				via,
			})),
		},
		text,
	);
	return results.some((r) => !r.alreadyStopped && !r.portFree) ? ExitCode.Failure : ExitCode.Ok;
}

async function startSandbox(ctx: Context, deployOnly: boolean): Promise<number> {
	const root = ctx.requireRoot();
	const backendPath = requireFile(join(root, 'aws-blocks', 'index.cdk.ts'), 'the CDK entry');
	const config = resolveDevConfig(root);
	const { source: _source, ...devConfig } = config;
	const tsx = resolveTsxCli(root);
	// startSandbox runs its dev server from one shell string. It is the dev server
	// runner under `tsx watch`, with the same options as `blocks dev`.
	const devCommand = [process.execPath, tsx, 'watch', runnerPath('dev-server')]
		.map((word) => shellQuote(word))
		.join(' ');
	const stack = await sandboxStack(ctx, root);
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'sandbox'));
	ctx.out.progress(`Sandbox stack: ${stack ?? '(created on the first deploy)'}; ${label}`);
	rmSync(join(root, LAST_DEPLOY_FILE), { force: true });
	const code = await runRunner(ctx, {
		runner: 'sandbox',
		operation: deployOnly ? 'blocks sandbox deploy' : 'blocks sandbox',
		options: { backendPath, deployOnly, devCommand, clientPort: config.port ?? 3000 },
		env: { [DEV_OPTIONS_ENV]: JSON.stringify({ backendPath: join(root, 'aws-blocks', 'index.ts'), ...devConfig }) },
	});
	// After an interruption there is no result to report, and the files on disk are a previous deploy's.
	if (deployOnly && code === ExitCode.Ok) emitDeployResult(ctx, root);
	return code;
}

export function sandbox(ctx: Context): Promise<number> {
	return startSandbox(ctx, false);
}

export function sandboxDeploy(ctx: Context): Promise<number> {
	return startSandbox(ctx, true);
}

export async function sandboxDestroy(ctx: Context): Promise<number> {
	const root = ctx.requireRoot();
	const backendPath = requireFile(join(root, 'aws-blocks', 'index.cdk.ts'), 'the CDK entry');
	const stack = await sandboxStack(ctx, root);
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'sandbox'));
	const where = [`stack: ${stack ?? '(no sandbox id on this machine)'}`, label, `project: ${root}`];
	ctx.out.progress(`Deleting your sandbox stack ${stack ?? '(no sandbox id on this machine)'}; ${label}.`);
	ctx.out.progress('The production stack is not affected.');
	// A sandbox is disposable, and scripts run `sandbox destroy` unattended: ask only in a terminal.
	const declined = ctx.interactive
		? await confirm(ctx, 'Delete the sandbox stack?', 'blocks sandbox destroy --yes', where)
		: undefined;
	if (declined !== undefined) return declined;
	return runRunner(ctx, {
		runner: 'sandbox-destroy',
		operation: 'blocks sandbox destroy',
		tsxArgs: ['--conditions=cdk'],
		options: { backendPath },
		where,
	});
}

export async function sandboxConsole(ctx: Context): Promise<number> {
	const root = ctx.enterRoot();
	const outputsFile = requireFile(
		join(root, '.blocks-sandbox', 'outputs.json'),
		'stack outputs',
		'blocks sandbox deploy',
	);
	const core = await ctx.core();
	await core.openConsole({ outputsFile });
	return ExitCode.Ok;
}

// ── Deploy ───────────────────────────────────────────────────────────────────

export async function deploy(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	const cdkAppPath = requireFile(join(root, 'aws-blocks', 'index.cdk.ts'), 'the CDK entry');
	const stack = await productionStack(ctx, root);
	const { label } = await targetLabel(ctx, root, stageEnv(ctx.env, root, 'production'));
	ctx.out.progress(`Deploying the production stack ${stack}; ${label}; project ${root}.`);
	// Core reads these flags from process.argv: `--wait-live` and `--wait-live-timeout=N`.
	const args: string[] = [];
	const waitLive = input.flags['wait-live'];
	if (waitLive !== undefined) args.push('--wait-live');
	if (typeof waitLive === 'string') args.push(`--wait-live-timeout=${waitLive}`);
	if (typeof input.flags['wait-live-timeout'] === 'string')
		args.push(`--wait-live-timeout=${input.flags['wait-live-timeout']}`);
	rmSync(join(root, LAST_DEPLOY_FILE), { force: true });
	const code = await runRunner(ctx, {
		runner: 'deploy',
		operation: 'blocks deploy',
		options: { cdkAppPath, projectRoot: root },
		args,
		where: [`stack: ${stack}`, label, `project: ${root}`],
	});
	if (code === ExitCode.Ok) emitDeployResult(ctx, root);
	return code;
}

export async function destroy(ctx: Context): Promise<number> {
	const root = ctx.requireRoot();
	const cdkAppPath = requireFile(join(root, 'aws-blocks', 'index.cdk.ts'), 'the CDK entry');
	const stack = await productionStack(ctx, root);
	// Core's production destroy loads no env file, unlike its deploy.
	const { label } = await targetLabel(ctx, root, ctx.env);
	const where = [`stack: ${stack} (production)`, label, `project: ${root}`];
	ctx.out.progress(`This deletes the production stack ${stack}; ${label}; project ${root}.`);
	const declined = await confirm(ctx, `Delete the production stack ${stack}?`, 'blocks destroy --yes', where);
	if (declined !== undefined) return declined;
	return runRunner(ctx, {
		runner: 'destroy',
		operation: 'blocks destroy',
		options: { cdkAppPath, projectRoot: root },
		where,
	});
}

/**
 * The identity and Region that `blocks deploy` uses: the environment with
 * `.env.production` applied, as core's deploy applies it. When `.env.local`
 * (the sandbox's env file) sets an AWS variable differently, it warns that
 * `blocks sandbox` can use another identity or Region.
 */
export async function whoami(ctx: Context): Promise<number> {
	const root = ctx.findRoot();
	const core = await ctx.core();
	const env = root ? stageEnv(ctx.env, root, 'production') : ctx.env;
	if (root) {
		const sandboxEnv = stageEnv(ctx.env, root, 'sandbox');
		const differ = [...new Set([...Object.keys(env), ...Object.keys(sandboxEnv)])]
			.filter((key) => key.startsWith('AWS_') && env[key] !== sandboxEnv[key])
			.sort();
		if (differ.length > 0) {
			ctx.out.warn(
				`${STAGE_ENV_FILES.sandbox} sets ${differ.join(', ')} unlike ${STAGE_ENV_FILES.production}, so "blocks sandbox" can use another identity or Region than this one, which "blocks deploy" uses.`,
			);
		}
	}
	let identity: AwsIdentity;
	try {
		identity = await core.readAwsIdentity({
			invocation: 'blocks whoami',
			env,
			projectRoot: root ?? ctx.startDir,
		});
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	}
	if (!identity.region) {
		throw new CliError('no AWS Region is set, so the identity cannot be checked.', {
			where: [`credentials: ${identity.credentials}`],
			hint: 'blocks whoami --region <region>, or set region in your AWS profile',
		});
	}
	let production: string | null = null;
	if (root) {
		try {
			production = core.getStackName({ sandbox: false, projectRoot: root });
		} catch {
			// No .blocks/config.json; reported as null.
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
		`Sandbox:     ${sandboxName ?? (root ? '(created by the first "blocks sandbox")' : '(not in an AWS Blocks app)')}`,
		`Production:  ${production ?? (root ? '(no .blocks/config.json)' : '(not in an AWS Blocks app)')}`,
	].join('\n');
	ctx.out.result(result, text);
	return ExitCode.Ok;
}

// ── Configure ────────────────────────────────────────────────────────────────

/**
 * Run an in-process tool. Its usage errors (hosting's `ValueCliUsageError`:
 * missing key, unknown subcommand, a prompt or confirmation the run cannot
 * give) exit 2; any other error exits 1.
 */
async function inProcess(run: () => Promise<void>): Promise<number> {
	try {
		await run();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Error && error.name === 'ValueCliUsageError') throw new UsageError(message);
		throw new CliError(message, { cause: error });
	}
	return typeof process.exitCode === 'number' && process.exitCode !== 0 ? ExitCode.Failure : ExitCode.Ok;
}

/** `--no-input`/`CI` and the global `--yes`, for the in-process secret and config CLIs. */
function valueCliOptions(ctx: Context): { interactive: boolean; yes: boolean } {
	return { interactive: ctx.interactive, yes: ctx.globals.yes };
}

export async function secret(ctx: Context, input: CommandInput): Promise<number> {
	ctx.enterRoot();
	const core = await ctx.core();
	return inProcess(() => core.runSecretCli(input.passthrough, valueCliOptions(ctx)));
}

export async function config(ctx: Context, input: CommandInput): Promise<number> {
	ctx.enterRoot();
	const core = await ctx.core();
	return inProcess(() => core.runConfigCli(input.passthrough, valueCliOptions(ctx)));
}

export async function telemetry(ctx: Context, input: CommandInput): Promise<number> {
	const actions = new Set<string>();
	for (const action of ['status', 'enable', 'disable']) if (input.flags[action] === true) actions.add(action);
	const [positional] = input.positionals;
	if (positional !== undefined) {
		if (!['status', 'enable', 'disable'].includes(positional)) {
			const hint = suggest(positional, ['status', 'enable', 'disable']);
			throw new UsageError(`unknown telemetry action "${positional}".${hint ? ` Did you mean "${hint}"?` : ''}`, {
				hint: 'blocks telemetry --help',
			});
		}
		actions.add(positional);
	}
	if (actions.size > 1) throw new UsageError(`choose one telemetry action, not ${[...actions].join(' and ')}.`);
	const action = [...actions][0] ?? 'status';
	if (ctx.findRoot()) ctx.enterRoot();
	const core = await ctx.core();
	const argv = ['node', 'blocks', `--${action}`, ...(input.flags.global === true ? ['--global'] : [])];
	return inProcess(() => core.telemetry({ argv }));
}

// ── Generate ─────────────────────────────────────────────────────────────────

const BLOCKS_DIST = fileURLToPath(new URL('..', import.meta.url));

export function generateClient(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	return runChild(ctx, {
		operation: 'blocks generate client',
		command: process.execPath,
		args: [join(BLOCKS_DIST, 'generate-client-cli.js'), ...input.positionals.map((p) => resolve(ctx.startDir, p))],
		cwd: root,
	});
}

export function generateSpec(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	const [backendArg, outputArg] = input.positionals;
	const backendPath = resolve(backendArg ? ctx.startDir : root, backendArg ?? 'aws-blocks/index.ts');
	const outputPath = outputArg ? resolve(ctx.startDir, outputArg) : join(dirname(backendPath), 'blocks.spec.json');
	requireFile(backendPath, 'the backend entry');
	return runRunner(ctx, {
		runner: 'generate-spec',
		operation: 'blocks generate spec',
		options: { backendPath, outputPath },
	});
}

export async function generateTypes(ctx: Context, input: CommandInput): Promise<number> {
	ctx.enterRoot();
	const { flags } = input;
	const argv: string[] = [];
	if (flags.check === true) argv.push('--check');
	if (flags.watch === true) argv.push('--watch');
	if (typeof flags.out === 'string') argv.push('--out', flags.out);
	for (const glob of Array.isArray(flags.include) ? flags.include : []) argv.push('--include', glob);
	for (const spec of Array.isArray(flags.module) ? flags.module : []) argv.push('--module', spec);
	const core = await ctx.core();
	let code: number;
	try {
		code = await core.runTypegenCli(argv);
	} catch (error) {
		throw new CliError(error instanceof Error ? error.message : String(error), { cause: error });
	}
	return code === 0 ? ExitCode.Ok : ExitCode.Failure;
}

// ── Data and blocks ──────────────────────────────────────────────────────────

/**
 * The absolute path of a package's bin: from the app's own install first, then
 * from the dependencies of `@aws-blocks/blocks`.
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
	const [verb] = input.passthrough;
	if (verb === undefined) {
		throw new UsageError('"blocks db" needs a verb: migrate, status, generate-types or pull.', {
			hint: 'blocks db --help',
		});
	}
	if (!verbs.includes(verb)) {
		const hint = suggest(verb, verbs);
		throw new UsageError(
			`unknown db verb "${verb}"; expected migrate, status, generate-types or pull.${hint ? ` Did you mean "${hint}"?` : ''}`,
			{ hint: 'blocks db --help' },
		);
	}
	const help = input.passthrough.length === 2 && input.passthrough[1] === '--help';
	if (verb === 'pull' && !help && !ctx.interactive) {
		throw new UsageError(
			'"blocks db pull" asks for the database and its connection string, and this run cannot prompt (no TTY, --no-input or CI).',
			{ hint: 'run "blocks db pull" in a terminal' },
		);
	}
	const root = ctx.requireRoot();
	const cli = resolvePackageBin(root, '@aws-blocks/bb-data', 'bb-data');
	if (!cli) throw new CliError('cannot find the bb-data CLI of @aws-blocks/bb-data.', { hint: 'npm install' });
	return runChild(ctx, {
		operation: `blocks db ${input.passthrough[0]}`,
		command: process.execPath,
		args: [cli, ...input.passthrough],
		cwd: root,
	});
}

// ── Project ──────────────────────────────────────────────────────────────────

export function vendorize(ctx: Context, input: CommandInput): Promise<number> {
	const root = ctx.requireRoot();
	return runChild(ctx, {
		operation: 'blocks vendorize',
		command: process.execPath,
		args: [join(BLOCKS_DIST, 'vendorize.js'), ...input.passthrough],
		cwd: root,
	});
}

export interface HelpTarget {
	command: CommandSpec;
	/** The tokens after the command, for a passthrough command: `migrate` in `blocks help db migrate`. */
	rest: string[];
}

/**
 * Resolve `blocks help <tokens>` to a command, through aliases. Tokens after a
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
	const hint = suggest(asked, names);
	throw new UsageError(`unknown command "${asked}".${hint ? ` Did you mean "${hint}"?` : ''}`, {
		hint: 'blocks --help',
	});
}

/**
 * Show the help of a passthrough tool's verb: run the tool with exactly
 * `<verb> --help`. Every tool behind a passthrough command checks for `--help`
 * before any side effect, and no other argument of the user reaches it.
 */
export function verbHelp(ctx: Context, command: CommandSpec, verb: string): Promise<number> {
	if (!command.handler || !command.verbs?.includes(verb)) {
		throw new Error(`"blocks ${command.path.join(' ')}" has no verb "${verb}".`);
	}
	return command.handler(ctx, { flags: {}, positionals: [], passthrough: [verb, '--help'] });
}

/**
 * `blocks help [command...]`. For a verb of a passthrough command
 * (`blocks help db migrate`) it shows the tool's own help for that verb; any
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
