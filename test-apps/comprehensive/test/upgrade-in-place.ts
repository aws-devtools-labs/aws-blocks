// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * UPGRADE-IN-PLACE E2E — proves an existing `AuthCognito` deployment survives
 * switching to the unified `Auth` block: same user pool, same users, same
 * sessions table and HMAC secret, and signed-in sessions still valid.
 *
 * ## How to run
 *
 * From `test-apps/comprehensive`, after `npm run build` at the repo root:
 *
 *     npx tsx test/upgrade-in-place.ts --dry-run                   # offline, no AWS
 *     BLOCKS_UPGRADE_E2E=1 AWS_PROFILE=<sandbox> AWS_REGION=us-east-1 \
 *         npx tsx test/upgrade-in-place.ts > upgrade.log 2>&1        # real, in the background
 *
 * The real mode deploys twice and destroys once (~5–8 minutes of AWS time,
 * plus a second checkout's `npm ci` + build; a few cents of Lambda, DynamoDB
 * and Cognito) and refuses to start unless `BLOCKS_UPGRADE_E2E=1`, `AWS_REGION`
 * and an explicit credential source (`AWS_PROFILE`, access keys, or a
 * web-identity/container role) are set — use a sandbox account. Optional:
 * `BLOCKS_STACK_SUFFIX` (must start with `upgrade-`; default `upgrade-<run id>`),
 * `BLOCKS_UPGRADE_BASE_REF` or `BLOCKS_UPGRADE_BASE_DIR` (an installed checkout
 * to reuse). The base revision defaults to the tag
 * `@aws-blocks/bb-auth-cognito@0.1.11`, the last release that ships `AuthCognito`
 * — what existing deployments run (not `main`: after the cutover `main` has no
 * `AuthCognito`). An override must still ship `packages/bb-auth-cognito`. It is long-running: never run it as a
 * blocking foreground command — start it in tmux or in the background and poll
 * the log for the final `UPGRADE_IN_PLACE_RESULT=` line (CI runs it as a step:
 * `.github/workflows/upgrade-in-place.yml`). **Cleanup guarantee:** the stack is
 * destroyed in a `finally` on every path, including failures and Ctrl-C (a
 * second Ctrl-C aborts cleanup); if it cannot be deleted the harness prints the
 * stack name, region and the delete command in a banner and exits 3. It never
 * deploys into, or destroys, a stack that existed before it started.
 *
 * ## What it does (real mode)
 *
 * 1. Checks out the pre-refactor revision in a `git worktree`, refuses it (exit
 *    2) unless it ships `@aws-blocks/bb-auth-cognito`, builds it, and `deploy()`s
 *    a small dedicated app using `AuthCognito` to `bb-test-<suffix>`; the app must
 *    resolve `AuthCognito` inside that checkout.
 * 2. Seeds a user (AdminCreateUser + permanent password), signs in through the
 *    app and keeps the session cookie; records the pool id, client id, user
 *    `sub`, sessions table name + id and the session-secret parameter.
 * 3. Switches the same app to `Auth` (same scope id, same block id) in this
 *    checkout. The live template must be `AuthCognito`'s (a user pool and no
 *    `Auth` immutability guard) and the new one `Auth`'s (the guard), so the
 *    proof can never pass by comparing `Auth` with itself. `cdk diff` against
 *    the live stack must show no replacement,
 *    removal or addition of the `UserPool` / `UserPoolClient` (or the sessions
 *    table / secret), and the live template must pass the continuity comparator.
 * 4. `deploy()`s again — same suffix, no `destroy()` in between. The stack must
 *    reach `UPDATE_COMPLETE`; on a rollback the `UpdateUserPool` error is pulled
 *    from the stack events (what `cdk diff` cannot show).
 * 5. Asserts the identity is byte-identical, the seeded user still signs in
 *    (directly against Cognito and through the app), and the PRE-UPGRADE cookie
 *    still authenticates (`requireAuth` → same `userSub`).
 * 6. `destroy()`s the stack in a `finally`.
 *
 * The dry-run does everything except touch AWS: it builds both revisions,
 * synthesizes both templates under `--conditions=cdk`, checks the pair really is
 * `AuthCognito` → `Auth`, runs the continuity comparator, and runs `cdk diff --template <before>` (offline) through the
 * same replacement parser as step 3. Its child processes get no credentials.
 *
 * Why a dedicated app rather than the comprehensive app: switching the
 * comprehensive app's `AuthCognito` instances to `Auth` would break its other
 * suites (task E1 owns that), and deploying all of its blocks twice would cost
 * far more than the two auth deploys this proof needs. The app lives in
 * `upgrade-in-place/app/` and is copied into each checkout at run time, because
 * the pre-refactor revision does not contain it. The BEFORE backend
 * (`backend.auth-cognito.ts.txt`) imports `@aws-blocks/bb-auth-cognito`, which
 * only the pre-refactor checkout has; `materializeApp` checks that it resolves
 * there and nowhere else.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type CfnTemplate,
	type ContinuityResult,
	compareContinuity,
	compareDeployedIdentity,
	type DeployedIdentity,
	DIFF_PROTECTED_TYPES,
	decodeRpcResponse,
	encodeRpcRequest,
	extractSessionCookie,
	extractUpdateFailures,
	findDiffViolations,
	formatUpdateFailureReport,
	type HarnessOptions,
	hashSecret,
	LEGACY_PACKAGE_DIR,
	LEGACY_PACKAGE_NAME,
	legacyPackageProblem,
	offlineEnv,
	parseCdkDiff,
	parseHarnessArgs,
	protectedResources,
	type RpcOutcome,
	realModeRefusal,
	type SessionCookie,
	stackNameFor,
	USAGE,
	UsageError,
	upgradeRevisionErrors,
} from './upgrade-in-place/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PR_ROOT = resolve(HERE, '../../..');
const APP_TEMPLATE_DIR = join(HERE, 'upgrade-in-place', 'app');
/** Where the fixture app is materialized inside each checkout (gitignored). */
const MATERIALIZED_DIR = join('test-apps', '.upgrade-in-place');

