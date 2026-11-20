// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * UPGRADE E2E, LegacyKVStore — proves that an app with `KVStore` stores of the
 * last release before the item layout changed (0.4.0) reaches this checkout
 * with `LegacyKVStore`, on AWS. Three deploys on one stack:
 *
 * 1. the fixture app on release 0.4.0 (`app/backend.kv-release.ts.txt`);
 * 2. the same app on this checkout: each old store is a `LegacyKVStore` with
 *    the same id and options, beside a `KVStore` with a new id
 *    (`app/backend.kv-legacy.ts.txt`);
 * 3. the app of deploy 2 without its `LegacyKVStore` lines.
 *
 * ## How to run
 *
 * From `test-apps/comprehensive`, after `npm run build` at the repo root and
 * in a built checkout of the release (`git worktree add <dir> @aws-blocks/bb-kv-store@0.4.0` —
 * the tag predates the rename, so it carries the old scope):
 *
 *     npm run test:upgrade-legacy-kv-store -- --mode options --base-dir <release checkout> --evidence <dir>
 *     BLOCKS_UPGRADE_E2E=1 AWS_PROFILE=<sandbox> AWS_REGION=<region> \
 *         npm run test:upgrade-legacy-kv-store -- --mode upgrade --base-dir <release checkout> --evidence <dir>
 *
 * - `--mode options` (offline): for each option combination of release 0.4.0,
 *   under both presets, `cdk diff` shows that deploy 2 does not change the old
 *   table, and what deploy 3 does to it.
 * - `--mode upgrade`: deploy 2 leaves each old table as it is (the same
 *   `TableId`, the same items). The app reads every value of the release
 *   through `LegacyKVStore`, copies the items in app code, deletes a key in
 *   both stores, and reads every value from the new stores. Deploy 3 removes
 *   the old tables from the stack.
 *
 * The AWS mode refuses to start unless `BLOCKS_UPGRADE_E2E=1`, `AWS_REGION` and
 * an explicit credential source are set. It takes about 15 minutes. It is
 * long-running: start it in the background and read the log for the final
 * `UPGRADE_LEGACY_KV_STORE_RESULT=` line. **Cleanup:** the stack is destroyed
 * in a `finally`, and so are the tables of the fixture that outlive it. It
 * never deploys into a stack that exists.
 *
 * A run writes its report files in `--evidence`. It writes the fixture apps
 * under `test-apps/.upgrade-in-place/` in both checkouts, and removes them at
 * the end.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type CfnTemplate,
	decodeRpcResponse,
	encodeRpcRequest,
	offlineEnv,
	parseCdkDiff,
	realModeRefusal,
	SCOPE_ID,
	SUFFIX_PATTERN,
	stableStringify,
	stackNameFor,
	type BlocksNames,
	blocksNamesFromUmbrella,
	retargetBlocksImports,
} from './upgrade-in-place/lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PR_ROOT = resolve(HERE, '../../..');
const APP = join(HERE, 'upgrade-in-place', 'app');
const TABLE_TYPE = 'AWS::DynamoDB::Table';
const FIXTURE = ['strings', 'docs', 'profiles', 'expiring'] as const;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}
const mode = arg('--mode') ?? 'options';
const baseDir = arg('--base-dir');
const evidenceDir = arg('--evidence');
// Two runs that start in the same millisecond must not share a stack: the process id is in the name.
const suffix = arg('--suffix') ?? `upgrade-lk${Date.now().toString(36)}p${process.pid.toString(36)}`;
const MODES = ['options', 'upgrade'];
if (!MODES.includes(mode) || !baseDir || !evidenceDir || !SUFFIX_PATTERN.test(suffix)) {
	console.error(`usage: upgrade-legacy-kv-store.ts --mode ${MODES.join('|')} --base-dir <dir> --evidence <dir> [--suffix upgrade-…]`);
	process.exit(2);
}
const BASE_ROOT = resolve(baseDir);
const EVIDENCE = resolve(evidenceDir);
mkdirSync(EVIDENCE, { recursive: true });
const stackName = stackNameFor(suffix);

// ── Output ───────────────────────────────────────────────────────────────────

