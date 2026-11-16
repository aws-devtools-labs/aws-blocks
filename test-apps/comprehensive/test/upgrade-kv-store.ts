// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * UPGRADE E2E, KVStore — proves that a store of the last `KVStore` release
 * before the item layout changed (0.4.0) reaches this checkout with
 * `migrateFrom`, on AWS, while a writer runs. Three deploys on one stack:
 *
 * 1. the fixture app on release 0.4.0 (`app/backend.kv-release.ts.txt`);
 * 2. the same app on this checkout, each store with a new id and
 *    `migrateFrom` (`app/backend.kv-migrate.ts.txt`);
 * 3. the app of deploy 2 without its `migrateFrom` lines.
 *
 * ## How to run
 *
 * From `test-apps/comprehensive`, after `npm run build` at the repo root and
 * in a built checkout of the release (`git worktree add <dir> @aws-blocks/bb-kv-store@0.4.0`):
 *
 *     npm run test:upgrade-kv-store -- --mode options --base-dir <release checkout> --evidence <dir>
 *     BLOCKS_UPGRADE_E2E=1 AWS_PROFILE=<sandbox> AWS_REGION=<region> \
 *         npm run test:upgrade-kv-store -- --mode writer --base-dir <release checkout> --evidence <dir>
 *
 * - `--mode options` (offline): for each option combination of release 0.4.0,
 *   under both presets, `cdk diff` shows that the migration deploy changes the
 *   old table by its stream only, and what the third deploy does to it.
 * - `--mode writer`: a logging writer calls the app for the whole of deploy 2.
 *   It keeps the last acknowledged write of each key and checks every answer.
 *   After the deploy its log is reconciled with the new table: an acknowledged
 *   write that is absent, an older value, or a deleted key that is present.
 *   `--workers` (default 16) and `--pause` (default 40 ms) set its load.
 * - `--mode failures`: an item that the new layout refuses, a deploy over a
 *   retained table that a rollback left behind, a failure after the app is
 *   updated, and a rerun.
 * - `--mode scale`: a copy of `--items` items (default 1,000,000), with the
 *   consumed capacity and the duration.
 *
 * The AWS modes refuse to start unless `BLOCKS_UPGRADE_E2E=1`, `AWS_REGION` and
 * an explicit credential source are set. Each takes 20 to 40 minutes. They are
 * long-running: start them in the background and read the log for the final
 * `UPGRADE_KV_STORE_RESULT=` line. **Cleanup:** the stack is destroyed in a
 * `finally`, and so are the two tables of the fixture that have a retain
 * policy. It never deploys into a stack that exists.
 *
 * Every file that a run writes is in `--evidence`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	type CfnTemplate,
	decodeRpcResponse,
	encodeRpcRequest,
	offlineEnv,
	parseCdkDiff,
	realModeRefusal,
	SUFFIX_PATTERN,
	stableStringify,
	stackNameFor,
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
const suffix = arg('--suffix') ?? `upgrade-kv${Date.now().toString(36)}p${process.pid.toString(36)}`;
const bigItems = Number(arg('--items') ?? '1000000');
/** The writer of the writer mode: workers, and the pause of each worker between two calls. */
const writerWorkers = Number(arg('--workers') ?? '16');
const writerPauseMs = Number(arg('--pause') ?? '40');
const MODES = ['options', 'writer', 'failures', 'scale'];
if (!MODES.includes(mode) || !baseDir || !evidenceDir || !SUFFIX_PATTERN.test(suffix)) {
	console.error(`usage: upgrade-kv-store.ts --mode ${MODES.join('|')} --base-dir <dir> --evidence <dir> [--suffix upgrade-…] [--items <n>] [--workers <n>] [--pause <ms>]`);
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
// A spread of a long array into Math.min overflows the stack.
const least = (xs: number[]) => xs.reduce((a, b) => (b < a ? b : a), Number.POSITIVE_INFINITY);
const most = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), Number.NEGATIVE_INFINITY);

// ── Child processes ──────────────────────────────────────────────────────────

let currentChild: ChildProcess | undefined;
let interrupted = false;
type Env = Record<string, string | undefined>;

function run(label: string, command: string, args: readonly string[], options: { cwd: string; env: Env; allowFailure?: boolean; quiet?: boolean }) {
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
			if (code !== 0 && !options.allowFailure) {
				if (options.quiet) console.log(output.trimEnd().split('\n').slice(-40).join('\n'));
				return reject(new HarnessFailure(`${label}: exited with ${code}`));
			}
			resolvePromise({ code, output });
		});
	});
}
const bin = (treeRoot: string, name: 'cdk' | 'tsx') => join(treeRoot, 'node_modules', '.bin', name);

// ── The fixture app ──────────────────────────────────────────────────────────

/**
 * Appended to the CDK entry of the fixture app.
 *
 * - Each migration resource returns what it did in its `Stats` attribute. The
 *   fixture shows them as stack outputs, so that the harness can read them.
 * - With `KV_UPGRADE_LATE_FAILURE=1`, a resource that always fails is created
 *   after every drain: the deploy rolls back after the copy and the update of
 *   the app.
 */
const FIXTURE_CDK = `
const migrations = blocksStack.node.findAll().filter(
	(node): node is cdk.CfnResource => node instanceof cdk.CfnResource && /^Custom::BlocksKvMigrate(Copy|Drain)$/.test(node.cfnResourceType),
);
for (const resource of migrations) {
	const store = resource.node.scope?.node.scope?.node.id ?? '';
	const phase = resource.cfnResourceType.endsWith('Copy') ? 'Copy' : 'Drain';
	new cdk.CfnOutput(blocksStack, 'KvMigrate' + store.replace(/[^A-Za-z0-9]/g, '') + phase, {
		value: cdk.Token.asString(resource.getAtt('Stats')),
	});
}
if (process.env.KV_UPGRADE_LATE_FAILURE === '1') {
	const handle = new cdk.CfnWaitConditionHandle(blocksStack, 'LateFailureHandle');
	const failure = new cdk.CfnWaitCondition(blocksStack, 'LateFailure', { handle: handle.ref, timeout: '1', count: 1 });
	for (const resource of migrations) {
		if (resource.cfnResourceType.endsWith('Drain')) failure.addDependency(resource);
	}
}
`;