type Variant = 'auth-cognito' | 'auth';

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

function heading(text: string): void {
	console.log(`\n━━━ ${text} ${'━'.repeat(Math.max(3, 76 - text.length))}`);
}

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}

class HarnessFailure extends Error {
	override name = 'HarnessFailure';
}

const checks: Check[] = [];

/** Where the run is, for the signal handler. */
type Phase = 'setup' | 'running' | 'cleanup';
let phase: Phase = 'setup';
let interruptCount = 0;

/** After a first Ctrl-C / SIGTERM, stop the run at the next step so the `finally` destroys the stack. */
function throwIfInterrupted(): void {
	if (phase === 'running' && interruptCount > 0) throw new HarnessFailure('interrupted');
}

/** Record an assertion. Returns `ok` so callers can branch. */
function record(name: string, ok: boolean, detail?: string): boolean {
	checks.push({ name, ok, ...(detail ? { detail } : {}) });
	console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
	return ok;
}

/** Record an assertion and abort the run (to the `finally`) when it fails. */
function must(name: string, ok: boolean, detail?: string): asserts ok {
	if (!record(name, ok, detail)) throw new HarnessFailure(name);
}

function printChecks(): void {
	heading('Summary');
	for (const c of checks) console.log(`${c.ok ? '  ✔' : '  ✘'} ${c.name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Child processes
// ─────────────────────────────────────────────────────────────────────────────

let currentChild: ChildProcess | undefined;

interface RunOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	/** Do not throw on a non-zero exit. */
	allowFailure?: boolean;
	/** Do not echo output (it is still captured). */
	quiet?: boolean;
}

interface RunResult {
	code: number | null;
	output: string;
}

/** Spawn a command, stream its output with a `[label]` prefix, and capture it. */
function run(label: string, command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
	return new Promise((resolvePromise, reject) => {
		if (phase === 'running' && interruptCount > 0) {
			reject(new HarnessFailure('interrupted'));
			return;
		}
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
		currentChild = child;
		const chunks: string[] = [];
		let pending = '';
		const onData = (data: Buffer) => {
			const text = data.toString('utf8');
			chunks.push(text);
			if (options.quiet) return;
			pending += text;
			const lines = pending.split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) console.log(`  [${label}] ${line}`);
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', (error) => {
			currentChild = undefined;
			reject(error);
		});
		child.on('close', (code) => {
			currentChild = undefined;
			if (pending && !options.quiet) console.log(`  [${label}] ${pending}`);
			const output = chunks.join('');
			if (code !== 0 && !options.allowFailure) {
				if (options.quiet) {
					for (const line of output.trimEnd().split('\n').slice(-60)) console.log(`  [${label}] ${line}`);
				}
				reject(new HarnessFailure(`${label}: \`${command} ${args.join(' ')}\` exited with ${code}`));
				return;
			}
			resolvePromise({ code, output });
		});
	});
}

function bin(treeRoot: string, name: 'cdk' | 'tsx'): string {
	return join(treeRoot, 'node_modules', '.bin', name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Checkouts and the fixture app
// ─────────────────────────────────────────────────────────────────────────────

interface BaseTree {
	root: string;
}

/** The worktree this run created, set the moment `git worktree add` succeeds, so a later failure still removes it. */
let createdBaseTree: string | undefined;

async function prepareBaseTree(opts: HarnessOptions, env: Record<string, string | undefined>): Promise<BaseTree> {
	if (opts.baseDir) {
		const root = resolve(opts.baseDir);
		assertLegacyPackage(root, `--base-dir ${root}`);
		console.log(`Using the existing base checkout ${root}`);
		if (!existsSync(join(root, 'node_modules'))) {
			await run('base npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], {
				cwd: root,
				env: { ...env, HUSKY: '0' },
			});
		}
		if (opts.build) await run('base build', 'npm', ['run', 'build'], { cwd: root, env, quiet: true });
		return { root };
	}
	const root = join(tmpdir(), `blocks-upgrade-base-${opts.suffix}-${process.pid}`);
	console.log(`Creating a worktree of ${opts.baseRef} at ${root}`);
	await run('git', 'git', ['-C', PR_ROOT, 'worktree', 'add', '--detach', root, opts.baseRef], { cwd: PR_ROOT, env });
	createdBaseTree = root;
	assertLegacyPackage(root, opts.baseRef);
	await run('base npm ci', 'npm', ['ci', '--no-audit', '--no-fund'], {
		cwd: root,
		env: { ...env, HUSKY: '0' },
		quiet: true,
	});
	await run('base build', 'npm', ['run', 'build'], { cwd: root, env, quiet: true });
	return { root };
}

/**
 * Refuse a base revision that doesn't ship `AuthCognito` (exit 2, before any
 * install or deploy): upgrading from it would compare `Auth` with itself.
 */
function assertLegacyPackage(root: string, revision: string): void {
	const file = join(root, LEGACY_PACKAGE_DIR, 'package.json');
	const manifest: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
	const problem = legacyPackageProblem(manifest, revision);
	if (problem) throw new UsageError(problem);
	const version = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'version') : undefined;
	console.log(`  ${revision} ships ${LEGACY_PACKAGE_NAME}@${String(version)}`);
}