const checks: { name: string; ok: boolean; detail?: string }[] = [];
class HarnessFailure extends Error {}
const heading = (text: string) => console.log(`\n━━━ ${text} ${'━'.repeat(Math.max(3, 76 - text.length))}`);
function record(name: string, ok: boolean, detail?: string): boolean {
	checks.push({ name, ok, ...(detail ? { detail } : {}) });
	console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `\n      ${detail.split('\n').join('\n      ')}` : ''}`);
	return ok;
}
function must(name: string, ok: boolean, detail?: string): asserts ok {
	if (!record(name, ok, detail)) throw new HarnessFailure(name);
}
/** A fact that is recorded, not judged. */
const note = (text: string) => console.log(`  · ${text}`);
function save(name: string, content: unknown): void {
	writeFileSync(join(EVIDENCE, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Child processes ──────────────────────────────────────────────────────────

let currentChild: ChildProcess | undefined;
let interrupted = false;
type Env = Record<string, string | undefined>;

function run(label: string, command: string, args: readonly string[], options: { cwd: string; env: Env; quiet?: boolean }) {
	return new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
		if (interrupted) return reject(new HarnessFailure('interrupted'));
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
		currentChild = child;
		const chunks: string[] = [];
		const onData = (data: Buffer) => {
			const text = data.toString('utf8');
			chunks.push(text);
			if (!options.quiet) process.stdout.write(text.replace(/^/gm, `  [${label}] `));
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('error', reject);
		child.on('close', (code) => {
			currentChild = undefined;
			const output = chunks.join('');
			if (code !== 0) {
				if (options.quiet) console.log(output.trimEnd().split('\n').slice(-40).join('\n'));
				return reject(new HarnessFailure(`${label}: exited with ${code}`));
			}
			resolvePromise({ code, output });
		});
	});
}
const bin = (treeRoot: string, name: 'cdk' | 'tsx') => join(treeRoot, 'node_modules', '.bin', name);

// ── The fixture app ──────────────────────────────────────────────────────────

/** The fixture apps of this run, in both checkouts. */
const fixtureApps: string[] = [];
function removeFixtureApps(): void {
	for (const dir of fixtureApps) rmSync(dir, { recursive: true, force: true });
}

/**
 * What `treeRoot` calls this repo's packages, from its own umbrella manifest.
 * The 0.4.0 base revision predates the rename, so this differs per tree.
 */
function blocksNamesIn(treeRoot: string): BlocksNames {
	const manifest = join(treeRoot, 'packages', 'blocks', 'package.json');
	const name: unknown = JSON.parse(readFileSync(manifest, 'utf8')).name;
	if (typeof name !== 'string' || name === '') throw new Error(`${manifest} states no package name`);
	return blocksNamesFromUmbrella(name);
}

/**
 * Write a fixture app into a checkout. `withoutLegacy` drops the lines of the
 * backend that end with `// legacy`: the app of the third deploy.
 */
function materialize(treeRoot: string, variant: string, backend: string, preset: 'sandbox' | 'production' = 'sandbox', withoutLegacy = false): string {
	const dir = join(treeRoot, 'test-apps', '.upgrade-in-place', `${suffix}-${variant}`);
	// One copy of each fixture is written into BOTH checkouts, and the 0.4.0 base revision
	// predates the rename, so every specifier is retargeted to the names that tree publishes.
	const names = blocksNamesIn(treeRoot);
	const retarget = (text: string): string => retargetBlocksImports(text, names);
	rmSync(dir, { recursive: true, force: true });
	fixtureApps.push(dir);
	for (const sub of ['cdk-blocks', 'scripts', '.cdk-blocks']) mkdirSync(join(dir, sub), { recursive: true });
	const cdkEntry = readFileSync(join(APP, 'index.cdk.ts'), 'utf8').replace('BlocksPresets.sandbox', `BlocksPresets.${preset}`);
	writeFileSync(join(dir, 'cdk-blocks', 'index.cdk.ts'), retarget(cdkEntry));
	const source = readFileSync(join(APP, backend), 'utf8');
	writeFileSync(join(dir, 'cdk-blocks', 'index.ts'), retarget(withoutLegacy ? source.replace(/^.*\/\/ legacy\n/gm, '') : source));
	writeFileSync(
		join(dir, 'cdk-blocks', 'index.handler.ts'),
		retarget(
			"import { createLambdaHandler } from 'aws-cdk-blocks/lambda-handler';\n\nexport const handler = createLambdaHandler(() => import('./index.js'));\n",
		),
	);
	writeFileSync(join(dir, 'scripts', 'deploy.ts'), retarget(readFileSync(join(APP, 'deploy.ts'), 'utf8')));
	writeFileSync(join(dir, 'scripts', 'destroy.ts'), retarget(readFileSync(join(APP, 'destroy.ts'), 'utf8')));
	writeFileSync(join(dir, 'cdk.json'), `${JSON.stringify({ app: `"${bin(treeRoot, 'tsx')}" -C cdk cdk-blocks/index.cdk.ts` }, null, 2)}\n`);
	writeFileSync(join(dir, '.cdk-blocks', 'config.json'), `${JSON.stringify({ stackId: 'bb-test-upgrade', telemetry: { enabled: false } }, null, 2)}\n`);
	return dir;
}