/**
 * Write a fixture app into a checkout. `withoutMigrateFrom` drops the lines of
 * the backend that end with `// migrateFrom`: the app of the third deploy.
 */
function materialize(treeRoot: string, variant: string, backend: string, preset: 'sandbox' | 'production' = 'sandbox', withoutMigrateFrom = false): string {
	const dir = join(treeRoot, 'test-apps', '.upgrade-in-place', `${suffix}-${variant}`);
	rmSync(dir, { recursive: true, force: true });
	for (const sub of ['aws-blocks', 'scripts', '.blocks']) mkdirSync(join(dir, sub), { recursive: true });
	const cdkEntry = readFileSync(join(APP, 'index.cdk.ts'), 'utf8').replace('BlocksPresets.sandbox', `BlocksPresets.${preset}`);
	writeFileSync(join(dir, 'aws-blocks', 'index.cdk.ts'), cdkEntry + FIXTURE_CDK);
	const source = readFileSync(join(APP, backend), 'utf8');
	writeFileSync(join(dir, 'aws-blocks', 'index.ts'), withoutMigrateFrom ? source.replace(/^.*\/\/ migrateFrom\n/gm, '') : source);
	writeFileSync(
		join(dir, 'aws-blocks', 'index.handler.ts'),
		"import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';\n\nexport const handler = createLambdaHandler(() => import('./index.js'));\n",
	);
	copyFileSync(join(APP, 'deploy.ts'), join(dir, 'scripts', 'deploy.ts'));
	copyFileSync(join(APP, 'destroy.ts'), join(dir, 'scripts', 'destroy.ts'));
	writeFileSync(join(dir, 'cdk.json'), `${JSON.stringify({ app: `"${bin(treeRoot, 'tsx')}" -C cdk aws-blocks/index.cdk.ts` }, null, 2)}\n`);
	writeFileSync(join(dir, '.blocks', 'config.json'), `${JSON.stringify({ stackId: 'bb-test-upgrade', telemetry: { enabled: false } }, null, 2)}\n`);
	return dir;
}

const cdkEnv = (base: Env): Env => ({ ...base, NODE_OPTIONS: '--conditions=cdk', BLOCKS_STACK_SUFFIX: suffix, BLOCKS_STAGE: 'production' });
function driverEnv(base: Env, extra: Env = {}): Env {
	const { NODE_OPTIONS: _ignored, ...rest } = base;
	return { ...rest, BLOCKS_STACK_SUFFIX: suffix, ...extra };
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

/** The block of a `cdk diff` text for one logical id: its header line and the lines under it. */
function diffBlock(diffText: string, logicalId: string): string {
	const lines = diffText.split('\n');
	const start = lines.findIndex((l) => /^\[[~+\-]\] /.test(l) && l.includes(` ${logicalId}`));
	if (start === -1) return '(no change)';
	let end = start + 1;
	while (end < lines.length && !/^\[[~+\-]\] /.test(lines[end]) && lines[end].trim() !== '' && !/^[A-Z][a-z]+$/.test(lines[end].trim())) end++;
	return lines.slice(start, end).join('\n');
}

/** The property changes of one resource in a `cdk diff` text, each as `+ Name …`. */
function propertyChanges(diffText: string, logicalId: string): { block: string; changed: string[] } {
	const block = diffBlock(diffText, logicalId);
	const changed = block === '(no change)' ? [] : [...block.matchAll(/^ [├└]─ \[([~+\-])\] (\S+)(.*)$/gm)].map((m) => `${m[1]} ${m[2]}${m[3]}`.trim());
	return { block, changed };
}
const onlyTheStream = (changed: string[]) => changed.length === 1 && changed[0].startsWith('+ StreamSpecification');

/** The resources that failed in a deploy, without those that CloudFormation cancelled because another one failed. */
const failedResources = (events: { status: string; id: string; reason?: string }[]) =>
	events.filter((e) => e.status.endsWith('FAILED') && !/cancelled|following resource/.test(e.reason ?? '')).map((e) => `${e.id}: ${e.reason}`);

// ── Mode options: the old table for each option combination, offline ──────────────

async function runOptions(): Promise<number> {
	const result: Record<string, unknown> = {};
	for (const preset of ['sandbox', 'production'] as const) {
		heading(`Option matrix, ${preset} preset`);
		const env = cdkEnv(offlineEnv(process.env));
		const before = await synth(materialize(BASE_ROOT, `m-before-${preset}`, 'backend.kv-options-release.ts.txt', preset), BASE_ROOT, env);
		const afterApp = materialize(PR_ROOT, `m-after-${preset}`, 'backend.kv-options-migrate.ts.txt', preset);
		const after = await synth(afterApp, PR_ROOT, env);
		const finalApp = materialize(PR_ROOT, `m-final-${preset}`, 'backend.kv-options-migrate.ts.txt', preset, true);
		const migrationDiff = await cdkDiff(afterApp, env, before.path);
		const removalDiff = await cdkDiff(finalApp, env, after.path);
		save(`options-${preset}-migration-diff.txt`, migrationDiff);
		save(`options-${preset}-removal-diff.txt`, removalDiff);
		const oldTables = tablesByName(before.template);
		const duringMigration = tablesByName(after.template);
		const removalChanges = parseCdkDiff(removalDiff);
		const rows: Record<string, unknown> = {};
		for (const [name, { logicalId, resource }] of Object.entries(oldTables)) {
			const now = duringMigration[name];
			const store = name.slice(`${stackName}-upgrade-`.length);
			const { block, changed } = propertyChanges(migrationDiff, logicalId);
			const removal = removalChanges.find((c) => c.logicalId === logicalId);
			const policy = (resource as { DeletionPolicy?: string }).DeletionPolicy;
			rows[store] = {
				sameLogicalId: now?.logicalId === logicalId,
				changesInMigrationDeploy: changed,
				replacement: /replace/.test(block.split('\n')[0]),
				deletionPolicy: policy,
				thirdDeploy: removal ? `${removal.action}${removal.impact === 'none' ? '' : ` (${removal.impact})`}` : 'no change',
			};
			record(
				`${preset} ${store}: the old table keeps its logical id, and the only change is the stream`,
				now?.logicalId === logicalId && onlyTheStream(changed),
				`${block}\n third deploy: ${removal?.line ?? 'no change'}  (DeletionPolicy ${policy})`,
			);
		}
		// Anything else that the migration deploy changes or removes, beyond the old tables and what it adds.
		const other = parseCdkDiff(migrationDiff).filter((c) => c.action !== 'add' && !Object.values(oldTables).some((t) => t.logicalId === c.logicalId));
		note(`other resources changed or removed by the migration deploy: ${other.map((c) => c.line).join(' | ') || 'none'}`);
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
		ddb,
		ddbClient,
		tableExists,
		async caller() {
			const out = await stsClient.send(new sts.GetCallerIdentityCommand({}));
			return { account: out.Account ?? '?', arn: out.Arn ?? '?' };
		},
		stackStatus,
		async waitForTerminal(timeoutMs = 60 * 60_000): Promise<string | null> {
			const deadline = Date.now() + timeoutMs;
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
		async outputs(): Promise<Record<string, string>> {
			const out = await cfnClient.send(new cfn.DescribeStacksCommand({ StackName: stackName }));
			return Object.fromEntries((out.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey ?? '', o.OutputValue ?? '']));
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
		/** Every item of a table as DynamoDB stores it, sorted by its key attribute. */
		async rawScan(name: string, keyAttr: string): Promise<Record<string, { S?: string; N?: string }>[]> {
			const items: Record<string, { S?: string; N?: string }>[] = [];
			let start: Record<string, unknown> | undefined;
			do {
				// biome-ignore lint/suspicious/noExplicitAny: ExclusiveStartKey is the LastEvaluatedKey of the previous page
				const out = await ddbClient.send(new ddb.ScanCommand({ TableName: name, ConsistentRead: true, ExclusiveStartKey: start as any }));
				items.push(...((out.Items ?? []) as Record<string, { S?: string; N?: string }>[]));
				start = out.LastEvaluatedKey;
			} while (start);
			return items.sort((a, b) => ((a[keyAttr]?.S ?? '') < (b[keyAttr]?.S ?? '') ? -1 : 1));
		},
		/** The number of items, with a parallel count Scan. */
		async count(name: string): Promise<number> {
			let count = 0;
			await Promise.all(
				Array.from({ length: 16 }, async (_, segment) => {
					let start: Record<string, unknown> | undefined;
					do {
						const out = await ddbClient.send(
							// biome-ignore lint/suspicious/noExplicitAny: ExclusiveStartKey is the LastEvaluatedKey of the previous page
							new ddb.ScanCommand({ TableName: name, Select: 'COUNT', Segment: segment, TotalSegments: 16, ExclusiveStartKey: start as any }),
						);
						count += out.Count ?? 0;
						start = out.LastEvaluatedKey;
					} while (start);
				}),
			);
			return count;
		},
		/** Write `n` items in the layout of the release, straight into a table. */
		async seedRelease(name: string, n: number): Promise<{ ms: number; writeUnits: number }> {
			const started = Date.now();
			let next = 0;
			let writeUnits = 0;
			const pad = 'x'.repeat(40);
			const worker = async () => {
				while (next < n) {
					const from = next;
					next = Math.min(n, next + 25);
					let pending = Array.from({ length: next - from }, (_, j) => {
						const i = from + j;
						return { PutRequest: { Item: { pk: { S: `i${String(i).padStart(7, '0')}` }, value: { S: JSON.stringify({ n: i, s: pad }) } } } };
					});
					for (let attempt = 0; pending.length > 0; attempt++) {
						if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2000) * (0.5 + Math.random()));
						const out = await ddbClient.send(new ddb.BatchWriteItemCommand({ RequestItems: { [name]: pending }, ReturnConsumedCapacity: 'TOTAL' }));
						for (const c of out.ConsumedCapacity ?? []) writeUnits += c.CapacityUnits ?? 0;
						pending = (out.UnprocessedItems?.[name] ?? []) as typeof pending;
					}
				}
			};
			await Promise.all(Array.from({ length: 40 }, worker));
			return { ms: Date.now() - started, writeUnits };
		},
		async deleteTableIfExists(name: string): Promise<boolean> {
			if (!(await tableExists(name))) return false;
			await ddbClient.send(new ddb.DeleteTableCommand({ TableName: name }));
			return true;
		},
	};
}
type Aws = Awaited<ReturnType<typeof createAws>>;