/** Remove the worktree this run created (never a `--base-dir` checkout), unless `--keep-base`. */
async function removeCreatedBaseTree(opts: HarnessOptions): Promise<void> {
	const root = createdBaseTree;
	if (!root) return;
	if (opts.keepBase) {
		console.log(`Keeping the base worktree at ${root} (--keep-base).`);
		return;
	}
	await run('git', 'git', ['-C', PR_ROOT, 'worktree', 'remove', '--force', root], {
		cwd: PR_ROOT,
		env: process.env,
		allowFailure: true,
		quiet: true,
	});
	rmSync(root, { recursive: true, force: true });
	createdBaseTree = undefined;
}

/**
 * Copy the fixture app into `treeRoot/test-apps/.upgrade-in-place/<variant>/`.
 * Inside the checkout so every import resolves against THAT checkout's
 * `node_modules`; no package.json of its own, so `npx` inside `deploy()` finds
 * the checkout root's binaries.
 */
function materializeApp(treeRoot: string, variant: Variant): string {
	const dir = join(treeRoot, MATERIALIZED_DIR, variant);
	rmSync(dir, { recursive: true, force: true });
	for (const sub of ['aws-blocks', 'scripts', '.blocks']) mkdirSync(join(dir, sub), { recursive: true });
	copyFileSync(join(APP_TEMPLATE_DIR, 'index.cdk.ts'), join(dir, 'aws-blocks', 'index.cdk.ts'));
	// The BEFORE backend is stored as `.ts.txt`: it imports `@aws-blocks/bb-auth-cognito`, which
	// exists only in the pre-refactor checkout, so nothing in this workspace may compile or resolve it.
	const backend = variant === 'auth-cognito' ? 'backend.auth-cognito.ts.txt' : `backend.${variant}.ts`;
	copyFileSync(join(APP_TEMPLATE_DIR, backend), join(dir, 'aws-blocks', 'index.ts'));
	if (variant === 'auth-cognito') assertOldBlockFromBaseTree(dir, treeRoot);
	writeFileSync(
		join(dir, 'aws-blocks', 'index.handler.ts'),
		"import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';\n\n" +
			"export const handler = createLambdaHandler(() => import('./index.js'));\n",
	);
	copyFileSync(join(APP_TEMPLATE_DIR, 'deploy.ts'), join(dir, 'scripts', 'deploy.ts'));
	copyFileSync(join(APP_TEMPLATE_DIR, 'destroy.ts'), join(dir, 'scripts', 'destroy.ts'));
	writeFileSync(
		join(dir, 'cdk.json'),
		`${JSON.stringify({ app: `"${bin(treeRoot, 'tsx')}" -C cdk aws-blocks/index.cdk.ts` }, null, 2)}\n`,
	);
	writeFileSync(
		join(dir, '.blocks', 'config.json'),
		`${JSON.stringify({ stackId: 'bb-test-upgrade', telemetry: { enabled: false } }, null, 2)}\n`,
	);
	return dir;
}

/**
 * The BEFORE app must run the pre-refactor revision's `AuthCognito` — never a
 * copy reachable from the PR checkout (which no longer has the package). Resolve
 * it exactly as the materialized app will, and require the result to live in
 * the base tree.
 */
function assertOldBlockFromBaseTree(appDir: string, treeRoot: string): void {
	let resolved: string;
	try {
		resolved = realpathSync(createRequire(join(appDir, 'aws-blocks', 'index.ts')).resolve(LEGACY_PACKAGE_NAME));
	} catch (error) {
		throw new UsageError(
			`the pre-refactor app cannot resolve ${LEGACY_PACKAGE_NAME} from ${treeRoot} (run its npm ci + build): ${String(error)}`,
		);
	}
	const base = realpathSync(treeRoot);
	if (!resolved.startsWith(`${base}/`)) {
		throw new UsageError(`the pre-refactor app resolved ${LEGACY_PACKAGE_NAME} to ${resolved}, outside ${base}`);
	}
}

/** Env for `cdk synth` / `cdk diff` children: the cdk condition and the pinned stack suffix. */
function cdkEnv(base: Record<string, string | undefined>, suffix: string): Record<string, string | undefined> {
	return { ...base, NODE_OPTIONS: '--conditions=cdk', BLOCKS_STACK_SUFFIX: suffix, BLOCKS_STAGE: 'production' };
}

