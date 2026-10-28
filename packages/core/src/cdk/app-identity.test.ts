// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { stubComputeFactory } from './__fixtures__/stub-lambda-compute.js';
import type { AppViolation } from './app-isolation-rules.js';
import { BlocksBackend } from './blocks-backend.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { BlocksStack } from './index.js';


/** On a shared platform each app's bootstrap qualifier is its app id. */
const QUALIFIER = { '@aws-cdk/core:bootstrapQualifier': 'appa' };

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const cleanBackend = join(__dirname, '__fixtures__', 'app-identity-backend.js');
const violatingBackend = join(__dirname, '__fixtures__', 'app-identity-violations-backend.js');

const dirs: string[] = [];
const outdir = () => {
	const d = mkdtempSync(join(tmpdir(), 'blocks-app-identity-'));
	dirs.push(d);
	return d;
};
after(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const appDefaults = (extra: Partial<BlocksDefaults> = {}): BlocksDefaults => ({
	...BlocksPresets.production,
	app: { id: 'appa' },
	permissionsBoundary: 'apps-boundary',
	...extra,
});

const makeStack = (scope: Construct, id: string, defaults: BlocksDefaults, backend = cleanBackend) =>
	BlocksStack.create(scope, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: backend,
		defaults,
		defaultComputeFactory: stubComputeFactory,
	});

type Report = {
	app?: { id: string; tagKey: string; namePrefix: string; strict: boolean; stackName: string };
	violations?: AppViolation[];
	roles: { path: string; tags: unknown[] }[];
};
const readReport = (dir: string, stack: cdk.Stack): Report =>
	JSON.parse(readFileSync(join(dir, `${stack.artifactId}.blocks-iam.json`), 'utf8'));

type Tagged = { Properties?: { Tags?: { Key: string; Value: unknown }[] } };
const appTag = (r: Tagged) => r.Properties?.Tags?.find((t) => t.Key === 'app')?.Value;

describe('defaults.app — tags', () => {
	test('unset: no resource gets an app tag, and the report has no app section', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await makeStack(app, 'appa', BlocksPresets.production);
		app.synth();
		const tagged = Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, Tagged>).filter(
			(r) => appTag(r) !== undefined,
		);
		assert.deepStrictEqual(tagged, []);
		const report = readReport(dir, stack);
		assert.strictEqual(report.app, undefined);
		assert.strictEqual(report.violations, undefined);
	});

	test('set: every role and every taggable Blocks resource carries app=<id>, and so does the stack', async () => {
		const app = new cdk.App({ context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults());
		const template = Template.fromStack(stack);
		const roles = Object.entries(template.findResources('AWS::IAM::Role') as Record<string, Tagged>);
		assert.ok(roles.length >= 3, `expected the shared, helper and auto-delete provider roles: ${roles.map(([id]) => id)}`);
		const untagged = roles.filter(([, r]) => appTag(r) !== 'appa').map(([id]) => id);
		assert.deepStrictEqual(untagged, [], 'roles without app=appa');
		for (const type of ['AWS::DynamoDB::Table', 'AWS::S3::Bucket']) {
			template.hasResourceProperties(type, { Tags: Match.arrayWith([{ Key: 'app', Value: 'appa' }]) });
		}
		assert.strictEqual(stack.tags.tagValues().app, 'appa');
	});

	test("the app's own Tags.of(...) can't replace the app tag", async () => {
		const app = new cdk.App({ context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults(), violatingBackend);
		const roles = Object.entries(Template.fromStack(stack).findResources('AWS::IAM::Role') as Record<string, Tagged>);
		const other = roles.filter(([, r]) => appTag(r) !== 'appa').map(([id, r]) => `${id}=${appTag(r)}`);
		assert.deepStrictEqual(other, []);
	});

	test("a raw CfnResource role keeps its other tags (pins CDK's CfnResource._cfnProperties shape)", async () => {
		const app = new cdk.App({ context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults());
		const raw = new cdk.CfnResource(stack, 'RawRole', {
			type: 'AWS::IAM::Role',
			properties: {
				AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }] },
				Tags: [{ Key: 'team', Value: 'x' }],
			},
		});
		// tagRole reads this private field to merge tags on roles no tag aspect reaches.
		assert.ok('_cfnProperties' in raw, 'aws-cdk-lib no longer stores CfnResource properties in _cfnProperties');
		const tags = (Template.fromStack(stack).toJSON().Resources.RawRole as Tagged).Properties?.Tags;
		assert.deepStrictEqual(tags, [
			{ Key: 'team', Value: 'x' },
			{ Key: 'app', Value: 'appa' },
		]);
	});

	test('BlocksBackend: the stack-level CDK singleton roles its blocks add are tagged too', async () => {
		const app = new cdk.App({ context: QUALIFIER });
		const stack = new cdk.Stack(app, 'appa');
		await BlocksBackend.create(stack, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: cleanBackend,
			defaults: appDefaults(),
			defaultComputeFactory: stubComputeFactory,
		});
		const roles = Template.fromStack(stack).findResources('AWS::IAM::Role') as Record<string, Tagged>;
		const provider = Object.entries(roles).find(([id]) => id.startsWith('CustomS3AutoDeleteObjects'));
		assert.ok(provider, `auto-delete provider role missing: ${Object.keys(roles)}`);
		assert.strictEqual(appTag(provider[1]), 'appa');
	});
});