async function rpc(apiUrl: string, method: string, args: readonly unknown[] = [], retries = 4): Promise<unknown> {
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
		const path = join(appDir, '.blocks-sandbox', doc);
		if (!existsSync(path)) continue;
		const url = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>)[stackName]?.ApiUrl;
		if (url) return url;
	}
	throw new HarnessFailure(`no ApiUrl output for ${stackName} in ${appDir}`);
}

// ── The logging writer ───────────────────────────────────────────────────────

interface Op {
	i: number;
	w: number;
	k: number;
	kind: string;
	seq: number;
	prev?: number;
	t0: number;
	t1: number;
	rev?: string;
	/** `ok`, `conflict`, another error name, or `unknown` when no answer came. */
	res: string;
	value?: unknown;
	phase: string;
	anomaly?: string;
}

interface KeyState {
	/** The last acknowledged write: a put of `seq`, or a delete. Undefined before the first one. */
	acked?: { kind: 'put' | 'del'; seq: number };
	/** A later write got no answer, so the key may hold either state. */
	unknown: boolean;
	/** The writer saw an answer that disagrees with `acked`; it writes a plain put next. */
	resync: boolean;
	seq: number;
}

const writers: Writer[] = [];

class Writer {
	readonly log: Op[] = [];
	readonly keys = new Map<string, KeyState>();
	phase = 'baseline';
	private running = false;
	private paused = false;
	private loops: Promise<void>[] = [];
	constructor(private readonly apiUrl: string, private readonly workers: number, private readonly keysPerWorker: number, private readonly pauseMs: number) {}

	start(): void {
		writers.push(this);
		this.running = true;
		this.loops = Array.from({ length: this.workers }, (_, w) => this.loop(w));
	}
	async stop(): Promise<void> {
		this.running = false;
		await Promise.all(this.loops);
	}
	/** Stop sending and wait for every answer; `resume` continues. */
	async quiesce(): Promise<void> {
		this.paused = true;
		await sleep(2_500);
	}
	resume(): void {
		this.paused = false;
	}

	private state(w: number, k: number): KeyState {
		const id = `w${w}:k${k}`;
		let s = this.keys.get(id);
		if (!s) {
			s = { unknown: false, resync: false, seq: 0 };
			this.keys.set(id, s);
		}
		return s;
	}