/**
 * Env for the `deploy()` / `destroy()` drivers: the pinned stack suffix and no
 * inherited `NODE_OPTIONS` — the scripts run under the default conditions and
 * set `--conditions=cdk` on the cdk CLI themselves, exactly as a customer's
 * `npm run deploy` does.
 */
function driverEnv(base: Record<string, string | undefined>, suffix: string): Record<string, string | undefined> {
	const { NODE_OPTIONS: _ignored, ...rest } = base;
	return { ...rest, BLOCKS_STACK_SUFFIX: suffix };
}

async function synth(
	label: string,
	appDir: string,
	treeRoot: string,
	suffix: string,
	env: Record<string, string | undefined>,
): Promise<{ template: CfnTemplate; path: string }> {
	const out = join(appDir, 'cdk.out');
	rmSync(out, { recursive: true, force: true });
	await run(
		label,
		bin(treeRoot, 'cdk'),
		['synth', '--quiet', '--context', `projectRoot=${appDir}`, '--output', out],
		{
			cwd: appDir,
			env,
		},
	);
	const path = join(out, `${stackNameFor(suffix)}.template.json`);
	return { template: JSON.parse(readFileSync(path, 'utf8')) as CfnTemplate, path };
}

/** `cdk diff` of the PR app — against `templatePath` offline, else against the live stack. */
async function cdkDiff(
	appDir: string,
	suffix: string,
	env: Record<string, string | undefined>,
	templatePath?: string,
): Promise<string> {
	const args = [
		'diff',
		stackNameFor(suffix),
		'--no-color',
		'--context',
		`projectRoot=${appDir}`,
		'--output',
		join(appDir, 'cdk.out.diff'),
		...(templatePath ? ['--template', templatePath] : []),
	];
	const { output } = await run('cdk diff', bin(PR_ROOT, 'cdk'), args, { cwd: appDir, env });
	return output;
}

function printContinuity(result: ContinuityResult): void {
	console.log('  Protected resources in the pre-upgrade template:');
	for (const r of result.before) {
		console.log(`    ${r.role.padEnd(15)} ${r.logicalId.padEnd(44)} ${r.type}  ${JSON.stringify(r.physicalName)}`);
	}
	for (const n of result.notes) console.log(`  note: ${n}`);
}