const cdkEnv = (base: Env): Env => ({ ...base, NODE_OPTIONS: '--conditions=cdk', BLOCKS_STACK_SUFFIX: suffix, BLOCKS_STAGE: 'production' });
function driverEnv(base: Env): Env {
	const { NODE_OPTIONS: _ignored, ...rest } = base;
	return { ...rest, BLOCKS_STACK_SUFFIX: suffix };
}

async function synth(appDir: string, treeRoot: string, env: Env) {
	const out = join(appDir, 'cdk.out');
	rmSync(out, { recursive: true, force: true });
	await run('synth', bin(treeRoot, 'cdk'), ['synth', '--quiet', '--context', `projectRoot=${appDir}`, '--output', out], { cwd: appDir, env, quiet: true });
	const path = join(out, `${stackName}.template.json`);
	return { template: JSON.parse(readFileSync(path, 'utf8')) as CfnTemplate, path };
}

async function cdkDiff(appDir: string, env: Env, templatePath?: string): Promise<string> {
	const args = ['diff', stackName, '--no-color', '--context', `projectRoot=${appDir}`, '--output', join(appDir, 'cdk.out.diff'), ...(templatePath ? ['--template', templatePath] : [])];
	return (await run('cdk diff', bin(PR_ROOT, 'cdk'), args, { cwd: appDir, env, quiet: true })).output;
}

/** The table resources of a template by table name. */
function tablesByName(template: CfnTemplate): Record<string, { logicalId: string; resource: unknown }> {
	const out: Record<string, { logicalId: string; resource: unknown }> = {};
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		if (resource.Type !== TABLE_TYPE) continue;
		const name = String((resource.Properties as { TableName?: string } | undefined)?.TableName ?? logicalId);
		out[name] = { logicalId, resource };
	}
	return out;
}

/** The resources that failed in a deploy, without those that CloudFormation cancelled because another one failed. */
const failedResources = (events: { status: string; id: string; reason?: string }[]) =>
	events.filter((e) => e.status.endsWith('FAILED') && !/cancelled|following resource/.test(e.reason ?? '')).map((e) => `${e.id}: ${e.reason}`);

/** What CloudFormation acts on for a table: its properties and its two policies. */
const declaration = (resource: unknown) => {
	const { Properties, DeletionPolicy, UpdateReplacePolicy } = (resource ?? {}) as Record<string, unknown>;
	return { Properties, DeletionPolicy, UpdateReplacePolicy };
};

// ── Mode options: the old table for each option combination, offline ─────────

async function runOptions(): Promise<number> {
	const result: Record<string, unknown> = {};
	for (const preset of ['sandbox', 'production'] as const) {
		heading(`Option combinations, ${preset} preset`);
		const env = cdkEnv(offlineEnv(process.env));
		const release = await synth(materialize(BASE_ROOT, `o-release-${preset}`, 'backend.kv-options-release.ts.txt', preset), BASE_ROOT, env);
		const legacyApp = materialize(PR_ROOT, `o-legacy-${preset}`, 'backend.kv-options-legacy.ts.txt', preset);
		const legacy = await synth(legacyApp, PR_ROOT, env);
		const finalApp = materialize(PR_ROOT, `o-final-${preset}`, 'backend.kv-options-legacy.ts.txt', preset, true);
		const upgradeDiff = await cdkDiff(legacyApp, env, release.path);
		const removalDiff = await cdkDiff(finalApp, env, legacy.path);
		save(`options-${preset}-upgrade-diff.txt`, upgradeDiff);
		save(`options-${preset}-removal-diff.txt`, removalDiff);
		const oldTables = tablesByName(release.template);
		const declared = tablesByName(legacy.template);
		const upgradeChanges = parseCdkDiff(upgradeDiff);
		const removalChanges = parseCdkDiff(removalDiff);
		const rows: Record<string, unknown> = {};
		for (const [name, { logicalId, resource }] of Object.entries(oldTables)) {
			const now = declared[name];
			const store = name.slice(`${stackName}-${SCOPE_ID}-`.length);
			const change = upgradeChanges.find((c) => c.logicalId === logicalId);
			const removal = removalChanges.find((c) => c.logicalId === logicalId);
			const policy = (resource as { DeletionPolicy?: string }).DeletionPolicy;
			const equal = same(declaration(resource), declaration(now?.resource));
			rows[store] = {
				sameLogicalId: now?.logicalId === logicalId,
				sameDeclaration: equal,
				changeInUpgradeDeploy: change?.line ?? null,
				deletionPolicy: policy,
				thirdDeploy: removal ? `${removal.action}${removal.impact === 'none' ? '' : ` (${removal.impact})`}` : 'no change',
			};
			record(
				`${preset} ${store}: the old table keeps its logical id, and the upgrade deploy does not change it`,
				now?.logicalId === logicalId && equal && change === undefined,
				`${change?.line ?? '(no change)'}\n third deploy: ${removal?.line ?? 'no change'}  (DeletionPolicy ${policy})`,
			);
		}
		// Anything else that the upgrade deploy changes or removes: the policy of the app role, which loses the write actions.
		const other = upgradeChanges.filter((c) => c.action !== 'add' && !Object.values(oldTables).some((t) => t.logicalId === c.logicalId));
		note(`other resources changed or removed by the upgrade deploy: ${other.map((c) => c.line).join(' | ') || 'none'}`);
		result[preset] = { oldTables: rows, otherChanges: other.map((c) => c.line) };
	}
	save('options.json', result);
	return checks.some((c) => !c.ok) ? 1 : 0;
}