	private async loop(w: number): Promise<void> {
		while (this.running) {
			if (this.paused) {
				await sleep(100);
				continue;
			}
			const k = Math.floor(Math.random() * this.keysPerWorker);
			const s = this.state(w, k);
			const exists = s.acked?.kind === 'put';
			const r = Math.random();
			let kind: string;
			if (s.unknown || s.resync || !s.acked) kind = 'put';
			else if (exists) kind = r < 0.4 ? 'put' : r < 0.6 ? 'cput' : r < 0.8 ? 'del' : 'get';
			else kind = r < 0.4 ? 'cnew' : r < 0.7 ? 'put' : 'get';
			const mutating = kind !== 'get';
			const seq = mutating ? ++s.seq : s.seq;
			const prev = kind === 'cput' ? s.acked?.seq : undefined;
			const op: Op = { i: this.log.length, w, k, kind, seq, ...(prev !== undefined ? { prev } : {}), t0: Date.now(), t1: 0, res: 'unknown', phase: this.phase };
			this.log.push(op);
			try {
				const res = await fetch(this.apiUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encodeRpcRequest('api', 'op', [w, k, seq, kind, prev ?? null], op.i), signal: AbortSignal.timeout(35_000) });
				const outcome = res.ok ? decodeRpcResponse(await res.json().catch(() => null)) : undefined;
				if (outcome?.ok) {
					const body = outcome.result as { rev?: string; ok?: boolean; error?: string; value?: unknown };
					op.rev = body.rev;
					op.res = body.ok ? 'ok' : body.error === 'ConditionalCheckFailedException' ? 'conflict' : String(body.error);
					if (kind === 'get') op.value = body.value;
				} else op.res = `unknown (HTTP ${res.status})`;
			} catch (error) {
				op.res = `unknown (${error instanceof Error ? error.name : 'error'})`;
			}
			op.t1 = Date.now();
			this.settle(s, op);
			await sleep(this.pauseMs);
		}
	}

	/** Update the writer's view of the key, and name what disagrees with it. */
	private settle(s: KeyState, op: Op): void {
		const certain = !s.unknown && !s.resync;
		const exists = s.acked?.kind === 'put';
		if (op.kind === 'get') {
			if (op.res !== 'ok' || !certain || !s.acked) return;
			const expected = exists ? String(s.acked.seq) : null;
			if (op.value !== expected) {
				op.anomaly = expected === null ? 'read returned a deleted key' : op.value === null ? 'read missed an acknowledged write' : 'read returned an older value';
				s.resync = true;
			}
			return;
		}
		if (op.res.startsWith('unknown')) {
			s.unknown = true;
			return;
		}
		if (op.res === 'ok') {
			s.acked = { kind: op.kind === 'del' ? 'del' : 'put', seq: op.seq };
			s.unknown = false;
			s.resync = false;
			return;
		}
		if (op.res === 'conflict') {
			// The writer is the only client of the key, so a conflict means the table does not hold what was acknowledged.
			if (certain) op.anomaly = op.kind === 'cnew' ? 'ifNotExists found a deleted key' : 'ifValueEquals did not find the acknowledged value';
			s.resync = true;
			return;
		}
		s.resync = true;
	}

	/** Compare the last acknowledged write of every key with the items of a table (`key → value`). */
	reconcile(items: Map<string, string>): { keys: number; ok: number; indeterminate: number; lost: string[]; stale: string[]; resurrected: string[] } {
		const out = { keys: 0, ok: 0, indeterminate: 0, lost: [] as string[], stale: [] as string[], resurrected: [] as string[] };
		for (const [id, s] of this.keys) {
			if (!s.acked) continue;
			out.keys++;
			if (s.unknown) {
				out.indeterminate++;
				continue;
			}
			const actual = items.get(id);
			if (s.acked.kind === 'del') {
				if (actual === undefined) out.ok++;
				else out.resurrected.push(id);
			} else if (actual === String(s.acked.seq)) out.ok++;
			else if (actual === undefined) out.lost.push(id);
			else out.stale.push(id);
		}
		return out;
	}

	history(id: string, last = 8): Op[] {
		const [w, k] = id.slice(1).split(':k').map(Number);
		return this.log.filter((op) => op.w === w && op.k === k).slice(-last);
	}
}

/** `key → value` of a ledger table, in either layout. */
function ledgerItems(raw: Record<string, { S?: string; N?: string }>[], layout: 'release' | 'new'): Map<string, string> {
	const map = new Map<string, string>();
	for (const item of raw) {
		if (layout === 'release') map.set(item.pk?.S ?? '', JSON.parse(item.value?.S ?? 'null') as string);
		else if (!(item._bkv_pk?.S ?? '').startsWith('_bkv_migration')) map.set(item._bkv_pk?.S ?? '', item._bkv_value?.S ?? '');
	}
	return map;
}

const withoutMarker = (items: Record<string, unknown>[]) => items.map(({ _bkv_m: _m, ...rest }) => rest);

/** The counts of a reconciliation of the writer log with a table. */
const finalState = (rec: ReturnType<Writer['reconcile']>) => ({ keys: rec.keys, ok: rec.ok, indeterminate: rec.indeterminate, lost: rec.lost.length, stale: rec.stale.length, resurrected: rec.resurrected.length });

/** One value for each store of the fixture. */
async function eachStore<T>(of: (store: (typeof FIXTURE)[number]) => Promise<T>): Promise<Record<string, T>> {
	return Object.fromEntries(await Promise.all(FIXTURE.map(async (store) => [store, await of(store)] as const)));
}

/** What each migration resource did: the `Stats` attributes that the fixture app shows as stack outputs. */
async function migrationStats(aws: Aws): Promise<Record<string, unknown>> {
	return Object.fromEntries(Object.entries(await aws.outputs()).filter(([k]) => k.startsWith('KvMigrate')).map(([k, v]) => [k, JSON.parse(v)]));
}

// ── Deploys ──────────────────────────────────────────────────────────────────

interface Ctx {
	aws: Aws;
	env: Env;
	deployEnv: Env;
	afterApp: string;
	finalApp: string;
	apiUrl: string;
}

