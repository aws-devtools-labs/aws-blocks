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
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { BlocksBackend } from './blocks-backend.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { Compute } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';

// Same inline default-compute stub as blocks-backend.test.ts: core's tests can't
// depend on @aws-blocks/bb-lambda-compute, so a Compute owning a NodejsFunction
// that runs AS the shared execution role stands in for LambdaCompute.
class StubLambdaCompute extends Compute {
	readonly fn: lambda.NodejsFunction;
	readonly logGroup: cdk.aws_logs.LogGroup;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.logGroup = new cdk.aws_logs.LogGroup(this, 'HandlerLogGroup', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
			logGroup: this.logGroup,
			environment: { BLOCKS_STACK_NAME: this.backendStackName },
			bundling: { minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } },
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

	override apiHandler(): IFunction {
		return this.fn;
	}

	protected applyTracing(): void {}
	protected healthWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected loggingWidgets(_region: string): IWidget[][] {
		return [];
	}
	protected tracingWidgets(_region: string): IWidget[][] {
		return [];
	}
}

const stubComputeFactory: DefaultComputeFactory = (root) => new StubLambdaCompute(root as never, 'DefaultCompute');

before(() => {
	process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --conditions=cdk`;
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(__dirname, '__fixtures__', 'handler.js');
const iamBackendPath = join(__dirname, '__fixtures__', 'iam-boundary-backend.js');

const withBoundary = (permissionsBoundary: BlocksDefaults['permissionsBoundary']): BlocksDefaults => ({
	...BlocksPresets.production,
	permissionsBoundary,
});

const makeBackend = (scope: Construct, id: string, defaults: BlocksDefaults) =>
	BlocksBackend.create(scope, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: iamBackendPath,
		defaults,
		defaultComputeFactory: stubComputeFactory,
	});

const makeStack = (scope: Construct, id: string, defaults: BlocksDefaults) =>
	BlocksStack.create(scope, id, {
		backendHandlerPath: handlerPath,
		backendCDKPath: iamBackendPath,
		defaults,
		defaultComputeFactory: stubComputeFactory,
	});

/** The ARN CDK builds for a boundary given by name: resolved in the deploying account + partition. */
const arnForName = (name: string) => ({
	'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, `:policy/${name}`]],
});

type RoleResource = { Properties?: { PermissionsBoundary?: unknown } };
const rolesOf = (template: Template) =>
	Object.entries(template.findResources('AWS::IAM::Role') as Record<string, RoleResource>);

/**
 * Assert EVERY `AWS::IAM::Role` in the template (optionally filtered by logical-id
 * predicate) carries exactly `expected` — iterating all roles rather than
 * spot-checking BlocksRole, so a role added by a future block can't slip through.
 */
function assertEveryRoleBounded(template: Template, expected: unknown, include: (id: string) => boolean = () => true) {
	const roles = rolesOf(template).filter(([id]) => include(id));
	assert.ok(roles.length > 0, 'expected at least one role to check');
	const unbounded = roles
		.filter(([, r]) => JSON.stringify(r.Properties?.PermissionsBoundary) !== JSON.stringify(expected))
		.map(([id, r]) => `${id} → ${JSON.stringify(r.Properties?.PermissionsBoundary ?? 'NONE')}`);
	assert.deepStrictEqual(
		unbounded,
		[],
		`roles without the expected permissions boundary:\n  ${unbounded.join('\n  ')}`,
	);
	return roles.map(([id]) => id);
}

describe('defaults.permissionsBoundary — BlocksBackend', () => {
	test('a boundary given by name caps every role the backend creates, incl. stack-scoped CDK singletons', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'BoundaryByNameStack');
		await makeBackend(stack, 'Blocks', withBoundary('blocks-test-boundary'));

		const template = Template.fromStack(stack);
		const checked = assertEveryRoleBounded(template, arnForName('blocks-test-boundary'));
		// The three role origins the fixture exercises must all be among the checked roles.
		assert.ok(
			checked.some((id) => id.startsWith('BlocksBlocksRole')),
			`shared execution role missing: ${checked}`,
		);
		assert.ok(
			checked.some((id) => id.includes('HelperRole')),
			`block-owned helper role missing: ${checked}`,
		);
		assert.ok(
			checked.some((id) => id.startsWith('CustomS3AutoDeleteObjects')),
			`stack-scoped auto-delete provider role missing (it lives outside the backend subtree): ${checked}`,
		);
	});

	test('with accessLogging on, the stack-scoped API Gateway CloudWatch role is capped too', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'AccessLoggingBoundaryStack');
		await makeBackend(stack, 'Blocks', { ...withBoundary('blocks-test-boundary'), accessLogging: true });

		const checked = assertEveryRoleBounded(Template.fromStack(stack), arnForName('blocks-test-boundary'));
		assert.ok(
			checked.some((id) => id.startsWith('BlocksApiGatewayCloudWatchRole')),
			`API Gateway CloudWatch role missing: ${checked}`,
		);
	});

	test('does not touch roles the surrounding stack already owned before the backend was created', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'CustomerRoleStack');
		new iam.Role(stack, 'CustomerOwnedRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		await makeBackend(stack, 'Blocks', withBoundary('blocks-test-boundary'));

		const template = Template.fromStack(stack);
		const customer = rolesOf(template).find(([id]) => id.startsWith('CustomerOwnedRole'));
		assert.ok(customer, 'customer role should synthesize');
		assert.strictEqual(customer[1].Properties?.PermissionsBoundary, undefined);
		assertEveryRoleBounded(
			template,
			arnForName('blocks-test-boundary'),
			(id) => !id.startsWith('CustomerOwnedRole'),
		);
	});

	test('accepts a full policy ARN', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'BoundaryByArnStack');
		const arn = 'arn:aws:iam::123456789012:policy/platform/app-ceiling';
		await makeBackend(stack, 'Blocks', withBoundary(arn));

		assertEveryRoleBounded(Template.fromStack(stack), arn);
	});

	test('accepts an IManagedPolicy', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'BoundaryByPolicyStack');
		const policy = iam.ManagedPolicy.fromManagedPolicyArn(
			stack,
			'Ceiling',
			'arn:aws:iam::123456789012:policy/app-ceiling',
		);
		await makeBackend(stack, 'Blocks', withBoundary(policy));

		assertEveryRoleBounded(Template.fromStack(stack), 'arn:aws:iam::123456789012:policy/app-ceiling');
	});

	test('unset (both presets): no role gets a PermissionsBoundary', async () => {
		for (const preset of [BlocksPresets.production, BlocksPresets.sandbox]) {
			const app = new cdk.App();
			const stack = new cdk.Stack(app, 'NoBoundaryStack');
			await makeBackend(stack, 'Blocks', preset);

			const template = Template.fromStack(stack);
			const bounded = rolesOf(template).filter(([, r]) => r.Properties?.PermissionsBoundary !== undefined);
			assert.deepStrictEqual(bounded, [], 'no role should carry a boundary when the option is unset');
			assert.ok(!('permissionsBoundary' in preset), 'presets must leave permissionsBoundary unset');
		}
	});

	test('two backends in one stack each get their own boundary, and the mix is flagged', async () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'TwoBoundaryStack');
		await makeBackend(stack, 'BackendA', withBoundary('boundary-a'));
		await makeBackend(stack, 'BackendB', withBoundary('boundary-b'));

		const template = Template.fromStack(stack);
		assertEveryRoleBounded(template, arnForName('boundary-a'), (id) => id.startsWith('BackendA'));
		assertEveryRoleBounded(template, arnForName('boundary-b'), (id) => id.startsWith('BackendB'));
		Annotations.fromStack(stack).hasWarning(
			'/TwoBoundaryStack/BackendB',
			Match.stringLikeRegexp('different permissionsBoundary'),
		);
	});

	test('wins over the CDK @aws-cdk/core:permissionsBoundary context for Blocks roles, and warns', async () => {
		const app = new cdk.App({ context: { '@aws-cdk/core:permissionsBoundary': { name: 'platform-boundary' } } });
		const stack = new cdk.Stack(app, 'ContextAndOptionStack');
		new iam.Role(stack, 'CustomerOwnedRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		await makeBackend(stack, 'Blocks', withBoundary('app-boundary'));

		const template = Template.fromStack(stack);
		// The context still governs the rest of the stack…
		assertEveryRoleBounded(template, arnForName('platform-boundary'), (id) => id.startsWith('CustomerOwnedRole'));
		// …while the explicit Blocks option governs every role Blocks created.
		assertEveryRoleBounded(template, arnForName('app-boundary'), (id) => !id.startsWith('CustomerOwnedRole'));
		Annotations.fromStack(stack).hasWarning('/ContextAndOptionStack/Blocks', Match.stringLikeRegexp('context'));
	});

	test('the CDK context alone still bounds every Blocks role (the option is not required)', async () => {
		const app = new cdk.App({ context: { '@aws-cdk/core:permissionsBoundary': { name: 'platform-boundary' } } });
		const stack = new cdk.Stack(app, 'ContextOnlyStack');
		await makeBackend(stack, 'Blocks', BlocksPresets.production);

		assertEveryRoleBounded(Template.fromStack(stack), arnForName('platform-boundary'));
	});

	for (const [label, input, pattern] of [
		['an empty string', '', /permissionsBoundary.*empty/s],
		['a name with spaces', 'my boundary', /permissionsBoundary.*not a valid IAM policy name/s],
		['a name with a path', 'platform/ceiling', /permissionsBoundary.*full ARN/s],
		['a non-policy ARN', 'arn:aws:s3:::my-bucket', /permissionsBoundary.*IAM managed policy ARN/s],
		['a non-policy object', { managedPolicyArn: 42 }, /permissionsBoundary.*IManagedPolicy/s],
	] as const) {
		test(`rejects ${label} with an actionable error`, async () => {
			const app = new cdk.App();
			const stack = new cdk.Stack(app, 'InvalidBoundaryStack');
			// Simulates a plain-JS / dynamically-built caller passing a wrong shape.
			const bad = input as unknown as BlocksDefaults['permissionsBoundary'];
			await assert.rejects(makeBackend(stack, 'Blocks', withBoundary(bad)), pattern);
		});
	}
});

describe('defaults.permissionsBoundary — legacy BlocksStack', () => {
	test('caps every role in the stack', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'LegacyBoundaryStack', withBoundary('blocks-test-boundary'));

		const checked = assertEveryRoleBounded(Template.fromStack(stack), arnForName('blocks-test-boundary'));
		assert.ok(checked.some((id) => id.startsWith('BlocksRole')));
		assert.ok(checked.some((id) => id.startsWith('CustomS3AutoDeleteObjects')));
	});

	test('unset: no role gets a PermissionsBoundary', async () => {
		const app = new cdk.App();
		const stack = await makeStack(app, 'LegacyNoBoundaryStack', BlocksPresets.sandbox);

		const bounded = rolesOf(Template.fromStack(stack)).filter(
			([, r]) => r.Properties?.PermissionsBoundary !== undefined,
		);
		assert.deepStrictEqual(bounded, []);
	});
});

describe('synth-time IAM report', () => {
	const dirs: string[] = [];
	const outdir = () => {
		const d = mkdtempSync(join(tmpdir(), 'blocks-iam-report-'));
		dirs.push(d);
		return d;
	};
	after(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	type ReportStatement = { effect: string; actions?: string[]; resources?: unknown[]; blocks: string[] };
	type Report = {
		schemaVersion: number;
		root: string;
		executionRole: {
			logicalId: string;
			permissionsBoundary: unknown;
			managedPolicyArns: unknown[];
			statements: ReportStatement[];
		};
		otherRoles: { logicalId: string; path: string }[];
	};
	const readReport = (dir: string, file: string): Report => JSON.parse(readFileSync(join(dir, file), 'utf8'));

	test('BlocksStack: writes <stack>.blocks-iam.json listing the composed grants, attributed to the block', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir });
		const stack = await makeStack(app, 'ReportStack', withBoundary('blocks-test-boundary'));
		app.synth();

		const report = readReport(dir, `${stack.artifactId}.blocks-iam.json`);
		assert.strictEqual(report.schemaVersion, 1);
		assert.ok(report.executionRole.logicalId.startsWith('BlocksRole'));
		assert.deepStrictEqual(report.executionRole.permissionsBoundary, arnForName('blocks-test-boundary'));
		assert.ok(
			JSON.stringify(report.executionRole.managedPolicyArns).includes('AWSLambdaBasicExecutionRole'),
			'managed policies are listed',
		);
		const dynamo = report.executionRole.statements.find((s) => s.actions?.includes('dynamodb:PutItem'));
		assert.ok(dynamo, `expected the KV-style dynamodb grant in:\n${JSON.stringify(report, null, 2)}`);
		assert.strictEqual(dynamo.effect, 'Allow');
		assert.ok(
			dynamo.blocks.some((b) => b.endsWith('-kv')),
			`dynamodb grant should be attributed to the kv block: ${dynamo.blocks}`,
		);
		assert.ok(
			report.otherRoles.some((r) => r.path.includes('HelperRole')),
			'block-owned helper roles are inventoried',
		);
	});

	test('is deterministic across synths (diffable in CI)', async () => {
		const read = async () => {
			const dir = outdir();
			const app = new cdk.App({ outdir: dir });
			const stack = await makeStack(app, 'DeterministicReportStack', BlocksPresets.production);
			app.synth();
			return readFileSync(join(dir, `${stack.artifactId}.blocks-iam.json`), 'utf8');
		};
		assert.strictEqual(await read(), await read());
	});

	test('BlocksBackend: writes <stack>.<backendId>.blocks-iam.json per backend', async () => {
		const dir = outdir();
		const app = new cdk.App({ outdir: dir });
		const stack = new cdk.Stack(app, 'BackendReportStack');
		await makeBackend(stack, 'BackendA', BlocksPresets.production);
		await makeBackend(stack, 'BackendB', BlocksPresets.production);
		app.synth();

		for (const id of ['BackendA', 'BackendB']) {
			const report = readReport(dir, `${stack.artifactId}.${id}.blocks-iam.json`);
			assert.strictEqual(report.root, `BackendReportStack/${id}`);
			assert.strictEqual(report.executionRole.permissionsBoundary, null);
			assert.ok(report.executionRole.logicalId.startsWith(`${id}BlocksRole`));
			assert.ok(report.executionRole.statements.some((s) => s.actions?.includes('dynamodb:PutItem')));
		}
	});
});