// ── AWS ──────────────────────────────────────────────────────────────────────

async function createAws(region: string) {
	const cfn = await import('@aws-sdk/client-cloudformation');
	const ddb = await import('@aws-sdk/client-dynamodb');
	const sts = await import('@aws-sdk/client-sts');
	const cfnClient = new cfn.CloudFormationClient({ region, maxAttempts: 10 });
	const ddbClient = new ddb.DynamoDBClient({ region, maxAttempts: 12, retryMode: 'adaptive' });
	const stsClient = new sts.STSClient({ region });

	const stackStatus = async (): Promise<string | null> => {
		try {
			return (await cfnClient.send(new cfn.DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0]?.StackStatus ?? null;
		} catch (error) {
			if (error instanceof Error && error.name === 'ValidationError' && /does not exist/.test(error.message)) return null;
			throw error;
		}
	};
	const tableExists = async (name: string): Promise<boolean> => {
		try {
			await ddbClient.send(new ddb.DescribeTableCommand({ TableName: name }));
			return true;
		} catch (error) {
			if (error instanceof Error && error.name === 'ResourceNotFoundException') return false;
			throw error;
		}
	};
	return {
		tableExists,
		async caller() {
			const out = await stsClient.send(new sts.GetCallerIdentityCommand({}));
			return { account: out.Account ?? '?' };
		},
		stackStatus,
		async waitForTerminal(): Promise<string | null> {
			const deadline = Date.now() + 60 * 60_000;
			for (;;) {
				const status = await stackStatus();
				if (status === null || !status.endsWith('_IN_PROGRESS') || Date.now() > deadline) return status;
				await sleep(10_000);
			}
		},
		async liveTemplate(): Promise<CfnTemplate> {
			const out = await cfnClient.send(new cfn.GetTemplateCommand({ StackName: stackName, TemplateStage: 'Original' }));
			return JSON.parse(out.TemplateBody ?? '{}') as CfnTemplate;
		},
		/** Logical id → physical name of every table in the stack. */
		async tables(): Promise<Record<string, string>> {
			const ids: Record<string, string> = {};
			for await (const page of cfn.paginateListStackResources({ client: cfnClient }, { StackName: stackName })) {
				for (const r of page.StackResourceSummaries ?? []) {
					if (r.ResourceType === TABLE_TYPE && r.LogicalResourceId && r.PhysicalResourceId) ids[r.LogicalResourceId] = r.PhysicalResourceId;
				}
			}
			return ids;
		},
		/** Stack events at or after `since`, oldest first. */
		async eventsSince(since: number) {
			const events: { at: string; id: string; type: string; status: string; reason?: string }[] = [];
			let token: string | undefined;
			for (let page = 0; page < 30; page++) {
				const out = await cfnClient.send(new cfn.DescribeStackEventsCommand({ StackName: stackName, NextToken: token }));
				let older = false;
				for (const e of out.StackEvents ?? []) {
					if ((e.Timestamp?.getTime() ?? 0) < since) {
						older = true;
						break;
					}
					events.push({ at: e.Timestamp?.toISOString() ?? '', id: e.LogicalResourceId ?? '', type: e.ResourceType ?? '', status: e.ResourceStatus ?? '', ...(e.ResourceStatusReason ? { reason: e.ResourceStatusReason } : {}) });
				}
				token = out.NextToken;
				if (older || !token) break;
			}
			return events.reverse();
		},
		async deleteStack(): Promise<void> {
			await cfnClient.send(new cfn.DeleteStackCommand({ StackName: stackName }));
		},
		async describeTable(name: string) {
			const table = (await ddbClient.send(new ddb.DescribeTableCommand({ TableName: name }))).Table;
			const ttl = await ddbClient.send(new ddb.DescribeTimeToLiveCommand({ TableName: name }));
			return {
				TableName: table?.TableName,
				TableId: table?.TableId,
				CreationDateTime: table?.CreationDateTime?.toISOString(),
				KeySchema: table?.KeySchema,
				GlobalSecondaryIndexes: (table?.GlobalSecondaryIndexes ?? []).map((i) => i.IndexName),
				StreamSpecification: table?.StreamSpecification ?? null,
				TimeToLive: ttl.TimeToLiveDescription,
			};
		},
		/** Every item of an old table as DynamoDB stores it, sorted by `pk`. */
		async rawScan(name: string): Promise<Record<string, { S?: string; N?: string }>[]> {
			const items: Record<string, { S?: string; N?: string }>[] = [];
			let start: Record<string, unknown> | undefined;
			do {
				// biome-ignore lint/suspicious/noExplicitAny: ExclusiveStartKey is the LastEvaluatedKey of the previous page
				const out = await ddbClient.send(new ddb.ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: start as any }));
				items.push(...((out.Items ?? []) as Record<string, { S?: string; N?: string }>[]));
				start = out.LastEvaluatedKey;
			} while (start);
			return items.sort((a, b) => ((a.pk?.S ?? '') < (b.pk?.S ?? '') ? -1 : 1));
		},
		async deleteTableIfExists(name: string): Promise<boolean> {
			if (!(await tableExists(name))) return false;
			await ddbClient.send(new ddb.DeleteTableCommand({ TableName: name }));
			return true;
		},
	};
}
type Aws = Awaited<ReturnType<typeof createAws>>;

