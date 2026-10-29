// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { stubComputeFactory } from '../cdk/__fixtures__/stub-lambda-compute.js';
import { type BlocksDefaults, BlocksPresets } from '../cdk/blocks-defaults.js';
import { BlocksStack } from '../cdk/index.js';
import { config, secret } from '@aws-blocks/hosting';
import { Hosting } from '../hosting.js';
import { checkCloudAssembly, IamCheckUsageError } from './iam-check.js';
import { generateExecutionPolicy, resourceTypesOf } from './iam-policies.js';

/** On a shared platform each app's bootstrap qualifier is its app id. */
const QUALIFIER = { '@aws-cdk/core:bootstrapQualifier': 'appa' };

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, '..', 'cdk', '__fixtures__', name);
const cli = join(__dirname, 'iam-check-cli.js');

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Synthesize a one-stack app into a fresh cloud assembly; returns its directory. */
async function synth(
	backend: string,
	defaults: BlocksDefaults,
	stackId = 'appa',
	extra?: (app: cdk.App) => void,
): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-iam-check-'));
	dirs.push(dir);
	const app = new cdk.App({ outdir: dir, context: QUALIFIER });
	await BlocksStack.create(app, stackId, {
		backendHandlerPath: fixture('handler.js'),
		backendCDKPath: fixture(backend),
		defaults,
		defaultComputeFactory: stubComputeFactory,
	});
	extra?.(app);
	app.synth();
	return dir;
}

const appDefaults: BlocksDefaults = { ...BlocksPresets.production, app: { id: 'appa' }, permissionsBoundary: 'apps-boundary' };