/** Run the step-3 assertions on a before/after template pair and a `cdk diff` output. */
function assertNoReplacement(before: CfnTemplate, after: CfnTemplate, diffText: string): void {
	const revisionErrors = upgradeRevisionErrors(before, after);
	must(
		'the BEFORE template is AuthCognito (a pool, no Auth guard) and the AFTER template is Auth',
		revisionErrors.length === 0,
		revisionErrors.join('\n'),
	);
	const continuity = compareContinuity(before, after);
	printContinuity(continuity);
	const continuityOk = record(
		'template continuity: pool, client, sessions and secret keep logical id, type and physical name; ' +
			'no service-immutable pool property changes',
		continuity.errors.length === 0,
		continuity.errors.join('\n'),
	);
	const changes = parseCdkDiff(diffText);
	const protectedIds = continuity.before.filter((r) => r.role === 'sessions' || r.role === 'session-secret');
	const violations = findDiffViolations(changes, {
		types: DIFF_PROTECTED_TYPES,
		logicalIds: protectedIds.map((r) => r.logicalId),
	});
	const touched = changes.filter(
		(c) =>
			(DIFF_PROTECTED_TYPES as readonly string[]).includes(c.type) ||
			protectedIds.some((r) => r.logicalId === c.logicalId),
	);
	console.log(`  cdk diff: ${changes.length} changed resource(s); on protected resources:`);
	for (const c of touched)
		console.log(`    ${c.line}${c.replacingProperties.length ? ` [${c.replacingProperties.join(', ')}]` : ''}`);
	if (touched.length === 0) console.log('    (none)');
	const diffOk = record(
		'cdk diff: no replacement, removal or addition of UserPool / UserPoolClient / sessions / secret',
		violations.length === 0,
		violations.join('\n'),
	);
	if (!continuityOk || !diffOk) throw new HarnessFailure('step 3: the upgrade would replace a protected resource');
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run
// ─────────────────────────────────────────────────────────────────────────────

async function runDryRun(opts: HarnessOptions): Promise<number> {
	const env = offlineEnv(process.env);
	const synthEnv = cdkEnv(env, opts.suffix);
	console.log(`Dry-run: no AWS. Child processes run without credentials. Suffix ${opts.suffix}.`);
	let failed = false;
	try {
		heading(`Prepare the pre-refactor revision (${opts.baseDir ?? opts.baseRef})`);
		const base = await prepareBaseTree(opts, env);
		if (opts.build) {
			heading('Build the PR revision');
			await run('pr build', 'npm', ['run', 'build'], { cwd: PR_ROOT, env, quiet: true });
		}
		const beforeApp = materializeApp(base.root, 'auth-cognito');
		const afterApp = materializeApp(PR_ROOT, 'auth');

		heading('Synthesize both revisions under --conditions=cdk');
		const before = await synth('synth AuthCognito', beforeApp, base.root, opts.suffix, synthEnv);
		const after = await synth('synth Auth', afterApp, PR_ROOT, opts.suffix, synthEnv);
		console.log(`  before: ${before.path}\n  after:  ${after.path}`);

		heading('Step 3 offline: no replacement (template continuity + cdk diff --template)');
		const diffText = await cdkDiff(afterApp, opts.suffix, synthEnv, before.path);
		assertNoReplacement(before.template, after.template, diffText);
	} catch (error) {
		failed = true;
		console.error(
			error instanceof HarnessFailure || error instanceof UsageError ? `\n✘ stopped: ${error.message}` : error,
		);
	} finally {
		await removeCreatedBaseTree(opts);
	}
	failed ||= checks.some((c) => !c.ok);
	printChecks();
	console.log(`\nUPGRADE_IN_PLACE_DRY_RUN=${failed ? 'FAIL' : 'PASS'}`);
	return failed ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Real mode: AWS
// ─────────────────────────────────────────────────────────────────────────────

/** The AWS calls the real mode makes. SDKs load lazily, so the dry-run never imports them. */
async function createAws(region: string) {
	const cfn = await import('@aws-sdk/client-cloudformation');
	const idp = await import('@aws-sdk/client-cognito-identity-provider');
	const ddb = await import('@aws-sdk/client-dynamodb');
	const ssm = await import('@aws-sdk/client-ssm');
	const sts = await import('@aws-sdk/client-sts');
	const cfnClient = new cfn.CloudFormationClient({ region });
	const idpClient = new idp.CognitoIdentityProviderClient({ region });
	const ddbClient = new ddb.DynamoDBClient({ region });
	const ssmClient = new ssm.SSMClient({ region });
	const stsClient = new sts.STSClient({ region });

	const stackStatus = async (stackName: string): Promise<string | null> => {
		try {
			const out = await cfnClient.send(new cfn.DescribeStacksCommand({ StackName: stackName }));
			return out.Stacks?.[0]?.StackStatus ?? null;
		} catch (error) {
			if (error instanceof Error && error.name === 'ValidationError' && /does not exist/.test(error.message)) {
				return null;
			}
			throw error;
		}
	};

	const physicalIds = async (stackName: string): Promise<Record<string, string>> => {
		const out = await cfnClient.send(new cfn.DescribeStackResourcesCommand({ StackName: stackName }));
		const ids: Record<string, string> = {};
		for (const r of out.StackResources ?? []) {
			if (r.LogicalResourceId && r.PhysicalResourceId) ids[r.LogicalResourceId] = r.PhysicalResourceId;
		}
		return ids;
	};

	return {
		async caller() {
			const out = await stsClient.send(new sts.GetCallerIdentityCommand({}));
			return { account: out.Account ?? '?', arn: out.Arn ?? '?' };
		},
		stackStatus,
		physicalIds,
		/** Poll until the stack is in no `*_IN_PROGRESS` state. `null` = it does not exist. */
		async waitForTerminal(stackName: string, timeoutMs = 45 * 60_000): Promise<string | null> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const status = await stackStatus(stackName);
				if (status === null || !status.endsWith('_IN_PROGRESS')) return status;
				if (Date.now() > deadline) return status;
				throwIfInterrupted();
				await new Promise((r) => setTimeout(r, 10_000));
			}
		},
		async liveTemplate(stackName: string): Promise<CfnTemplate> {
			const out = await cfnClient.send(
				new cfn.GetTemplateCommand({ StackName: stackName, TemplateStage: 'Original' }),
			);
			return JSON.parse(out.TemplateBody ?? '{}') as CfnTemplate;
		},
		async stackEvents(stackName: string, maxPages = 10) {
			const events: import('@aws-sdk/client-cloudformation').StackEvent[] = [];
			let token: string | undefined;
			for (let page = 0; page < maxPages; page++) {
				const out = await cfnClient.send(
					new cfn.DescribeStackEventsCommand({ StackName: stackName, NextToken: token }),
				);
				events.push(...(out.StackEvents ?? []));
				token = out.NextToken;
				if (!token) break;
			}
			return events;
		},
		async deleteStack(stackName: string) {
			await cfnClient.send(new cfn.DeleteStackCommand({ StackName: stackName }));
		},
		async seedUser(userPoolId: string, username: string, password: string) {
			await idpClient.send(
				new idp.AdminCreateUserCommand({
					UserPoolId: userPoolId,
					Username: username,
					MessageAction: idp.MessageActionType.SUPPRESS,
					UserAttributes: [
						{ Name: 'email', Value: `${username}@example.com` },
						{ Name: 'email_verified', Value: 'true' },
					],
				}),
			);
			await idpClient.send(
				new idp.AdminSetUserPasswordCommand({
					UserPoolId: userPoolId,
					Username: username,
					Password: password,
					Permanent: true,
				}),
			);
		},
		/** USER_PASSWORD_AUTH straight against Cognito: proves the user and password survived, runtime-independent. */
		async passwordSignIn(clientId: string, username: string, password: string): Promise<string | null> {
			try {
				const out = await idpClient.send(
					new idp.InitiateAuthCommand({
						ClientId: clientId,
						AuthFlow: idp.AuthFlowType.USER_PASSWORD_AUTH,
						AuthParameters: { USERNAME: username, PASSWORD: password },
					}),
				);
				return out.AuthenticationResult?.AccessToken
					? null
					: `unexpected challenge ${out.ChallengeName ?? '(none)'}`;
			} catch (error) {
				return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			}
		},
		async readIdentity(stackName: string, template: CfnTemplate, username: string): Promise<DeployedIdentity> {
			const prot = protectedResources(template);
			const byRole = (role: string) => {
				const r = prot.find((p) => p.role === role);
				if (!r) throw new HarnessFailure(`the deployed template has no '${role}' resource`);
				return r;
			};
			const ids = await physicalIds(stackName);
			const userPoolId = ids[byRole('pool').logicalId];
			const clientId = ids[byRole('client').logicalId];
			const sessionsTableName = ids[byRole('sessions').logicalId];
			const secret = byRole('session-secret').physicalName;
			const sessionSecretParameterName = Array.isArray(secret) ? secret[0] : String(secret);
			const pool = await idpClient.send(new idp.DescribeUserPoolCommand({ UserPoolId: userPoolId }));
			const table = await ddbClient.send(new ddb.DescribeTableCommand({ TableName: sessionsTableName }));
			const param = await ssmClient.send(
				new ssm.GetParameterCommand({ Name: sessionSecretParameterName, WithDecryption: true }),
			);
			const user = await idpClient.send(
				new idp.AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
			);
			return {
				userPoolId,
				userPoolCreatedAt: pool.UserPool?.CreationDate?.toISOString() ?? '?',
				clientId,
				sessionsTableName,
				sessionsTableId: table.Table?.TableId ?? '?',
				sessionSecretParameterName,
				sessionSecretValueHash: hashSecret(param.Parameter?.Value ?? ''),
				userSub: user.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? '?',
			};
		},
	};
}