async function deployRelease(aws: Aws, baseEnv: Env): Promise<Ctx> {
	const beforeApp = materialize(BASE_ROOT, 'before', 'backend.kv-release.ts.txt');
	const afterApp = materialize(PR_ROOT, 'after', 'backend.kv-migrate.ts.txt');
	const finalApp = materialize(PR_ROOT, 'final', 'backend.kv-migrate.ts.txt', 'sandbox', true);
	const deployEnv = driverEnv(baseEnv);
	heading('Deploy 1: the app on release 0.4.0');
	await run('deploy release', bin(BASE_ROOT, 'tsx'), [join(beforeApp, 'scripts', 'deploy.ts')], { cwd: beforeApp, env: deployEnv, quiet: true }).catch((error: unknown) => record('release deploy succeeded', false, String(error)));
	const status = await aws.waitForTerminal();
	must('release stack is CREATE_COMPLETE', status === 'CREATE_COMPLETE', `status: ${status}`);
	return { aws, env: cdkEnv(baseEnv), deployEnv, afterApp, finalApp, apiUrl: readApiUrl(beforeApp) };
}

/** Deploy an app of this checkout on the stack. Returns the status and the stack events of the deploy. */
async function deployCheckout(ctx: Ctx, label: string, appDir: string, extra: Env = {}) {
	const started = Date.now();
	let error: unknown;
	await run(label, bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'deploy.ts')], { cwd: appDir, env: { ...ctx.deployEnv, ...extra }, quiet: true }).catch((e: unknown) => {
		error = e;
	});
	const status = await ctx.aws.waitForTerminal();
	const events = await ctx.aws.eventsSince(started - 5_000);
	return { status, error, started, ended: Date.now(), events };
}

const oldName = (store: string) => `${stackName}-upgrade-${store}`;
const newName = (store: string) => `${stackName}-upgrade-${store}-v2`;

/** The moments of a migration deploy that order the copy, the switch and the drain, from the stack events. */
function timeline(events: { at: string; id: string; type: string; status: string }[]) {
	const pick = (type: RegExp, id: RegExp, status: string) => events.filter((e) => type.test(e.type) && id.test(e.id) && e.status === status).map((e) => e.at);
	const first = (xs: string[]) => xs.slice().sort()[0];
	const last = (xs: string[]) => xs.slice().sort().at(-1);
	return {
		oldTablesStreamOn: last(pick(/DynamoDB::Table/, /^upgrade(?!.*v2)/, 'UPDATE_COMPLETE')),
		copyFirstStart: first(pick(/BlocksKvMigrateCopy/, /./, 'CREATE_IN_PROGRESS')),
		copyFirstComplete: first(pick(/BlocksKvMigrateCopy/, /./, 'CREATE_COMPLETE')),
		copyLastComplete: last(pick(/BlocksKvMigrateCopy/, /./, 'CREATE_COMPLETE')),
		functionUpdateStart: first(pick(/Lambda::Function/, /DefaultComputeHandler/, 'UPDATE_IN_PROGRESS')),
		functionUpdateComplete: last(pick(/Lambda::Function/, /DefaultComputeHandler/, 'UPDATE_COMPLETE')),
		drainFirstStart: first(pick(/BlocksKvMigrateDrain/, /./, 'CREATE_IN_PROGRESS')),
		drainLastComplete: last(pick(/BlocksKvMigrateDrain/, /./, 'CREATE_COMPLETE')),
	};
}

async function destroy(aws: Aws, appDir: string, deployEnv: Env): Promise<boolean> {
	heading(`Destroy ${stackName}`);
	let status = await aws.waitForTerminal();
	if (status !== null && status !== 'DELETE_COMPLETE') {
		interrupted = false;
		await run('destroy', bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'destroy.ts')], { cwd: appDir, env: deployEnv, allowFailure: true, quiet: true }).catch((e: unknown) => console.error(e));
		status = await aws.waitForTerminal();
		if (status !== null && status !== 'DELETE_COMPLETE') {
			await aws.deleteStack().catch((e: unknown) => console.error(e));
			status = await aws.waitForTerminal();
		}
	}
	const gone = status === null || status === 'DELETE_COMPLETE';
	console.log(gone ? `  ✔ ${stackName} is deleted.` : `  ✘ STACK LEFT BEHIND: ${stackName}, status ${status}`);
	// The fixture declares `docs` with `removalPolicy: 'retain'`, so its table outlives the stack. It is this run's own table.
	for (const name of [oldName('docs'), newName('docs')]) {
		if (await aws.deleteTableIfExists(name)) console.log(`  ✔ deleted the retained test table ${name}`);
	}
	return gone;
}

// ── Mode: writer ───────────────────────────────────────────────────────────────