async function rpc(apiUrl: string, method: string, args: readonly unknown[] = []): Promise<unknown> {
	const retries = 4;
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const res = await fetch(apiUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encodeRpcRequest('api', method, args, attempt), signal: AbortSignal.timeout(90_000) });
			if (![502, 503, 504].includes(res.status) || attempt === retries) {
				const outcome = decodeRpcResponse(await res.json().catch(() => null));
				if (outcome.ok) return outcome.result;
				throw new HarnessFailure(`api.${method}: RPC error ${outcome.code} ${outcome.name ?? ''}: ${outcome.message}`);
			}
			lastError = new Error(`HTTP ${res.status}`);
		} catch (error) {
			if (error instanceof HarnessFailure) throw error;
			lastError = error;
		}
		await sleep(3_000 * attempt);
	}
	throw new HarnessFailure(`api.${method}: no response after ${retries} attempts (${String(lastError)})`);
}

function readApiUrl(appDir: string): string {
	for (const doc of ['outputs.production.json', 'outputs.json']) {
		const path = join(appDir, '.cdk-blocks-sandbox', doc);
		if (!existsSync(path)) continue;
		const url = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>)[stackName]?.ApiUrl;
		if (url) return url;
	}
	throw new HarnessFailure(`no ApiUrl output for ${stackName} in ${appDir}`);
}

// ── Deploys ──────────────────────────────────────────────────────────────────

interface Ctx {
	aws: Aws;
	env: Env;
	deployEnv: Env;
	legacyApp: string;
	finalApp: string;
	apiUrl: string;
}

async function deployRelease(aws: Aws, baseEnv: Env): Promise<Ctx> {
	const releaseApp = materialize(BASE_ROOT, 'release', 'backend.kv-release.ts.txt');
	const legacyApp = materialize(PR_ROOT, 'legacy', 'backend.kv-legacy.ts.txt');
	const finalApp = materialize(PR_ROOT, 'final', 'backend.kv-legacy.ts.txt', 'sandbox', true);
	const deployEnv = driverEnv(baseEnv);
	heading('Deploy 1: the app on release 0.4.0');
	await run('deploy release', bin(BASE_ROOT, 'tsx'), [join(releaseApp, 'scripts', 'deploy.ts')], { cwd: releaseApp, env: deployEnv, quiet: true }).catch((error: unknown) => record('release deploy succeeded', false, String(error)));
	const status = await aws.waitForTerminal();
	must('release stack is CREATE_COMPLETE', status === 'CREATE_COMPLETE', `status: ${status}`);
	return { aws, env: cdkEnv(baseEnv), deployEnv, legacyApp, finalApp, apiUrl: readApiUrl(releaseApp) };
}