type Aws = Awaited<ReturnType<typeof createAws>>;

interface RpcCall {
	outcome: RpcOutcome;
	httpStatus: number;
	setCookies: string[];
}

/** Call `api.<method>` on the deployed app; retries network errors and gateway 5xx (cold start, propagation). */
async function rpc(apiUrl: string, method: string, args: readonly unknown[], cookie?: SessionCookie): Promise<RpcCall> {
	throwIfInterrupted();
	let lastError: unknown;
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			const res = await fetch(apiUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}),
				},
				body: encodeRpcRequest('api', method, args, attempt),
				signal: AbortSignal.timeout(60_000),
			});
			if ([502, 503, 504].includes(res.status) && attempt < 4) {
				lastError = new Error(`HTTP ${res.status}`);
			} else {
				const body: unknown = await res.json().catch(() => null);
				return {
					outcome: decodeRpcResponse(body),
					httpStatus: res.status,
					setCookies: res.headers.getSetCookie(),
				};
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((r) => setTimeout(r, 5_000 * attempt));
	}
	throw new HarnessFailure(`api.${method}: no response after 4 attempts (${String(lastError)})`);
}

function describeOutcome(call: RpcCall): string {
	if (call.outcome.ok) return `HTTP ${call.httpStatus}, result ${JSON.stringify(call.outcome.result)}`;
	const { code, message, name } = call.outcome;
	const hint =
		code === 501
			? '\n(501: the Auth runtime is not implemented at this revision — rerun with --skip-runtime-checks for the CloudFormation half)'
			: code === 401
				? '\n(401: the session is not recognized — signed-in sessions did NOT survive the upgrade)'
				: '';
	return `HTTP ${call.httpStatus}, RPC error ${code} ${name ?? ''}: ${message}${hint}`;
}

function resultField(call: RpcCall, field: string): unknown {
	return call.outcome.ok && call.outcome.result && typeof call.outcome.result === 'object'
		? (call.outcome.result as Record<string, unknown>)[field]
		: undefined;
}

function readApiUrl(appDir: string, stackName: string): string {
	const outputs = JSON.parse(readFileSync(join(appDir, '.blocks-sandbox', 'outputs.json'), 'utf8')) as Record<
		string,
		Record<string, string>
	>;
	const url = outputs[stackName]?.ApiUrl;
	if (!url) throw new HarnessFailure(`no ApiUrl output for ${stackName} in ${appDir}/.blocks-sandbox/outputs.json`);
	return url;
}

function orphanBanner(stackName: string, region: string, account: string, status: string | null): void {
	const bar = '█'.repeat(78);
	console.error(
		[
			'',
			bar,
			'██  ORPHANED STACK — the upgrade-in-place stack was NOT deleted.',
			`██    stack:   ${stackName}`,
			`██    region:  ${region}`,
			`██    account: ${account}`,
			`██    status:  ${status ?? 'unknown'}`,
			'██  Delete it now:',
			`██    aws cloudformation delete-stack --stack-name ${stackName} --region ${region}`,
			bar,
			'',
		].join('\n'),
	);
}