describe('defaults.app — validation and violations', () => {
	for (const bad of ['', 'App', 'app-a', '1app', 'a'.repeat(11)]) {
		test(`rejects the app id ${JSON.stringify(bad)}`, async () => {
			const app = new cdk.App({ context: QUALIFIER });
			await assert.rejects(makeStack(app, 'appa', appDefaults({ app: { id: bad } })), /Invalid defaults\.app\.id/);
		});
	}

	test('a well-behaved app has no violations, and the report names the app', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults());
		app.synth();
		const report = readReport(dir, stack);
		assert.deepStrictEqual(report.violations, []);
		assert.deepStrictEqual(
			{ id: report.app?.id, tagKey: report.app?.tagKey, namePrefix: report.app?.namePrefix, strict: report.app?.strict },
			{ id: 'appa', tagKey: 'app', namePrefix: 'appa-', strict: false },
		);
	});

	test('an overreaching app: each way out of the app is reported', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults(), violatingBackend);
		app.synth();
		const rules = (readReport(dir, stack).violations ?? []).map((v) => v.rule).sort();
		assert.deepStrictEqual([...new Set(rules)], ['broad-managed-policy', 'grant-outside-app', 'wildcard-data-grant']);
		const messages = (readReport(dir, stack).violations ?? []).map((v) => v.message).join('\n');
		assert.match(messages, /parameter\/appb-db-password/);
	});

	test("the default bootstrap qualifier: the CDK asset bucket isn't the app's", async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir });
		const stack = await makeStack(app, 'appa', appDefaults());
		app.synth();
		const messages = (readReport(dir, stack).violations ?? []).map((v) => v.message).join('\n');
		assert.match(messages, /--qualifier appa/);
	});

	test('no boundary: a violation, and a synth warning', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await makeStack(app, 'appa', appDefaults({ permissionsBoundary: undefined }));
		Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('defaults.permissionsBoundary isn'));
		app.synth();
		const rules = (readReport(dir, stack).violations ?? []).map((v) => v.rule);
		assert.deepStrictEqual(rules, ['no-permissions-boundary']);
	});

	test("a stack name outside the app's prefix is a violation", async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir, context: QUALIFIER });
		const stack = await makeStack(app, 'orders', appDefaults());
		app.synth();
		const rules = new Set((readReport(dir, stack).violations ?? []).map((v) => v.rule));
		assert.ok(rules.has('stack-name-outside-app'), [...rules].join(', '));
		assert.ok(rules.has('scope-outside-app'), [...rules].join(', '));
	});

	test('strict: synth fails and lists every violation', async () => {
		const app = new cdk.App({ outdir: outdir(), context: QUALIFIER });
		await makeStack(app, 'appa', appDefaults({ app: { id: 'appa', strict: true } }), violatingBackend);
		assert.throws(() => app.synth(), /defaults\.app\.strict: \d+ app-isolation violation[\s\S]*grant-outside-app/);
	});

	test('strict on a well-behaved app synthesizes', async () => {
		const app = new cdk.App({ outdir: outdir(), context: QUALIFIER });
		await makeStack(app, 'appa', appDefaults({ app: { id: 'appa', strict: true } }));
		assert.doesNotThrow(() => app.synth());
	});
});
