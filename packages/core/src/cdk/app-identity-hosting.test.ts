// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { config, secret } from '@aws-blocks/hosting';
import * as cdk from 'aws-cdk-lib';
import { Hosting } from '../hosting.js';
import { stubComputeFactory } from './__fixtures__/stub-lambda-compute.js';
import type { AppViolation } from './app-isolation-rules.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { BlocksStack } from './index.js';

/** On a shared platform each app's bootstrap qualifier is its app id. */
const QUALIFIER = { '@aws-cdk/core:bootstrapQualifier': 'appa' };

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(__dirname, '__fixtures__', name);

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const appDefaults: BlocksDefaults = {
	...BlocksPresets.production,
	app: { id: 'appa', strict: true },
	permissionsBoundary: 'apps-boundary',
};

type Manifest = {
	artifacts: Record<string, { type?: string; properties?: { tags?: Record<string, string>; templateFile?: string } }>;
};
type Resources = Record<
	string,
	{ Type: string; Properties?: { Name?: unknown; Tags?: { Key: string; Value: string }[] } }
>;
const readJson = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), 'utf8'));

describe('defaults.app — Hosting (stackId = app id)', () => {
	const root = mkdtempSync(join(tmpdir(), 'blocks-app-identity-hosting-'));
	dirs.push(root);
	const cwd = process.cwd();
	before(() => {
		// The convention under defaults.app: `.blocks/config.json` names the stackId after the app id,
		// so Hosting's secret()/config() values live under blocks/<id>/.
		mkdirSync(join(root, '.blocks'), { recursive: true });
		writeFileSync(join(root, '.blocks', 'config.json'), JSON.stringify({ stackId: 'appa' }));
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 't', dependencies: { next: '15.0.0', react: '^18' } }),
		);
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
		const dir = mkdtempSync(join(tmpdir(), 'blocks-app-identity-hosting-out-'));
		dirs.push(dir);
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await BlocksStack.create(app, 'appa', {
			env: { account: '111111111111', region: 'eu-west-1' },
			backendHandlerPath: fixture('handler.js'),
			backendCDKPath: fixture('app-identity-backend.js'),
			defaults: appDefaults,
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
						default: {
							type: 'handler' as const,
							bundle: compute('default'),
							handler: 'index.handler',
							placement: 'regional' as const,
						},
						edge1: {
							type: 'edge' as const,
							bundle: compute('edge1'),
							handler: 'index.handler',
							placement: 'global' as const,
						},
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
		// Strict: synth throws on any app-isolation violation.
		app.synth();
		return dir;
	}

	test("strict synth and the report pass: secret()/config(), cross-region references and the support stacks are the app's own", async () => {
		const dir = await synthHosting();
		const report = readJson<{ app?: { id: string; strict: boolean }; violations?: AppViolation[] }>(
			dir,
			'appa.blocks-iam.json',
		);
		assert.strictEqual(report.app?.id, 'appa');
		assert.strictEqual(report.app?.strict, true);
		assert.deepStrictEqual(
			(report.violations ?? []).map((v) => `[${v.rule}] ${v.message}`),
			[],
		);
		assert.ok(Array.isArray(report.violations), 'the report lists its violations');
		const names = readdirSync(dir).filter((f) => f.endsWith('.template.json'));
		assert.ok(
			names.some((f) => f.startsWith('appa-CfMonitoring-')),
			names.join(', '),
		);
		assert.ok(names.includes('appa-edge.template.json'), names.join(', '));
		const template = readFileSync(join(dir, 'appa.template.json'), 'utf8');
		assert.match(template, /secret:blocks\/appa\/secrets\/DEMO_SECRET/);
		assert.match(template, /parameter\/blocks\/appa\/config\/FEATURE_FLAGS/);
	});

	test('the us-east-1 support stack and the edge stack are tagged app=<id>: stack tags, and its key, topic and alarm', async () => {
		const dir = await synthHosting();
		const manifest = readJson<Manifest>(dir, 'manifest.json');
		const stacks = Object.entries(manifest.artifacts).filter(([, a]) => a.type === 'aws:cloudformation:stack');
		const support = stacks.find(([id]) => id.startsWith('appa-CfMonitoring-'));
		assert.ok(support, 'support stack');
		assert.ok(
			stacks.some(([id]) => id === 'appa-edge'),
			stacks.map(([id]) => id).join(', '),
		);
		for (const [id, a] of stacks) {
			// A stack tag reaches what a tag aspect can't (CloudFormation propagates it), e.g. CDK's provider function.
			assert.strictEqual(a.properties?.tags?.app, 'appa', `${id} stack tag`);
		}
		const { Resources } = readJson<{ Resources: Resources }>(dir, support[1].properties?.templateFile ?? '');
		const tagged = (type: string) =>
			Object.values(Resources)
				.filter((r) => r.Type === type)
				.map((r) => r.Properties?.Tags?.find((t) => t.Key === 'app')?.Value);
		for (const type of ['AWS::KMS::Key', 'AWS::SNS::Topic', 'AWS::CloudWatch::Alarm', 'AWS::IAM::Role']) {
			const values = tagged(type);
			assert.ok(values.length > 0, `${type} in the support stack`);
			assert.deepStrictEqual(
				values,
				values.map(() => 'appa'),
				type,
			);
		}
		assert.ok(tagged('AWS::Lambda::Function').length > 0, 'the provider function (tagged through the stack tag)');
	});

	test("Hosting's CloudFront Functions and KeyValueStores are named <id>-<region>-… with the concrete region", async () => {
		const dir = await synthHosting();
		const { Resources } = readJson<{ Resources: Resources }>(dir, 'appa.template.json');
		const named = Object.values(Resources).filter((r) =>
			/^AWS::CloudFront::(Function|KeyValueStore)$/.test(r.Type),
		);
		assert.ok(named.length >= 2, `${named.length} CloudFront functions / stores`);
		for (const r of named) {
			const name = String(r.Properties?.Name);
			assert.match(name, /^appa-eu-west-1-[A-Za-z0-9_-]+$/, name);
			assert.ok(name.length <= 64, name);
		}
	});
});