/** Destroy the stack and verify it is gone. Falls back to DeleteStack if `destroy()` fails. */
async function destroyStack(
	aws: Aws,
	stackName: string,
	appDir: string,
	env: Record<string, string | undefined>,
): Promise<{ gone: boolean; status: string | null }> {
	heading(`Step 6: destroy ${stackName}`);
	let status = await aws.waitForTerminal(stackName);
	if (status === null || status === 'DELETE_COMPLETE') return { gone: true, status };
	const destroyed = await run('destroy', bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'destroy.ts')], {
		cwd: appDir,
		env,
		allowFailure: true,
	}).catch((error: unknown) => ({ code: 1, output: String(error) }));
	status = await aws.waitForTerminal(stackName);
	if (status !== null && status !== 'DELETE_COMPLETE') {
		console.error(`destroy() exited ${destroyed.code}; stack is ${status}. Retrying with DeleteStack…`);
		await aws.deleteStack(stackName).catch((error: unknown) => console.error(error));
		status = await aws.waitForTerminal(stackName);
	}
	return { gone: status === null || status === 'DELETE_COMPLETE', status };
}

function installSignalHandlers(onAbort: () => void): void {
	const handler = (signal: NodeJS.Signals) => {
		interruptCount++;
		if (phase === 'cleanup' && interruptCount === 1) {
			console.error(`\n${signal}: cleanup in progress (destroying the stack). Send again to abort cleanup.`);
			return;
		}
		if (interruptCount > 1) {
			onAbort();
			process.exit(130);
		}
		console.error(
			`\n${signal}: stopping and cleaning up — the stack will be destroyed. Send again to abort cleanup.`,
		);
		currentChild?.kill('SIGTERM');
	};
	process.on('SIGINT', handler);
	process.on('SIGTERM', handler);
}