/** Deploy an app of this checkout on the stack. Returns the status and the stack events of the deploy. */
async function deployCheckout(ctx: Ctx, label: string, appDir: string) {
	const started = Date.now();
	// A deploy that fails is read from the stack status and the events below.
	await run(label, bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'deploy.ts')], { cwd: appDir, env: ctx.deployEnv, quiet: true }).catch(() => undefined);
	const status = await ctx.aws.waitForTerminal();
	const events = await ctx.aws.eventsSince(started - 5_000);
	return { status, events };
}

const oldName = (store: string) => `${stackName}-${SCOPE_ID}-${store}`;
const newName = (store: string) => `${stackName}-${SCOPE_ID}-${store}-v2`;

/** One value for each store of the fixture. */
async function eachStore<T>(of: (store: (typeof FIXTURE)[number]) => Promise<T>): Promise<Record<string, T>> {
	return Object.fromEntries(await Promise.all(FIXTURE.map(async (store) => [store, await of(store)] as const)));
}

async function destroy(aws: Aws, appDir: string, deployEnv: Env): Promise<boolean> {
	heading(`Destroy ${stackName}`);
	let status = await aws.waitForTerminal();
	if (status !== null && status !== 'DELETE_COMPLETE') {
		interrupted = false;
		await run('destroy', bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'destroy.ts')], { cwd: appDir, env: deployEnv, quiet: true }).catch((e: unknown) => console.error(e));
		status = await aws.waitForTerminal();
		if (status !== null && status !== 'DELETE_COMPLETE') {
			await aws.deleteStack().catch((e: unknown) => console.error(e));
			status = await aws.waitForTerminal();
		}
	}
	const gone = status === null || status === 'DELETE_COMPLETE';
	console.log(gone ? `  ✔ ${stackName} is deleted.` : `  ✘ STACK LEFT BEHIND: ${stackName}, status ${status}`);
	// The fixture declares the old `docs` store with `removalPolicy: 'retain'`, so its table outlives the stack. These are this run's own tables.
	for (const name of FIXTURE.flatMap((store) => [oldName(store), newName(store)])) {
		if (await aws.deleteTableIfExists(name)) console.log(`  ✔ deleted the test table ${name}`);
	}
	return gone;
}

// ── Mode: upgrade ────────────────────────────────────────────────────────────

type Dump = Record<string, { key: string; value: unknown }[]>;