describe('blocks-iam-check', () => {
	test('a well-behaved app passes', async () => {
		const result = checkCloudAssembly(await synth('app-identity-backend.js', appDefaults), 'appa');
		assert.deepStrictEqual(result.violations, []);
		assert.deepStrictEqual(result.appIds, ['appa']);
		assert.ok(result.templates.length >= 1);
	});

	test('an overreaching app fails, from the templates as well as the report', async () => {
		const result = checkCloudAssembly(await synth('app-identity-violations-backend.js', appDefaults), 'appa');
		const fromTemplates = new Set(result.violations.filter((v) => v.source.endsWith('.template.json')).map((v) => v.rule));
		assert.deepStrictEqual([...fromTemplates].sort(), ['broad-managed-policy', 'grant-outside-app', 'wildcard-data-grant']);
	});

	test('a faked report (violations removed) still fails on the templates', async () => {
		const dir = await synth('app-identity-violations-backend.js', appDefaults);
		const file = join(dir, 'appa.blocks-iam.json');
		const report = JSON.parse(readFileSync(file, 'utf8'));
		writeFileSync(file, JSON.stringify({ ...report, violations: [] }));
		const rules = new Set(checkCloudAssembly(dir, 'appa').violations.map((v) => v.rule));
		assert.ok(rules.has('grant-outside-app'), [...rules].join(', '));
	});

	test("a stack the report doesn't mention is still checked", async () => {
		const dir = await synth('app-identity-backend.js', appDefaults, 'appa', (app) => {
			const side = new cdk.Stack(app, 'sidecar');
			const role = new iam.Role(side, 'Escape', { assumedBy: new iam.AccountPrincipal('222222222222') });
			role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: ['arn:aws:ssm:us-east-1:111111111111:parameter/appb-db-password'] }));
		});
		const rules = new Set(checkCloudAssembly(dir, 'appa').violations.map((v) => v.rule));
		for (const rule of ['stack-name-outside-app', 'role-without-boundary', 'role-tag-mismatch', 'role-trust-not-service', 'grant-outside-app']) {
			assert.ok(rules.has(rule as never), `${rule} missing from ${[...rules].join(', ')}`);
		}
	});

	test('stacks in a Stage (a nested cloud assembly) and nested stacks are checked too', async () => {
		const dir = await synth('app-identity-backend.js', appDefaults, 'appa', (app) => {
			const stage = new cdk.Stage(app, 'Extra');
			new iam.Role(new cdk.Stack(stage, 'appa-staged'), 'InStage', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
			const parent = new cdk.Stack(app, 'appa-parent');
			new iam.Role(new cdk.NestedStack(parent, 'Child'), 'InNested', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		});
		const untagged = checkCloudAssembly(dir, 'appa')
			.violations.filter((v) => v.rule === 'role-tag-mismatch')
			.map((v) => v.path ?? '');
		assert.ok(untagged.some((p) => p.includes('InStage')), `Stage role not checked: ${untagged.join(', ')}`);
		assert.ok(untagged.some((p) => p.includes('InNested')), `nested-stack role not checked: ${untagged.join(', ')}`);
	});

	test('an app that claims another id fails', async () => {
		const dir = await synth('app-identity-backend.js', appDefaults);
		const rules = new Set(checkCloudAssembly(dir, 'appb').violations.map((v) => v.rule));
		for (const rule of ['app-id-mismatch', 'role-tag-mismatch', 'stack-tag-mismatch', 'stack-name-outside-app']) {
			assert.ok(rules.has(rule as never), `${rule} missing from ${[...rules].join(', ')}`);
		}
	});

	test('an app without defaults.app fails, and every role is reported unbounded and untagged', async () => {
		const dir = await synth('app-identity-backend.js', BlocksPresets.production);
		const rules = new Set(checkCloudAssembly(dir, 'appa').violations.map((v) => v.rule));
		for (const rule of ['app-id-mismatch', 'role-without-boundary', 'role-tag-mismatch']) {
			assert.ok(rules.has(rule as never), `${rule} missing from ${[...rules].join(', ')}`);
		}
	});

	test('no cloud assembly / no report: a usage error', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'blocks-iam-check-empty-'));
		dirs.push(empty);
		assert.throws(() => checkCloudAssembly(empty), IamCheckUsageError);
		writeFileSync(join(empty, 'manifest.json'), '{"artifacts":{}}');
		assert.throws(() => checkCloudAssembly(empty), /no AWS Blocks IAM report/);
	});

	test('the CLI exits 0 when clean, 1 on violations, 2 on a usage error', async () => {
		const clean = await synth('app-identity-backend.js', appDefaults);
		const bad = await synth('app-identity-violations-backend.js', appDefaults);
		const run = (args: string[]) => {
			try {
				execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' });
				return 0;
			} catch (error) {
				return (error as { status?: number }).status;
			}
		};
		assert.strictEqual(run([clean, '--app', 'appa']), 0);
		assert.strictEqual(run([bad, '--app', 'appa']), 1);
		assert.strictEqual(run([clean, '--app']), 2);
		// A reserved id: its `<id>-…` names would cover other apps' resources.
		assert.strictEqual(run([clean, '--app', 'cdk']), 2);
	});

	test('a reserved app id: --app is a usage error, and a report that claims one is a violation', async () => {
		const clean = await synth('app-identity-backend.js', appDefaults);
		assert.throws(() => checkCloudAssembly(clean, 'blocks'), /--app: "blocks" is reserved/);
		assert.throws(() => checkCloudAssembly(clean, 'awsapp'), /reserved prefix "aws"/);
		// The report is written by the app's own synth: a reserved id in it isn't trusted.
		const forged = mkdtempSync(join(tmpdir(), 'blocks-iam-check-reserved-'));
		dirs.push(forged);
		cpSync(clean, forged, { recursive: true });
		for (const file of readdirSync(forged).filter((f) => f.endsWith('.blocks-iam.json'))) {
			const report = JSON.parse(readFileSync(join(forged, file), 'utf8'));
			report.app.id = 'cdk';
			writeFileSync(join(forged, file), JSON.stringify(report));
		}
		const result = checkCloudAssembly(forged);
		assert.ok(result.violations.some((v) => v.rule === 'invalid-app-id' && /"cdk" is reserved/.test(v.message)));
	});

	test('an app that calls execute-api (a WebSocket API) gets a note, not a violation', async () => {
		const clean = checkCloudAssembly(await synth('app-identity-backend.js', appDefaults), 'appa');
		assert.deepStrictEqual(clean.notes, []);
		const dir = await synth('app-identity-backend.js', appDefaults, 'appa', (app) => {
			new cdk.CfnResource(app.node.findChild('appa') as cdk.Stack, 'Ws', {
				type: 'AWS::ApiGatewayV2::Api',
				properties: { Name: 'appa-ws', ProtocolType: 'WEBSOCKET', RouteSelectionExpression: '$request.body.action' },
			});
		});
		const result = checkCloudAssembly(dir, 'appa');
		assert.deepStrictEqual(result.violations, []);
		assert.strictEqual(result.notes.length, 1);
		assert.match(result.notes[0], /WebSocket API \(Ws\).*--api-id/);
	});
});