async function runReal(opts: HarnessOptions): Promise<number> {
	const refusal = realModeRefusal(process.env);
	if (refusal) {
		console.error(refusal);
		return 2;
	}
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
	const stackName = stackNameFor(opts.suffix);
	const aws = await createAws(region);
	let account = '?';
	try {
		const who = await aws.caller();
		account = who.account;
		console.log(`AWS caller ${who.arn} (account ${who.account}), region ${region}. Stack ${stackName}.`);
	} catch (error) {
		console.error(`Refusing to deploy: the AWS credentials do not work (${String(error)}).`);
		return 2;
	}
	if ((await aws.stackStatus(stackName)) !== null) {
		console.error(
			`Refusing to deploy: stack ${stackName} already exists, so it was not created by this run and will not be ` +
				'touched. Delete it, or pick another suffix with --suffix.',
		);
		return 2;
	}

	const baseEnv: Record<string, string | undefined> = { ...process.env };
	const env = cdkEnv(baseEnv, opts.suffix);
	const deployEnv = driverEnv(baseEnv, opts.suffix);
	let destroyApp: string | undefined;
	let failed = false;
	let orphaned = false;
	installSignalHandlers(() => orphanBanner(stackName, region, account, 'unknown (cleanup aborted)'));

	try {
		phase = 'running';
		heading(`Prepare the pre-refactor revision (${opts.baseDir ?? opts.baseRef})`);
		const base = await prepareBaseTree(opts, baseEnv);
		if (opts.build) {
			heading('Build the PR revision');
			await run('pr build', 'npm', ['run', 'build'], { cwd: PR_ROOT, env: baseEnv, quiet: true });
		}
		const beforeApp = materializeApp(base.root, 'auth-cognito');
		const afterApp = materializeApp(PR_ROOT, 'auth');

		// ── Step 1 ──────────────────────────────────────────────────────────
		heading('Step 1: deploy the pre-refactor app (AuthCognito)');
		destroyApp = afterApp;
		await run('deploy AuthCognito', bin(base.root, 'tsx'), [join(beforeApp, 'scripts', 'deploy.ts')], {
			cwd: beforeApp,
			env: deployEnv,
		}).catch((error: unknown) => record('pre-refactor deploy succeeded', false, String(error)));
		const createStatus = await aws.waitForTerminal(stackName);
		must('pre-refactor stack is CREATE_COMPLETE', createStatus === 'CREATE_COMPLETE', `status: ${createStatus}`);
		const apiBefore = readApiUrl(beforeApp, stackName);

		// ── Step 2 ──────────────────────────────────────────────────────────
		heading('Step 2: seed a user, sign in, keep the cookie');
		const liveBefore = await aws.liveTemplate(stackName);
		const prot = protectedResources(liveBefore);
		const poolLogicalId = prot.find((r) => r.role === 'pool')?.logicalId ?? '';
		const userPoolId = (await aws.physicalIds(stackName))[poolLogicalId];
		must('the pre-refactor stack has a user pool', Boolean(userPoolId), `pool logical id '${poolLogicalId}'`);
		const username = `upgrade-user-${opts.suffix}`;
		const password = `Aa1!${randomBytes(18).toString('base64url')}`;
		await aws.seedUser(userPoolId, username, password);
		const signIn = await rpc(apiBefore, 'signIn', [username, password]);
		must(
			'sign-in through the AuthCognito app',
			resultField(signIn, 'status') === 'signedIn',
			describeOutcome(signIn),
		);
		const sessionCookie = extractSessionCookie(signIn.setCookies);
		if (!sessionCookie) {
			must('sign-in set a session cookie', false, `Set-Cookie: ${JSON.stringify(signIn.setCookies)}`);
		}
		record('sign-in set a session cookie', true, sessionCookie.name);
		const identityBefore = await aws.readIdentity(stackName, liveBefore, username);
		const whoBefore = await rpc(apiBefore, 'whoAmI', [], sessionCookie);
		must(
			'the cookie authenticates before the upgrade (requireAuth → seeded userSub)',
			resultField(whoBefore, 'userSub') === identityBefore.userSub,
			describeOutcome(whoBefore),
		);
		console.log(
			`  recorded: pool ${identityBefore.userPoolId}, client ${identityBefore.clientId}, sub ${identityBefore.userSub},\n` +
				`            table ${identityBefore.sessionsTableName} (${identityBefore.sessionsTableId}), ` +
				`secret ${identityBefore.sessionSecretParameterName}, cookie ${sessionCookie.name}`,
		);

		// ── Step 3 ──────────────────────────────────────────────────────────
		heading('Step 3: switch to Auth; cdk diff against the live stack shows no replacement');
		const after = await synth('synth Auth', afterApp, PR_ROOT, opts.suffix, env);
		const diffText = await cdkDiff(afterApp, opts.suffix, env);
		assertNoReplacement(liveBefore, after.template, diffText);

		// ── Step 4 ──────────────────────────────────────────────────────────
		heading('Step 4: deploy Auth in place (same suffix, no destroy)');
		let upgradeError: unknown;
		await run('deploy Auth', bin(PR_ROOT, 'tsx'), [join(afterApp, 'scripts', 'deploy.ts')], {
			cwd: afterApp,
			env: deployEnv,
		}).catch((error: unknown) => {
			upgradeError = error;
		});
		const updateStatus = await aws.waitForTerminal(stackName);
		if (updateStatus !== 'UPDATE_COMPLETE') {
			const report = extractUpdateFailures(await aws.stackEvents(stackName), stackName);
			must('upgrade deploy reached UPDATE_COMPLETE', false, formatUpdateFailureReport(report, stackName));
		}
		record(
			'upgrade deploy reached UPDATE_COMPLETE (not UPDATE_ROLLBACK_COMPLETE)',
			true,
			`status: ${updateStatus}`,
		);
		must('upgrade deploy() exited cleanly', upgradeError === undefined, String(upgradeError ?? ''));
		const apiAfter = readApiUrl(afterApp, stackName);

		// ── Step 5 ──────────────────────────────────────────────────────────
		heading('Step 5: identity, users and sessions survived');
		const identityAfter = await aws.readIdentity(stackName, await aws.liveTemplate(stackName), username);
		const identityDiff = compareDeployedIdentity(identityBefore, identityAfter);
		record(
			'userPoolId, client, sessions table (name + id), secret (name + value) and userSub are unchanged',
			identityDiff.length === 0,
			identityDiff.join('\n'),
		);
		const direct = await aws.passwordSignIn(identityAfter.clientId, username, password);
		record('seeded user still signs in against Cognito (USER_PASSWORD_AUTH)', direct === null, direct ?? undefined);
		if (opts.skipRuntimeChecks) {
			console.log('  --skip-runtime-checks: not checking the pre-upgrade cookie or app sign-in through Auth.');
		} else {
			const whoAfter = await rpc(apiAfter, 'whoAmI', [], sessionCookie);
			record(
				'the PRE-UPGRADE cookie is still valid (requireAuth → same userSub)',
				resultField(whoAfter, 'userSub') === identityBefore.userSub,
				describeOutcome(whoAfter),
			);
			const signInAfter = await rpc(apiAfter, 'signIn', [username, password]);
			record(
				'seeded user signs in through the Auth app',
				resultField(signInAfter, 'status') === 'signedIn' &&
					resultField(signInAfter, 'userSub') === identityBefore.userSub,
				describeOutcome(signInAfter),
			);
		}
	} catch (error) {
		failed = true;
		console.error(error instanceof HarnessFailure ? `\n✘ stopped: ${error.message}` : error);
	} finally {
		phase = 'cleanup';
		try {
			// Only a stack this run started deploying is ever destroyed.
			if (destroyApp) {
				const result = await destroyStack(aws, stackName, destroyApp, deployEnv);
				if (!result.gone) {
					orphaned = true;
					orphanBanner(stackName, region, account, result.status);
				} else {
					console.log(`  ✔ ${stackName} is deleted.`);
				}
			}
		} catch (error) {
			orphaned = true;
			console.error(error);
			orphanBanner(stackName, region, account, 'unknown (status check failed)');
		}
		await removeCreatedBaseTree(opts).catch((error: unknown) => console.error(error));
	}

	failed ||= checks.some((c) => !c.ok);
	printChecks();
	const verdict = failed ? 'FAIL' : opts.skipRuntimeChecks ? 'PARTIAL' : 'PASS';
	console.log(`\nUPGRADE_IN_PLACE_RESULT=${verdict} stack=${stackName}${orphaned ? ' orphaned=true' : ''}`);
	if (orphaned) return 3;
	return failed ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
	let opts: HarnessOptions;
	try {
		opts = parseHarnessArgs(process.argv.slice(2), process.env);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`${error.message}\n\n${USAGE}`);
			return 2;
		}
		throw error;
	}
	if (opts.help) {
		console.log(USAGE);
		return 0;
	}
	try {
		return opts.mode === 'dry-run' ? await runDryRun(opts) : await runReal(opts);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			return 2;
		}
		throw error;
	}
}

process.exitCode = await main();