async function runUpgrade(ctx: Ctx): Promise<void> {
	const { aws } = ctx;
	heading('Seed the stores of the release');
	must('seed', (await rpc(ctx.apiUrl, 'seed')) === 'seeded');
	await sleep(3_000);
	const dumpBefore = (await rpc(ctx.apiUrl, 'dump')) as Dump;
	const rawBefore = await eachStore((store) => aws.rawScan(oldName(store)));
	const describeBefore = await eachStore((store) => aws.describeTable(oldName(store)));
	save('dump-before.json', dumpBefore);
	save('raw-old-before.json', rawBefore);
	save('describe-old-before.json', describeBefore);
	const tablesBefore = await aws.tables();

	heading('Deploy 2: a LegacyKVStore for each old store, and a KVStore with a new id');
	const liveBefore = await aws.liveTemplate();
	const legacy = await synth(ctx.legacyApp, PR_ROOT, ctx.env);
	const diffText = await cdkDiff(ctx.legacyApp, ctx.env);
	save('upgrade-cdk-diff.txt', diffText);
	const upgradeChanges = parseCdkDiff(diffText);
	for (const [name, { logicalId }] of Object.entries(tablesByName(liveBefore))) {
		const change = upgradeChanges.find((c) => c.logicalId === logicalId);
		record(`cdk diff: no change to the table of ${name.slice(`${stackName}-${SCOPE_ID}-`.length)}`, change === undefined && tablesByName(legacy.template)[name]?.logicalId === logicalId, change?.line ?? '(no change)');
	}
	const upgrade = await deployCheckout(ctx, 'deploy upgrade', ctx.legacyApp);
	save('upgrade-events.json', upgrade.events);
	must('the upgrade deploy reached UPDATE_COMPLETE', upgrade.status === 'UPDATE_COMPLETE', `status: ${upgrade.status}\n${failedResources(upgrade.events).join('\n')}`);
	const oldTableEvents = upgrade.events.filter((e) => e.type === TABLE_TYPE && e.id in tablesBefore);
	record('CloudFormation did not update the old tables', oldTableEvents.length === 0, oldTableEvents.map((e) => `${e.id} ${e.status}`).join(', '));
	record('each old table has the same TableId and the same settings', same(describeBefore, await eachStore((store) => aws.describeTable(oldName(store)))));
	record('the items of the old tables are unchanged', same(rawBefore, await eachStore((store) => aws.rawScan(oldName(store)))));

	heading('Read the old stores through LegacyKVStore');
	const dumpOld = await rpc(ctx.apiUrl, 'dumpOld');
	save('dump-old.json', dumpOld);
	record('LegacyKVStore reads back every value of the release, equal', same(dumpBefore, dumpOld));
	const paged: string[] = [];
	let cursor: string | null = null;
	let pages = 0;
	do {
		const page = (await rpc(ctx.apiUrl, 'oldPage', cursor === null ? [2] : [2, cursor])) as { keys: string[]; cursor: string | null };
		paged.push(...page.keys);
		cursor = page.cursor;
		pages++;
	} while (cursor !== null && pages < 20);
	record('a scan in pages of two, with the cursor, reads every key once', same([...paged].sort(), dumpBefore.strings.map((e) => e.key)), `${pages} pages: ${paged.join(', ')}`);
	const empty = { strings: [], docs: [], profiles: [], expiring: [] };
	record('the new stores are empty before the copy', same(empty, await rpc(ctx.apiUrl, 'dump')));

	heading('Write the old store through LegacyKVStore');
	must('put', (await rpc(ctx.apiUrl, 'putOld', ['written-by-put', { n: 1 }])) === 'written');
	const written = (await aws.rawScan(oldName('docs'))).find((item) => item.pk?.S === 'written-by-put');
	record('a put writes an item of the release layout to the old table', written?.value?.S === JSON.stringify({ n: 1 }) && Object.keys(written).sort().join() === 'pk,value', JSON.stringify(written));
	must('delete the key again', (await rpc(ctx.apiUrl, 'removeOld', ['written-by-put'])) === 'deleted');
	record('after that delete the old tables hold the items of the release again', same(rawBefore, await eachStore((store) => aws.rawScan(oldName(store)))));

	heading('Copy, in app code');
	must('the app writes a key to the new store before the copy', (await rpc(ctx.apiUrl, 'putNew', ['greeting', 'written since the deploy'])) === 'written');
	const counts = await rpc(ctx.apiUrl, 'copyAll');
	save('copy-counts.json', counts);
	note(`copy: ${JSON.stringify(counts)}`);
	// The new stores hold the live entries. The expired entry of `strings` is copied too, and a read hides it.
	const { stringsIncludingExpired: expiredToo, ...live } = dumpBefore;
	record('the fixture has an expired entry, which a read with includeExpired shows', expiredToo.length === live.strings.length + 1);
	const expected: Dump = { ...live, strings: live.strings.map((e) => (e.key === 'greeting' ? { ...e, value: 'written since the deploy' } : e)) };
	const dumpAfter = await rpc(ctx.apiUrl, 'dump');
	save('dump-after-copy.json', dumpAfter);
	record('the new stores hold every value, and the key that the app wrote since the deploy keeps its value', same(expected, dumpAfter));
	record('the expiry of each live entry is copied', same(await rpc(ctx.apiUrl, 'expiriesOld'), await rpc(ctx.apiUrl, 'expiries')));
	const again = (await rpc(ctx.apiUrl, 'copyAll')) as Record<string, { copied: number; kept: number }>;
	record('a second copy writes nothing', Object.values(again).every((c) => c.copied === 0), JSON.stringify(again));
	const byName = await rpc(ctx.apiUrl, 'byName', ['Ada']);
	record('a query on an index of the new store returns a copied item', same(byName, [{ key: 'u1', value: { userId: 'u1', name: 'Ada', age: 36 } }]), JSON.stringify(byName));

	heading('Delete a key in both stores');
	must('delete', (await rpc(ctx.apiUrl, 'deleteDoc', ['object'])) === 'deleted');
	record('a read with a fallback to the old store returns null', (await rpc(ctx.apiUrl, 'getDoc', ['object'])) === null);
	record('the item is gone from the old table', !(await aws.rawScan(oldName('docs'))).some((item) => item.pk?.S === 'object'));
	record('a key that was not deleted still reads', same(await rpc(ctx.apiUrl, 'getDoc', ['array']), [1, 'two', { three: 3 }]));

	heading('Deploy 3: the app without LegacyKVStore');
	const newDescribe = await eachStore((store) => aws.describeTable(newName(store)));
	const removalDiff = await cdkDiff(ctx.finalApp, ctx.env);
	save('removal-cdk-diff.txt', removalDiff);
	save('removal-cdk-diff-changes.json', parseCdkDiff(removalDiff));
	const removal = await deployCheckout(ctx, 'deploy final', ctx.finalApp);
	save('removal-events.json', removal.events);
	must('the third deploy reached UPDATE_COMPLETE', removal.status === 'UPDATE_COMPLETE', `status: ${removal.status}\n${failedResources(removal.events).join('\n')}`);
	const tableEvents = removal.events.filter((e) => e.type === TABLE_TYPE);
	for (const [logicalId, name] of Object.entries(tablesBefore)) {
		const statuses = tableEvents.filter((e) => e.id === logicalId).map((e) => e.status);
		note(`${name}: ${statuses.join(' → ') || 'no event'}; exists afterwards: ${await aws.tableExists(name)}`);
	}
	const gone = await Promise.all((['strings', 'profiles', 'expiring'] as const).map((store) => aws.tableExists(oldName(store))));
	record('the old tables with the default policy are deleted', gone.every((exists) => !exists));
	record('the old table with removalPolicy retain is kept, outside the stack', (await aws.tableExists(oldName('docs'))) && !Object.values(await aws.tables()).includes(oldName('docs')));
	record('the new tables are untouched by the third deploy (same TableId)', same(newDescribe, await eachStore((store) => aws.describeTable(newName(store)))));
	const expectedFinal: Dump = { ...expected, docs: expected.docs.filter((e) => e.key !== 'object') };
	record('the app reads every value from the new stores', same(expectedFinal, await rpc(ctx.apiUrl, 'dump')));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runReal(): Promise<number> {
	if (process.env.BLOCKS_UPGRADE_E2E !== '1') {
		console.error('Refusing to deploy: set BLOCKS_UPGRADE_E2E=1 to run the LegacyKVStore upgrade against AWS (three deploys and a destroy, about 15 minutes). Use --mode options for the offline check.');
		return 2;
	}
	const refusal = realModeRefusal(process.env);
	if (refusal) {
		console.error(refusal);
		return 2;
	}
	const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
	const aws = await createAws(region);
	try {
		const who = await aws.caller();
		console.log(`AWS account ${who.account}, region ${region}. Stack ${stackName}. Mode ${mode}.`);
	} catch (error) {
		console.error(`Refusing to deploy: the AWS credentials do not work (${String(error)}).`);
		return 2;
	}
	if ((await aws.stackStatus()) !== null) {
		console.error(`Refusing to deploy: stack ${stackName} already exists and was not created by this run.`);
		return 2;
	}
	const baseEnv: Env = { ...process.env };
	const onSignal = () => {
		interrupted = true;
		console.error('\nsignal: stopping; the stack will be destroyed.');
		currentChild?.kill('SIGTERM');
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	let ctx: Ctx | undefined;
	let failed = false;
	let gone = false;
	try {
		ctx = await deployRelease(aws, baseEnv);
		await runUpgrade(ctx);
	} catch (error) {
		failed = true;
		console.error(error instanceof HarnessFailure ? `\n✘ stopped: ${error.message}` : error);
	} finally {
		const finalApp = ctx?.finalApp ?? materialize(PR_ROOT, 'final', 'backend.kv-legacy.ts.txt', 'sandbox', true);
		gone = await destroy(aws, finalApp, driverEnv(baseEnv)).catch((e: unknown) => (console.error(e), false));
		removeFixtureApps();
	}
	save('checks.json', checks);
	failed ||= checks.some((c) => !c.ok);
	console.log(`\nUPGRADE_LEGACY_KV_STORE_RESULT=${failed ? 'FAILED' : 'PASSED'} mode=${mode} checks=${checks.filter((c) => c.ok).length}/${checks.length} stack=${stackName}${gone ? '' : ' orphaned=true'}`);
	return gone ? (failed ? 1 : 0) : 3;
}

if (mode === 'options') {
	const code = await runOptions().finally(removeFixtureApps);
	save('checks.json', checks);
	console.log(`\nUPGRADE_LEGACY_KV_STORE_RESULT=${code === 0 ? 'PASSED' : 'FAILED'} mode=options checks=${checks.filter((c) => c.ok).length}/${checks.length}`);
	process.exitCode = code;
} else process.exit(await runReal());