async function runWriter(ctx: Ctx): Promise<void> {
	const { aws } = ctx;
	heading('Seed the fixture; start the writer on the release');
	must('seed', (await rpc(ctx.apiUrl, 'seed')) === 'seeded');
	await sleep(3_000);
	const dumpBefore = await rpc(ctx.apiUrl, 'dump');
	const rawBefore = await eachStore((store) => aws.rawScan(oldName(store), 'pk'));
	const describeBefore = await eachStore((store) => aws.describeTable(oldName(store)));
	save('dump-before.json', dumpBefore);
	save('raw-old-before.json', rawBefore);
	save('describe-old-before.json', describeBefore);
	const tablesBefore = await aws.tables();

	const writer = new Writer(ctx.apiUrl, writerWorkers, 12, writerPauseMs);
	writer.start();
	await sleep(30_000);

	heading('Deploy 2: new store ids with migrateFrom, while the writer runs');
	const liveBefore = await aws.liveTemplate();
	const after = await synth(ctx.afterApp, PR_ROOT, ctx.env);
	const diffText = await cdkDiff(ctx.afterApp, ctx.env);
	save('migration-cdk-diff.txt', diffText);
	const oldTables = tablesByName(liveBefore);
	for (const [name, { logicalId }] of Object.entries(oldTables)) {
		const { block, changed } = propertyChanges(diffText, logicalId);
		record(`cdk diff: the only change to ${name.slice(`${stackName}-upgrade-`.length)} is the stream`, onlyTheStream(changed) && tablesByName(after.template)[name]?.logicalId === logicalId, block);
	}
	writer.phase = 'migration deploy';
	const migration = await deployCheckout(ctx, 'deploy migration', ctx.afterApp);
	save('migration-events.json', migration.events);
	must('the migration deploy reached UPDATE_COMPLETE', migration.status === 'UPDATE_COMPLETE', `status: ${migration.status}\n${failedResources(migration.events).join('\n')}`);
	const moments = timeline(migration.events);
	save('migration-timeline.json', { deployStarted: new Date(migration.started).toISOString(), deployEnded: new Date(migration.ended).toISOString(), ...moments });
	record(
		'CloudFormation ran every copy before the function update, and the drains from the end of the first copy until after the update',
		Boolean(moments.copyFirstComplete && moments.copyLastComplete && moments.functionUpdateStart && moments.drainFirstStart && moments.functionUpdateComplete && moments.drainLastComplete) &&
			(moments.copyLastComplete as string) <= (moments.functionUpdateStart as string) &&
			// The drain of a store starts when the copy of that store ends, not when the last copy ends.
			(moments.copyFirstComplete as string) <= (moments.drainFirstStart as string) &&
			(moments.functionUpdateComplete as string) <= (moments.drainLastComplete as string),
		JSON.stringify(moments, null, 1),
	);
	writer.phase = 'after the deploy';
	await sleep(30_000);
	await writer.stop();
	await sleep(3_000);
	save('writer-log.json', writer.log);

	heading('Reconcile the writer log with the new table');
	const newLedger = ledgerItems(await aws.rawScan(newName('ledger'), '_bkv_pk'), 'new');
	const oldLedger = ledgerItems(await aws.rawScan(oldName('ledger'), 'pk'), 'release');
	const rec = writer.reconcile(newLedger);
	const byRev = (rev: string) => writer.log.filter((op) => op.rev === rev);
	const firstNew = least(byRev('new').map((op) => op.t1));
	const lastOld = most(byRev('old').map((op) => op.t1));
	const oldAfterFirstNew = byRev('old').filter((op) => op.t1 > firstNew);
	const anomalies = writer.log.filter((op) => op.anomaly);
	const anomalyWindow = anomalies.length ? { first: new Date(least(anomalies.map((a) => a.t0))).toISOString(), last: new Date(most(anomalies.map((a) => a.t1))).toISOString(), msAfterFirstAnswerOfNewCode: [least(anomalies.map((a) => a.t0)) - firstNew, most(anomalies.map((a) => a.t1)) - firstNew] } : null;
	const report = {
		ops: writer.log.length,
		writesPerSecondDuringTheDeploy: Math.round(writer.log.filter((op) => op.phase === 'migration deploy' && op.kind !== 'get' && op.res === 'ok').length / Math.max(1, (migration.ended - migration.started) / 1000)),
		byPhase: Object.fromEntries(['baseline', 'migration deploy', 'after the deploy'].map((p) => [p, writer.log.filter((op) => op.phase === p).length])),
		answeredByOldCode: byRev('old').length,
		answeredByNewCode: byRev('new').length,
		noAnswer: writer.log.filter((op) => op.res.startsWith('unknown')).length,
		firstAnswerOfNewCode: new Date(firstNew).toISOString(),
		lastAnswerOfOldCode: new Date(lastOld).toISOString(),
		oldCodeAnswersAfterFirstNewAnswer: oldAfterFirstNew.length,
		oldCodeOverlapMs: Math.max(0, lastOld - firstNew),
		finalState: finalState(rec),
		anomaliesSeenByTheWriter: Object.fromEntries([...new Set(anomalies.map((a) => a.anomaly as string))].map((name) => [name, { count: anomalies.filter((a) => a.anomaly === name).length, byRev: { old: anomalies.filter((a) => a.anomaly === name && a.rev === 'old').length, new: anomalies.filter((a) => a.anomaly === name && a.rev === 'new').length }, byPhase: Object.fromEntries(['baseline', 'migration deploy', 'after the deploy'].map((p) => [p, anomalies.filter((a) => a.anomaly === name && a.phase === p).length])) }])),
		anomalyWindow,
		keysInOldTable: oldLedger.size,
		keysInNewTable: newLedger.size,
	};
	save('reconcile.json', report);
	const detail = (ids: string[]) => ids.map((id) => ({ id, inNew: newLedger.get(id) ?? null, inOld: oldLedger.get(id) ?? null, history: writer.history(id) }));
	save('reconcile-detail.json', {
		lost: detail(rec.lost),
		stale: detail(rec.stale),
		resurrected: detail(rec.resurrected),
		anomalies: anomalies.map((a) => ({ ...a, at: new Date(a.t0).toISOString() })),
	});
	console.log(JSON.stringify(report, null, 2));
	record('final state: no acknowledged write is lost', rec.lost.length === 0, rec.lost.join(', '));
	record('final state: no older value won', rec.stale.length === 0, rec.stale.join(', '));
	record('final state: no deleted key came back', rec.resurrected.length === 0, rec.resurrected.join(', '));
	record('the writer saw no answer that disagrees with its acknowledged writes', anomalies.length === 0, JSON.stringify(report.anomaliesSeenByTheWriter));

	heading('The fixture after the migration');
	const stats = await migrationStats(aws);
	save('migration-stats.json', stats);
	// A drain that ends before the update of the app leaves the last writes of the old code out of the new table.
	const drains = Object.entries(stats).filter(([name]) => name.endsWith('Drain')).map(([name, s]) => ({ name, switch: (s as { switch?: string }).switch }));
	record('every drain followed its old table through the update of the app', drains.length > 0 && drains.every((d) => d.switch === 'updated'), drains.map((d) => `${d.name}: ${d.switch}`).join(', '));
	const dumpAfter = await rpc(ctx.apiUrl, 'dump');
	save('dump-after.json', dumpAfter);
	record('the app reads back every fixture value, equal', same(dumpBefore, dumpAfter));
	const byName = await rpc(ctx.apiUrl, 'byName', ['Ada']);
	record('a query on the new index returns the migrated item', same(byName, [{ key: 'u1', value: { userId: 'u1', name: 'Ada', age: 36 } }]), JSON.stringify(byName));
	const rawOldAfter = await eachStore((store) => aws.rawScan(oldName(store), 'pk'));
	const describeOldAfter = await eachStore((store) => aws.describeTable(oldName(store)));
	const rawNew = await eachStore((store) => aws.rawScan(newName(store), '_bkv_pk'));
	save('raw-new-after-migration.json', rawNew);
	save('describe-old-after.json', describeOldAfter);
	record('the items of the old fixture tables are unchanged', same(rawBefore, rawOldAfter));
	record(
		'each old table has the same TableId; only its stream changed',
		FIXTURE.every((s) => {
			return same({ ...describeBefore[s], StreamSpecification: 0 }, { ...describeOldAfter[s], StreamSpecification: 0 });
		}),
	);
	must('seed again, with the new code', (await rpc(ctx.apiUrl, 'seed')) === 'seeded');
	const rawNewRewritten = await eachStore((store) => aws.rawScan(newName(store), '_bkv_pk'));
	record(
		'a copied item is equal to the item that the new code writes, apart from the marker',
		same(Object.fromEntries(FIXTURE.map((s) => [s, withoutMarker(rawNew[s])])), rawNewRewritten),
	);
	note(`items with the marker after the migration: ${FIXTURE.map((s) => `${s} ${rawNew[s].filter((i) => '_bkv_m' in i).length}/${rawNew[s].length}`).join(', ')}`);

	heading('Deploy 3: the app without migrateFrom');
	const newDescribe = await eachStore((store) => aws.describeTable(newName(store)));
	const removalDiff = await cdkDiff(ctx.finalApp, ctx.env);
	save('removal-cdk-diff.txt', removalDiff);
	save('removal-cdk-diff-changes.json', parseCdkDiff(removalDiff));
	const removal = await deployCheckout(ctx, 'deploy final', ctx.finalApp);
	save('removal-events.json', removal.events);
	must('the third deploy reached UPDATE_COMPLETE', removal.status === 'UPDATE_COMPLETE', `status: ${removal.status}`);
	const tableEvents = removal.events.filter((e) => e.type === TABLE_TYPE);
	for (const [logicalId, name] of Object.entries(tablesBefore)) {
		const statuses = tableEvents.filter((e) => e.id === logicalId).map((e) => e.status);
		note(`${name}: ${statuses.join(' → ') || 'no event'}; exists afterwards: ${await aws.tableExists(name)}`);
	}
	record('the old tables with the default policy are deleted', !(await aws.tableExists(oldName('strings'))) && !(await aws.tableExists(oldName('ledger'))));
	record('the old table with removalPolicy retain is kept, outside the stack', (await aws.tableExists(oldName('docs'))) && !Object.values(await aws.tables()).includes(oldName('docs')));
	const newDescribeAfter = await eachStore((store) => aws.describeTable(newName(store)));
	record('the new tables are untouched by the third deploy (same TableId)', same(newDescribe, newDescribeAfter));
	record('the app still reads every fixture value', same(dumpBefore, await rpc(ctx.apiUrl, 'dump')));
}