describe('blocks-iam-check — Hosting under defaults.app (stackId = app id)', () => {
	const root = mkdtempSync(join(tmpdir(), 'blocks-iam-check-hosting-'));
	dirs.push(root);
	const cwd = process.cwd();
	before(() => {
		// The convention under defaults.app: `.blocks/config.json` names the stackId after the app id,
		// so Hosting's secret()/config() values live under blocks/<id>/.
		mkdirSync(join(root, '.blocks'), { recursive: true });
		writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'appa' }));
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 't', dependencies: { next: '15.0.0', react: '^18' } }));
		mkdirSync(join(root, '.next'), { recursive: true });
		writeFileSync(join(root, '.next', 'BUILD_ID'), 'b');
		for (const fn of ['default', 'edge1']) {
			mkdirSync(join(root, '.hosting', 'compute', fn), { recursive: true });
			writeFileSync(join(root, '.hosting', 'compute', fn, 'index.mjs'), 'export const handler = async (e) => e;');
		}
		mkdirSync(join(root, '.hosting', 'static'), { recursive: true });
		writeFileSync(join(root, '.hosting', 'static', 'index.html'), 'x');
	});

	/** An off-region app (so Hosting adds the us-east-1 support and Lambda@Edge stacks), strict. */
	async function synthHosting(): Promise<string> {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-iam-check-hosting-out-'));
		dirs.push(dir);
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await BlocksStack.create(app, 'appa', {
			env: { account: '111111111111', region: 'eu-west-1' },
			backendHandlerPath: fixture('handler.js'),
			backendCDKPath: fixture('app-identity-backend.js'),
			defaults: { ...appDefaults, app: { id: 'appa', strict: true } },
			defaultComputeFactory: stubComputeFactory,
		});
		const compute = (fn: string) => join(root, '.hosting', 'compute', fn);
		// Hosting reads `stackId` from `.blocks/config.json` in the working directory.
		process.chdir(root);
		try {
			new Hosting(stack, 'Web', {
				root,
				api: stack,
				environment: { DEMO_SECRET: secret('DEMO_SECRET'), FEATURE_FLAGS: config('FEATURE_FLAGS') },
				customAdapter: () => ({
					version: 1 as const,
					compute: {
						default: { type: 'handler' as const, bundle: compute('default'), handler: 'index.handler', placement: 'regional' as const },
						edge1: { type: 'edge' as const, bundle: compute('edge1'), handler: 'index.handler', placement: 'global' as const },
					},
					staticAssets: { directory: join(root, '.hosting', 'static') },
					routes: [
						{ pattern: '/edge/*', target: 'edge1' },
						{ pattern: '/*', target: 'default' },
					],
				}),
			});
		} finally {
			process.chdir(cwd);
		}
		app.synth();
		return dir;
	}

	test('strict synth and the check pass: secret()/config(), cross-region references and the support stacks are the app\'s own', async () => {
		const dir = await synthHosting();
		const result = checkCloudAssembly(dir, 'appa');
		assert.deepStrictEqual(result.violations.map((v) => `[${v.rule}] ${v.message}`), []);
		const names = readdirSync(dir).filter((f) => f.endsWith('.template.json'));
		assert.ok(names.some((f) => f.startsWith('appa-CfMonitoring-')), names.join(', '));
		assert.ok(names.includes('appa-edge.template.json'), names.join(', '));
		const template = readFileSync(join(dir, 'appa.template.json'), 'utf8');
		assert.match(template, /secret:blocks\/appa\/secrets\/DEMO_SECRET/);
		assert.match(template, /parameter\/blocks\/appa\/config\/FEATURE_FLAGS/);
		// Every type Hosting's stacks use has a rule: nothing left for the platform to add by hand.
		const exec = generateExecutionPolicy(resourceTypesOf(names.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))), {
			appId: 'appa',
			account: '111111111111',
		});
		assert.deepStrictEqual(exec.unscoped, []);
		assert.ok(exec.accepted.includes('AWS::CloudFront::OriginAccessControl'), exec.accepted.join(', '));
	});

	test("the us-east-1 support stack and the edge stack are tagged app=<id>: stack tags, and its key, topic and alarm", async () => {
		const dir = await synthHosting();
		const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
			artifacts: Record<string, { type?: string; properties?: { tags?: Record<string, string>; templateFile?: string } }>;
		};
		const stacks = Object.entries(manifest.artifacts).filter(([, a]) => a.type === 'aws:cloudformation:stack');
		const support = stacks.find(([id]) => id.startsWith('appa-CfMonitoring-'));
		assert.ok(support, 'support stack');
		for (const [id, a] of stacks) {
			// A stack tag reaches what a tag aspect can't (CloudFormation propagates it), e.g. CDK's provider function.
			assert.strictEqual(a.properties?.tags?.app, 'appa', `${id} stack tag`);
		}
		const { Resources } = JSON.parse(readFileSync(join(dir, support[1].properties?.templateFile ?? ''), 'utf8')) as {
			Resources: Record<string, { Type: string; Properties?: { Tags?: { Key: string; Value: string }[] } }>;
		};
		const tagged = (type: string) =>
			Object.values(Resources)
				.filter((r) => r.Type === type)
				.map((r) => r.Properties?.Tags?.find((t) => t.Key === 'app')?.Value);
		for (const type of ['AWS::KMS::Key', 'AWS::SNS::Topic', 'AWS::CloudWatch::Alarm', 'AWS::IAM::Role']) {
			const values = tagged(type);
			assert.ok(values.length > 0, `${type} in the support stack`);
			assert.deepStrictEqual(values, values.map(() => 'appa'), type);
		}
		assert.ok(tagged('AWS::Lambda::Function').length > 0, 'the provider function (tagged through the stack tag)');
	});

	test('CloudFront Functions and KeyValueStores are named <id>-<region>-…', async () => {
		const dir = await synthHosting();
		const { Resources } = JSON.parse(readFileSync(join(dir, 'appa.template.json'), 'utf8')) as {
			Resources: Record<string, { Type: string; Properties?: { Name?: unknown } }>;
		};
		const named = Object.values(Resources).filter((r) => /^AWS::CloudFront::(Function|KeyValueStore)$/.test(r.Type));
		assert.ok(named.length >= 2, `${named.length} CloudFront functions / stores`);
		for (const r of named) {
			const name = String(r.Properties?.Name);
			assert.match(name, /^appa-eu-west-1-[A-Za-z0-9_-]+$/, name);
			assert.ok(name.length <= 64, name);
		}
	});
});

