// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * UPGRADE E2E, DistributedDatabase to Database — proves that an app with a
 * `DistributedDatabase` of the last release of `@aws-blocks/bb-distributed-data`
 * (0.3.0) keeps its Aurora DSQL cluster and its rows when the block becomes a
 * `Database` with the same id on this checkout. Two deploys on one stack:
 *
 * 1. the fixture app on the release (`app/backend.dsql-release.ts.txt`), with
 *    one migration file;
 * 2. the same app on this checkout (`app/backend.dsql-database.ts.txt`), with
 *    that file and a second one.
 *
 * ## How to run
 *
 * From `test-apps/comprehensive`, after `npm run build` at the repo root and
 * in a built checkout of the release
 * (`git worktree add <dir> @aws-blocks/bb-distributed-data@0.3.0`):
 *
 *     npm run test:upgrade-distributed-database -- --mode diff --base-dir <release checkout> --evidence <dir>
 *     BLOCKS_UPGRADE_E2E=1 AWS_PROFILE=<sandbox> AWS_REGION=<region> \
 *         npm run test:upgrade-distributed-database -- --mode upgrade --base-dir <release checkout> --evidence <dir>
 *
 * - `--mode diff` (offline): under both presets, the cluster has the same
 *   logical id in the two templates, and `cdk diff` does not add, remove or
 *   replace it.
 * - `--mode upgrade`: after deploy 2 the stack has the same cluster (the same
 *   identifier), the rows of the release read back equal through `Database`,
 *   the first migration file did not run again, the second one did, and the
 *   app writes to the old table and to the new one.
 *
 * Every method of the fixture API needs a SigV4-signed caller of the account;
 * the run checks that an unsigned call is refused.
 *
 * The AWS mode refuses to start unless `BLOCKS_UPGRADE_E2E=1`, `AWS_REGION` and
 * an explicit credential source are set. It takes about 10 minutes. It is
 * long-running: start it in the background and read the log for the final
 * `UPGRADE_DISTRIBUTED_DATABASE_RESULT=` line. **Cleanup:** the stack is
 * destroyed in a `finally`. It never deploys into a stack that exists.
 *
 * A run writes its report files in `--evidence`. It writes the fixture apps
 * under `test-apps/.upgrade-in-place/` in both checkouts, and removes them at
 * the end.
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
const CLUSTER_TYPE = 'AWS::DSQL::Cluster';
const RELEASE = { backend: 'backend.dsql-release.ts.txt', migrations: ['001_create_accounts.sql'] };
const UPGRADED = {
	backend: 'backend.dsql-database.ts.txt',
	migrations: ['001_create_accounts.sql', '002_create_notes.sql'],
};
// Appended to the CDK entry of both revisions: the API reads and writes real rows.
const IAM_ONLY = `
cdk.Aspects.of(app).add({
	visit(node) {
		if (node instanceof cdk.aws_apigateway.CfnMethod) node.authorizationType = 'AWS_IAM';
	},
});
`;

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}
const mode = arg('--mode') ?? 'diff';
const baseDir = arg('--base-dir');
const evidenceDir = arg('--evidence');
// Two runs that start in the same millisecond must not share a stack: the process id is in the name.
const suffix = arg('--suffix') ?? `upgrade-dd${Date.now().toString(36)}p${process.pid.toString(36)}`;
const MODES = ['diff', 'upgrade'];
if (!MODES.includes(mode) || !baseDir || !evidenceDir || !SUFFIX_PATTERN.test(suffix)) {
	console.error(
		`usage: upgrade-distributed-database.ts --mode ${MODES.join('|')} --base-dir <dir> --evidence <dir> [--suffix upgrade-…]`,
	);
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

function run(label: string, command: string, args: readonly string[], options: { cwd: string; env: Env }) {
	return new Promise<string>((resolvePromise, reject) => {
		if (interrupted) return reject(new HarnessFailure('interrupted'));
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
		currentChild = child;
		const chunks: string[] = [];
		child.stdout?.on('data', (data: Buffer) => chunks.push(data.toString('utf8')));
		child.stderr?.on('data', (data: Buffer) => chunks.push(data.toString('utf8')));
		child.on('error', reject);
		child.on('close', (code) => {
			currentChild = undefined;
			const output = chunks.join('');
			if (code === 0) return resolvePromise(output);
			console.log(output.trimEnd().split('\n').slice(-40).join('\n'));
			reject(new HarnessFailure(`${label}: exited with ${code}`));
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

/** Write a fixture app into a checkout: the backend, its migration files, and the CDK entry with IAM-only methods. */
function materialize(
	treeRoot: string,
	variant: string,
	app: typeof RELEASE,
	preset: 'sandbox' | 'production' = 'sandbox',
): string {
	const dir = join(treeRoot, 'test-apps', '.upgrade-in-place', `${suffix}-${variant}`);
	rmSync(dir, { recursive: true, force: true });
	fixtureApps.push(dir);
	for (const sub of ['aws-blocks/migrations', 'scripts', '.blocks']) mkdirSync(join(dir, sub), { recursive: true });
	const cdkEntry = readFileSync(join(APP, 'index.cdk.ts'), 'utf8').replace(
		'BlocksPresets.sandbox',
		`BlocksPresets.${preset}`,
	);
	writeFileSync(join(dir, 'aws-blocks', 'index.cdk.ts'), cdkEntry + IAM_ONLY);
	copyFileSync(join(APP, app.backend), join(dir, 'aws-blocks', 'index.ts'));
	for (const file of app.migrations) {
		copyFileSync(join(APP, 'dsql-migrations', file), join(dir, 'aws-blocks', 'migrations', file));
	}
	writeFileSync(
		join(dir, 'aws-blocks', 'index.handler.ts'),
		"import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';\n\nexport const handler = createLambdaHandler(() => import('./index.js'));\n",
	);
	copyFileSync(join(APP, 'deploy.ts'), join(dir, 'scripts', 'deploy.ts'));
	copyFileSync(join(APP, 'destroy.ts'), join(dir, 'scripts', 'destroy.ts'));
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

const cdkEnv = (base: Env): Env => ({
	...base,
	NODE_OPTIONS: '--conditions=cdk',
	BLOCKS_STACK_SUFFIX: suffix,
	BLOCKS_STAGE: 'production',
});
function driverEnv(base: Env): Env {
	const { NODE_OPTIONS: _ignored, ...rest } = base;
	return { ...rest, BLOCKS_STACK_SUFFIX: suffix };
}

async function synth(appDir: string, treeRoot: string, env: Env) {
	const out = join(appDir, 'cdk.out');
	rmSync(out, { recursive: true, force: true });
	await run('synth', bin(treeRoot, 'cdk'), ['synth', '--quiet', '--context', `projectRoot=${appDir}`, '--output', out], {
		cwd: appDir,
		env,
	});
	const path = join(out, `${stackName}.template.json`);
	return { template: JSON.parse(readFileSync(path, 'utf8')) as CfnTemplate, path };
}

function cdkDiff(appDir: string, env: Env, templatePath?: string): Promise<string> {
	const args = [
		'diff',
		stackName,
		'--no-color',
		'--context',
		`projectRoot=${appDir}`,
		'--output',
		join(appDir, 'cdk.out.diff'),
		...(templatePath ? ['--template', templatePath] : []),
	];
	return run('cdk diff', bin(PR_ROOT, 'cdk'), args, { cwd: appDir, env });
}

const resourcesOfType = (template: CfnTemplate, type: string) =>
	Object.entries(template.Resources ?? {}).filter(([, resource]) => resource.Type === type);

/** The `cdk diff` line of the cluster, when the deploy touches it. A changed tag is not a replacement. */
function clusterChange(diffText: string, logicalId: string) {
	const change = parseCdkDiff(diffText).find((c) => c.type === CLUSTER_TYPE || c.logicalId === logicalId);
	return { change, kept: change === undefined || (change.action === 'update' && change.impact === 'none') };
}

const unsignedMethods = (template: CfnTemplate) =>
	resourcesOfType(template, 'AWS::ApiGateway::Method')
		.filter(([, method]) => (method.Properties as { AuthorizationType?: string }).AuthorizationType !== 'AWS_IAM')
		.map(([logicalId]) => logicalId);

// ── Mode diff: the cluster in the two templates, offline ─────────────────────

async function runDiff(): Promise<number> {
	const result: Record<string, unknown> = {};
	for (const preset of ['sandbox', 'production'] as const) {
		heading(`Templates, ${preset} preset`);
		const env = cdkEnv(offlineEnv(process.env));
		const release = await synth(materialize(BASE_ROOT, `d-release-${preset}`, RELEASE, preset), BASE_ROOT, env);
		const upgradedApp = materialize(PR_ROOT, `d-database-${preset}`, UPGRADED, preset);
		const upgraded = await synth(upgradedApp, PR_ROOT, env);
		const diffText = await cdkDiff(upgradedApp, env, release.path);
		save(`diff-${preset}.txt`, diffText);

		const before = resourcesOfType(release.template, CLUSTER_TYPE);
		const after = resourcesOfType(upgraded.template, CLUSTER_TYPE);
		must(`${preset}: each template declares one cluster`, before.length === 1 && after.length === 1);
		const [[idBefore, clusterBefore]] = before;
		const [[idAfter, clusterAfter]] = after;
		record(`${preset}: the cluster has the same logical id`, idBefore === idAfter, `${idBefore} → ${idAfter}`);
		record(
			`${preset}: the cluster keeps its deletion policy and its deletion protection`,
			clusterBefore.DeletionPolicy === clusterAfter.DeletionPolicy &&
				same(
					(clusterBefore.Properties as { DeletionProtectionEnabled?: boolean }).DeletionProtectionEnabled,
					(clusterAfter.Properties as { DeletionProtectionEnabled?: boolean }).DeletionProtectionEnabled,
				),
			`DeletionPolicy ${String(clusterBefore.DeletionPolicy)} → ${String(clusterAfter.DeletionPolicy)}`,
		);
		const { change, kept } = clusterChange(diffText, idBefore);
		record(`${preset}: cdk diff does not add, remove or replace the cluster`, kept, change?.line ?? '(no change)');
		record(
			`${preset}: every API method of both revisions needs a signed caller`,
			unsignedMethods(release.template).length === 0 && unsignedMethods(upgraded.template).length === 0,
		);
		const other = parseCdkDiff(diffText).filter((c) => c.logicalId !== idBefore);
		note(`other resources in the diff: ${other.length} (${other.filter((c) => c.action === 'remove').length} removed)`);
		result[preset] = { logicalId: { before: idBefore, after: idAfter }, clusterChange: change?.line ?? null };
	}
	save('diff.json', result);
	return checks.some((c) => !c.ok) ? 1 : 0;
}

// ── AWS ──────────────────────────────────────────────────────────────────────

async function createAws(region: string) {
	const cfn = await import('@aws-sdk/client-cloudformation');
	const sts = await import('@aws-sdk/client-sts');
	const { SignatureV4 } = await import('@smithy/signature-v4');
	const { Sha256 } = await import('@aws-crypto/sha256-js');
	const cfnClient = new cfn.CloudFormationClient({ region, maxAttempts: 10 });
	// The credentials that the CloudFormation client resolved, for the calls to the API.
	const signer = new SignatureV4({
		service: 'execute-api',
		region,
		credentials: cfnClient.config.credentials,
		sha256: Sha256,
	});

	const stackStatus = async (): Promise<string | null> => {
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
	return {
		stackStatus,
		async account(): Promise<string> {
			return (await new sts.STSClient({ region }).send(new sts.GetCallerIdentityCommand({}))).Account ?? '?';
		},
		async waitForTerminal(): Promise<string | null> {
			const deadline = Date.now() + 60 * 60_000;
			for (;;) {
				const status = await stackStatus();
				if (status === null || !status.endsWith('_IN_PROGRESS') || Date.now() > deadline) return status;
				await sleep(10_000);
			}
		},
		/** Logical id → cluster identifier of every cluster in the stack. */
		async clusters(): Promise<Record<string, string>> {
			const ids: Record<string, string> = {};
			for await (const page of cfn.paginateListStackResources({ client: cfnClient }, { StackName: stackName })) {
				for (const r of page.StackResourceSummaries ?? []) {
					if (r.ResourceType === CLUSTER_TYPE && r.LogicalResourceId && r.PhysicalResourceId) {
						ids[r.LogicalResourceId] = r.PhysicalResourceId;
					}
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
					events.push({
						at: e.Timestamp?.toISOString() ?? '',
						id: e.LogicalResourceId ?? '',
						type: e.ResourceType ?? '',
						status: e.ResourceStatus ?? '',
						...(e.ResourceStatusReason ? { reason: e.ResourceStatusReason } : {}),
					});
				}
				token = out.NextToken;
				if (older || !token) break;
			}
			return events.reverse();
		},
		async deleteStack(): Promise<void> {
			await cfnClient.send(new cfn.DeleteStackCommand({ StackName: stackName }));
		},
		/** One JSON-RPC call. `signed: false` sends it without a signature and returns the HTTP status. */
		async call(apiUrl: string, body: string, signed = true): Promise<Response> {
			const url = new URL(apiUrl);
			const unsigned = { 'content-type': 'application/json', host: url.host };
			const headers = signed
				? (
						await signer.sign({
							method: 'POST',
							protocol: 'https:',
							hostname: url.host,
							path: url.pathname,
							headers: unsigned,
							body,
						})
					).headers
				: unsigned;
			return fetch(apiUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(90_000) });
		},
	};
}
type Aws = Awaited<ReturnType<typeof createAws>>;

async function rpc(aws: Aws, apiUrl: string, method: string, args: readonly unknown[] = []): Promise<unknown> {
	const retries = 4;
	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const res = await aws.call(apiUrl, encodeRpcRequest('api', method, args, attempt));
			if (![502, 503, 504].includes(res.status) || attempt === retries) {
				const outcome = decodeRpcResponse(await res.json().catch(() => null));
				if (outcome.ok) return outcome.result;
				throw new HarnessFailure(
					`api.${method}: HTTP ${res.status}, RPC error ${outcome.code} ${outcome.name ?? ''}: ${outcome.message}`,
				);
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
	// The directory name of the release, and the one of this checkout.
	for (const dir of ['.cdk-blocks-sandbox', '.blocks-sandbox']) {
		for (const doc of ['outputs.production.json', 'outputs.json']) {
			const path = join(appDir, dir, doc);
			if (!existsSync(path)) continue;
			const url = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>)[stackName]?.ApiUrl;
			if (url) return url;
		}
	}
	throw new HarnessFailure(`no ApiUrl output for ${stackName} in ${appDir}`);
}

const failedResources = (events: { status: string; id: string; reason?: string }[]) =>
	events
		.filter((e) => e.status.endsWith('FAILED') && !/cancelled|following resource/.test(e.reason ?? ''))
		.map((e) => `${e.id}: ${e.reason}`);

// ── Mode: upgrade ────────────────────────────────────────────────────────────

async function runUpgrade(aws: Aws, baseEnv: Env, upgradedApp: string): Promise<void> {
	const deployEnv = driverEnv(baseEnv);
	const releaseApp = materialize(BASE_ROOT, 'release', RELEASE);

	heading('Deploy 1: the app on the release, with DistributedDatabase');
	await run('deploy release', bin(BASE_ROOT, 'tsx'), [join(releaseApp, 'scripts', 'deploy.ts')], {
		cwd: releaseApp,
		env: deployEnv,
	}).catch((error: unknown) => record('release deploy succeeded', false, String(error)));
	const created = await aws.waitForTerminal();
	must('release stack is CREATE_COMPLETE', created === 'CREATE_COMPLETE', `status: ${created}`);
	const apiUrl = readApiUrl(releaseApp);

	heading('Rows of the release');
	const refused = await aws.call(apiUrl, encodeRpcRequest('api', 'dump', []), false);
	must('an unsigned call is refused', refused.status === 403, `HTTP ${refused.status}`);
	must('seed', (await rpc(aws, apiUrl, 'seed')) === 'seeded');
	const dumpBefore = await rpc(aws, apiUrl, 'dump');
	save('dump-before.json', dumpBefore);
	must('the release reads three rows', Array.isArray(dumpBefore) && dumpBefore.length === 3);
	const clustersBefore = await aws.clusters();
	save('clusters-before.json', clustersBefore);
	must('the release stack has one cluster', Object.keys(clustersBefore).length === 1);
	const [[logicalId, clusterId]] = Object.entries(clustersBefore);

	heading('Deploy 2: the same app on this checkout, with Database');
	const diffText = await cdkDiff(upgradedApp, cdkEnv(baseEnv));
	save('upgrade-cdk-diff.txt', diffText);
	const { change, kept } = clusterChange(diffText, logicalId);
	record('cdk diff against the stack does not add, remove or replace the cluster', kept, change?.line ?? '(no change)');
	const started = Date.now();
	// A deploy that fails is read from the stack status and the events below.
	await run('deploy upgrade', bin(PR_ROOT, 'tsx'), [join(upgradedApp, 'scripts', 'deploy.ts')], {
		cwd: upgradedApp,
		env: deployEnv,
	}).catch(() => undefined);
	const updated = await aws.waitForTerminal();
	const events = await aws.eventsSince(started - 5_000);
	save('upgrade-events.json', events);
	must(
		'the upgrade deploy reached UPDATE_COMPLETE',
		updated === 'UPDATE_COMPLETE',
		`status: ${updated}\n${failedResources(events).join('\n')}`,
	);
	const clusterEvents = events.filter((e) => e.type === CLUSTER_TYPE).map((e) => `${e.id} ${e.status}`);
	record(
		'CloudFormation did not create or delete a cluster',
		!clusterEvents.some((e) => /CREATE|DELETE/.test(e)),
		clusterEvents.join(', ') || '(no cluster event)',
	);
	const clustersAfter = await aws.clusters();
	save('clusters-after.json', clustersAfter);
	record(
		'the stack has the same cluster under the same logical id',
		same(clustersBefore, clustersAfter),
		`${logicalId}: ${clusterId} → ${clustersAfter[logicalId] ?? '(absent)'}`,
	);

	heading('The rows through Database');
	const upgradedUrl = readApiUrl(upgradedApp);
	const dumpAfter = await rpc(aws, upgradedUrl, 'dump');
	save('dump-after.json', dumpAfter);
	record('Database reads back every row of the release, equal', same(dumpBefore, dumpAfter));
	const balance = await rpc(aws, upgradedUrl, 'deposit', ['u2', 'checking', 25]);
	// DSQL prints a NUMERIC with its scale: 25.000000.
	record('a transaction updates a row of the release', Number(balance) === 25, `balance: ${String(balance)}`);
	const notes = await rpc(aws, upgradedUrl, 'addNote', ['n1', 'written after the upgrade']);
	record(
		'the second migration file ran: the app writes to and reads from its table',
		same(notes, [{ id: 'n1', body: 'written after the upgrade' }]),
		JSON.stringify(notes),
	);
}

async function destroy(aws: Aws, appDir: string, deployEnv: Env): Promise<boolean> {
	heading(`Destroy ${stackName}`);
	let status = await aws.waitForTerminal();
	if (status !== null && status !== 'DELETE_COMPLETE') {
		interrupted = false;
		await run('destroy', bin(PR_ROOT, 'tsx'), [join(appDir, 'scripts', 'destroy.ts')], {
			cwd: appDir,
			env: deployEnv,
		}).catch((e: unknown) => console.error(e));
		status = await aws.waitForTerminal();
		if (status !== null && status !== 'DELETE_COMPLETE') {
			await aws.deleteStack().catch((e: unknown) => console.error(e));
			status = await aws.waitForTerminal();
		}
	}
	const gone = status === null || status === 'DELETE_COMPLETE';
	console.log(gone ? `  ✔ ${stackName} is deleted.` : `  ✘ STACK LEFT BEHIND: ${stackName}, status ${status}`);
	return gone;
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
		console.log(`AWS account ${await aws.account()}, region ${region}. Stack ${stackName}.`);
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
	const upgradedApp = materialize(PR_ROOT, 'database', UPGRADED);
	let failed = false;
	let gone = false;
	try {
		await runUpgrade(aws, baseEnv, upgradedApp);
	} catch (error) {
		failed = true;
		console.error(error instanceof HarnessFailure ? `\n✘ stopped: ${error.message}` : error);
	} finally {
		gone = await destroy(aws, upgradedApp, driverEnv(baseEnv)).catch((e: unknown) => (console.error(e), false));
		removeFixtureApps();
	}
	save('checks.json', checks);
	failed ||= checks.some((c) => !c.ok);
	console.log(
		`\nUPGRADE_DISTRIBUTED_DATABASE_RESULT=${failed ? 'FAILED' : 'PASSED'} mode=${mode} checks=${checks.filter((c) => c.ok).length}/${checks.length} stack=${stackName}${gone ? '' : ' orphaned=true'}`,
	);
	return gone ? (failed ? 1 : 0) : 3;
}

if (mode === 'diff') {
	const code = await runDiff()
		.catch((error: unknown) => {
			console.error(error instanceof HarnessFailure ? `\n✘ stopped: ${error.message}` : error);
			return 1;
		})
		.finally(removeFixtureApps);
	save('checks.json', checks);
	console.log(
		`\nUPGRADE_DISTRIBUTED_DATABASE_RESULT=${code === 0 ? 'PASSED' : 'FAILED'} mode=diff checks=${checks.filter((c) => c.ok).length}/${checks.length}`,
	);
	process.exitCode = code;
} else process.exit(await runReal());