// ── Mode: failures ───────────────────────────────────────────────────────────

async function runFailures(ctx: Ctx): Promise<void> {
	const { aws } = ctx;
	must('seed', (await rpc(ctx.apiUrl, 'seed')) === 'seeded');
	await sleep(3_000);
	const dumpBefore = await rpc(ctx.apiUrl, 'dump');
	const rawBefore = await eachStore((store) => aws.rawScan(oldName(store), 'pk'));
	const writer = new Writer(ctx.apiUrl, 6, 10, 60);
	writer.start();
	await sleep(15_000);

	/** Stop the writer for a moment, and compare its acknowledged writes with the table that the app serves from. */
	const summarize = async (phase: string, table: 'old' | 'new') => {
		await writer.quiesce();
		const items =
			table === 'old'
				? ledgerItems(await aws.rawScan(oldName('ledger'), 'pk'), 'release')
				: ledgerItems(await aws.rawScan(newName('ledger'), '_bkv_pk'), 'new');
		const rec = writer.reconcile(items);
		const ops = writer.log.filter((op) => op.phase === phase);
		const out = {
			servedFrom: table,
			calls: ops.length,
			answeredByOldCode: ops.filter((op) => op.rev === 'old').length,
			answeredByNewCode: ops.filter((op) => op.rev === 'new').length,
			writesAcknowledgedByNewCode: ops.filter((op) => op.rev === 'new' && op.kind !== 'get' && op.res === 'ok').length,
			noAnswer: ops.filter((op) => op.res.startsWith('unknown')).length,
			answersThatDisagree: ops.filter((op) => op.anomaly).length,
			finalState: finalState(rec),
		};
		save(`failures-${phase.replace(/\W+/g, '-')}.json`, out);
		save('failures-writer-log.json', writer.log);
		console.log(JSON.stringify(out, null, 1));
		// The writer starts over on every key: what the table holds now is the truth from here.
		for (const s of writer.keys.values()) s.resync = true;
		writer.resume();
		return out;
	};
	const appUpdated = (events: { status: string; id: string }[]) => events.some((e) => /DefaultComputeHandler/.test(e.id) && e.status === 'UPDATE_COMPLETE');
	/** A new table with a retain policy outlives a rollback. The next deploy cannot create it again. */
	const deleteRetainedNewTable = async () => {
		if (!(await aws.deleteTableIfExists(newName('docs')))) return false;
		while (await aws.tableExists(newName('docs'))) await sleep(3_000);
		return true;
	};

	heading('Failure 1: an item that the new layout refuses');
	writer.phase = 'an item is refused';
	await rpc(ctx.apiUrl, 'seedRefused');
	const f1 = await deployCheckout(ctx, 'deploy (refused item)', ctx.afterApp);
	save('failure1-events.json', f1.events);
	const refusal = failedResources(f1.events).filter((line) => /cannot be stored in the new layout/.test(line));
	record('the deploy rolled back, and the error names the item', f1.status === 'UPDATE_ROLLBACK_COMPLETE' && refusal.length > 0, refusal[0] ?? failedResources(f1.events).slice(0, 3).join('\n'));
	record('the app was not updated', !appUpdated(f1.events));
	const s1 = await summarize('an item is refused', 'old');
	record('the app holds every acknowledged write', s1.finalState.lost + s1.finalState.stale + s1.finalState.resurrected === 0 && s1.answeredByNewCode === 0);
	// The user's fix: change or delete the item in the old table.
	await aws.ddbClient.send(new aws.ddb.DeleteItemCommand({ TableName: oldName('docs'), Key: { pk: { S: 'refused' } } }));
	const rawAfter = await eachStore((store) => aws.rawScan(oldName(store), 'pk'));
	record('the items of the old tables are unchanged', same(rawBefore, rawAfter));
	record('the new tables with a delete policy are gone', !(await aws.tableExists(newName('strings'))) && !(await aws.tableExists(newName('ledger'))));

	heading('Failure 2: deploy again while a retained new table is still there');
	// `docs-v2` has `protection: 'retained'`, as every table has under the production preset.
	const leftBehind = await aws.tableExists(newName('docs'));
	record('the rollback left the retained new table in the account', leftBehind);
	if (leftBehind) {
		writer.phase = 'deploy over a retained table';
		const f2 = await deployCheckout(ctx, 'deploy (table exists)', ctx.afterApp);
		save('failure2-events.json', f2.events);
		record('CloudFormation refused the deploy before it changed the stack', f2.error !== undefined && f2.events.length === 0, `status: ${f2.status}; stack events: ${f2.events.length}`);
		await deleteRetainedNewTable();
		note('deleted the retained new table by hand, so that the next deploy can create it');
	}

	heading('Failure 3: a failure after the app is updated');
	writer.phase = 'failure after the update';
	const f3 = await deployCheckout(ctx, 'deploy (late failure)', ctx.afterApp, { KV_UPGRADE_LATE_FAILURE: '1' });
	save('failure3-events.json', f3.events);
	save('failure3-timeline.json', timeline(f3.events));
	record('the deploy rolled back after the app was updated', f3.status === 'UPDATE_ROLLBACK_COMPLETE' && appUpdated(f3.events), failedResources(f3.events).slice(0, 2).join('\n'));
	const s3 = await summarize('failure after the update', 'old');
	note(`the new code acknowledged ${s3.writesAcknowledgedByNewCode} writes before the rollback; the old table has none of them. Answers of the old code that disagreed with them: ${s3.answersThatDisagree}`);
	record('the app serves the fixture from the old tables again', same(dumpBefore, await rpc(ctx.apiUrl, 'dump')));
	if (await deleteRetainedNewTable()) note('the retained new table was left behind again; deleted it by hand');

	heading('Rerun after the failures');
	writer.phase = 'rerun';
	const f4 = await deployCheckout(ctx, 'deploy (rerun)', ctx.afterApp);
	save('rerun-events.json', f4.events);
	must('the rerun reached UPDATE_COMPLETE', f4.status === 'UPDATE_COMPLETE', `status: ${f4.status}\n${failedResources(f4.events).slice(0, 3).join('\n')}`);
	await sleep(15_000);
	const s4 = await summarize('rerun', 'new');
	record('the rerun lost nothing, and the writer saw no answer that disagrees', s4.finalState.lost + s4.finalState.stale + s4.finalState.resurrected + s4.answersThatDisagree === 0);
	await writer.stop();
	record('the app serves the fixture from the new tables', same(dumpBefore, await rpc(ctx.apiUrl, 'dump')));
}

// ── Mode: scale ──────────────────────────────────────────────────────────────

async function runScale(ctx: Ctx): Promise<void> {
	const { aws } = ctx;
	heading(`Seed ${bigItems} items in the layout of the release`);
	const seeded = await aws.seedRelease(oldName('big'), bigItems);
	note(`seeded in ${Math.round(seeded.ms / 1000)} s, ${Math.round(seeded.writeUnits)} write units`);
	const before = await aws.count(oldName('big'));
	must('the old table holds every item', before === bigItems, `count ${before}`);
	heading('Deploy 2: the migration');
	const migration = await deployCheckout(ctx, 'deploy migration', ctx.afterApp);
	save('scale-events.json', migration.events);
	must('the migration deploy reached UPDATE_COMPLETE', migration.status === 'UPDATE_COMPLETE', `status: ${migration.status}\n${failedResources(migration.events).slice(0, 3).join('\n')}`);
	const stats = await migrationStats(aws);
	const after = await aws.count(newName('big'));
	const moments = timeline(migration.events);
	const bigCopy = migration.events.filter((e) => /BlocksKvMigrateCopy/.test(e.type) && /bigv2/i.test(e.id) && e.status !== 'CREATE_FAILED');
	const result = {
		items: bigItems,
		seed: seeded,
		copy: stats.KvMigratebigv2Copy,
		drain: stats.KvMigratebigv2Drain,
		copyResourceSeconds: bigCopy.length >= 2 ? (Date.parse(bigCopy.at(-1)?.at ?? '') - Date.parse(bigCopy[0].at)) / 1000 : null,
		deploySeconds: Math.round((migration.ended - migration.started) / 1000),
		timeline: moments,
		newTableCount: after,
		sample: (await rpc(ctx.apiUrl, 'dump') as { bigSample: unknown }).bigSample,
	};
	save('scale.json', result);
	console.log(JSON.stringify(result, null, 2));
	record('the new table holds every item', after === bigItems, `count ${after}`);
	record('a sample reads back through the app', same(result.sample, [{ n: 0, s: 'x'.repeat(40) }, { n: 500, s: 'x'.repeat(40) }]), JSON.stringify(result.sample));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runReal(): Promise<number> {
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
		if (mode === 'writer') await runWriter(ctx);
		else if (mode === 'failures') await runFailures(ctx);
		else await runScale(ctx);
	} catch (error) {
		failed = true;
		console.error(error instanceof HarnessFailure ? `\n✘ stopped: ${error.message}` : error);
	} finally {
		await Promise.all(writers.map((w) => w.stop())).catch(() => undefined);
		if (writers.length > 0) save('writer-log-at-exit.json', writers[0].log);
		const finalApp = ctx?.finalApp ?? materialize(PR_ROOT, 'final', 'backend.kv-migrate.ts.txt', 'sandbox', true);
		gone = await destroy(aws, finalApp, driverEnv(baseEnv)).catch((e: unknown) => (console.error(e), false));
	}
	save('checks.json', checks);
	console.log(`\nUPGRADE_KV_STORE_RESULT=${failed ? 'STOPPED' : 'DONE'} mode=${mode} checks=${checks.filter((c) => c.ok).length}/${checks.length} stack=${stackName}${gone ? '' : ' orphaned=true'}`);
	return gone ? (failed ? 1 : 0) : 3;
}

if (mode === 'options') {
	const code = await runOptions();
	save('checks.json', checks);
	console.log(`\nUPGRADE_KV_STORE_RESULT=DONE mode=options checks=${checks.filter((c) => c.ok).length}/${checks.length}`);
	process.exitCode = code;
} else process.exit(await runReal());
