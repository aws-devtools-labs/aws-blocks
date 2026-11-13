// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { ensureApiGatewayAccount } from './apigateway-account.js';
import { BlocksPresets } from './blocks-defaults.js';
import { coverBlocksRoot } from './blocks-roles.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksBackend } from './blocks-backend.js';
import { BlocksStack } from './index.js';
import {
	addServicePrincipalTrustCheck,
	KMS_KEY_POLICY_WARNING_ID,
	SERVICE_PRINCIPAL_TRUST_WARNING_ID,
	sourceScopedConditions,
	unconditionedServicePrincipals,
	unscopedKeyPolicyServicePrincipals,
} from './service-principal-trust.js';

// Same inline default-compute stub as blocks-stack.test.ts: core's tests can't
// depend on @aws-blocks/bb-lambda-compute.
class StubLambdaCompute extends ComputeBase {
	readonly fn: lambda.NodejsFunction;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new lambda.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
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
const trustBackendPath = join(__dirname, '__fixtures__', 'trust-check-backend.js');

/** The sentence both checks' messages end with: the operators and values that don't count. */
const CONDITION_RULES =
	'A key does not count under an IfExists, negated (StringNotEquals, ArnNotLike, ...), Null or ForAllValues: ' +
	'operator, or with a value that leaves the account open (* alone, a wildcard or empty account); nor do ' +
	'aws:SourceOrgID and aws:SourceOrgPaths, which admit every account in the organization.';

/** The full error a role AWS Blocks owns fails synth with. */
function trustError(rolePath: string, service: string): string {
	return (
		`[${rolePath}] IAM role ${rolePath} trusts the service principal ${service} without an ` +
		'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
		'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement. ' +
		CONDITION_RULES
	);
}

/** The `[path] message` lines of a CDK validation error, in order. */
function validationErrors(err: unknown): string[] {
	assert.ok(err instanceof Error);
	return err.message
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('['));
}

/** Synth `app`, expecting it to fail with exactly `expected` validation errors. */
function assertSynthErrors(app: cdk.App, expected: string[]): void {
	assert.throws(
		() => app.synth(),
		(err: unknown) => {
			assert.deepStrictEqual(validationErrors(err), expected);
			return true;
		},
	);
}

/** The trust-check warnings in `stack`'s synthesized messages: `[construct path, message]`. */
function trustWarnings(assembly: cdk.cx_api.CloudAssembly, stack: cdk.Stack): [string, string][] {
	return assembly
		.getStackArtifact(stack.artifactId)
		.messages.filter(
			(m) =>
				m.level === 'warning' &&
				typeof m.entry.data === 'string' &&
				m.entry.data.endsWith(`[ack: ${SERVICE_PRINCIPAL_TRUST_WARNING_ID}]`),
		)
		.map((m) => [m.id, m.entry.data as string]);
}

/** The full warning an app-owned role gets, for the statement at `index`. */
function trustWarning(rolePath: string, service: string, index: number): string {
	return (
		`IAM role ${rolePath} trusts the service principal ${service} without an ` +
		'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
		'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement. ' +
		`${CONDITION_RULES} ` +
		"For a role a CDK construct creates with no prop for its trust, set the condition on the role's L1 resource: " +
		`role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.${index}.Condition', ` +
		"{ StringEquals: { 'aws:SourceAccount': ... }, ArnLike: { 'aws:SourceArn': ... } }). " +
		'To keep the trust as it is, acknowledge this warning: ' +
		`Annotations.of(role).acknowledgeWarning('${SERVICE_PRINCIPAL_TRUST_WARNING_ID}'), or on the stack ` +
		`to acknowledge it for every role in the stack. [ack: ${SERVICE_PRINCIPAL_TRUST_WARNING_ID}]`
	);
}

interface FixtureRoles {
	/** Add a role inside a block with an official `bbName`. */
	readonly blockRole?: boolean;
	/** Add a role a block hoists to stack scope and marks as its own. */
	readonly helperRole?: boolean;
	/** Add an unscoped service key inside a block with an official `bbName`. */
	readonly blockKey?: boolean;
	/** Add an unscoped service key on the root, where the app owns it. */
	readonly appKey?: boolean;
	/** Add an unscoped service key at stack scope of an embedded backend, where the app owns it. */
	readonly appStackKey?: boolean;
}

/** Run `build` with the fixture's opt-in roles switched on. */
async function withFixtureRoles<T>(
	{ blockRole, helperRole, blockKey, appKey, appStackKey }: FixtureRoles,
	build: () => Promise<T>,
): Promise<T> {
	if (blockRole) process.env.TRUST_CHECK_BLOCK_ROLE = '1';
	if (helperRole) process.env.TRUST_CHECK_HELPER_ROLE = '1';
	if (blockKey) process.env.TRUST_CHECK_BLOCK_KEY = '1';
	if (appKey) process.env.TRUST_CHECK_APP_KEY = '1';
	if (appStackKey) process.env.TRUST_CHECK_APP_STACK_KEY = '1';
	try {
		return await build();
	} finally {
		delete process.env.TRUST_CHECK_BLOCK_ROLE;
		delete process.env.TRUST_CHECK_HELPER_ROLE;
		delete process.env.TRUST_CHECK_BLOCK_KEY;
		delete process.env.TRUST_CHECK_APP_KEY;
		delete process.env.TRUST_CHECK_APP_STACK_KEY;
	}
}

/** A BlocksStack whose backend module is the trust-check fixture. */
async function trustCheckBlocksStack(id: string, roles: FixtureRoles) {
	const app = new cdk.App();
	const stack = await withFixtureRoles(roles, () =>
		BlocksStack.create(app, id, {
			backendHandlerPath: handlerPath,
			backendCDKPath: trustBackendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		}),
	);
	return { app, stack };
}

/** A plain `cdk.Stack` with an embedded `BlocksBackend` whose backend module is the trust-check fixture. */
async function trustCheckEmbeddedBackend(id: string, roles: FixtureRoles) {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, id, { env: { account: '123456789012', region: 'us-east-1' } });
	await withFixtureRoles(roles, () =>
		BlocksBackend.create(stack, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: trustBackendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		}),
	);
	return { app, stack };
}

const byId = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);

/** The warnings expected for the fixture's app-owned roles, given role paths under `prefix`. */
function expectedAppRoleWarnings(prefix: string, roles: [string, string][]): [string, string][] {
	const path = (p: string) => `${prefix}/${p}/Resource`;
	return roles.map(([role, service]) => [`/${path(role)}`, trustWarning(path(role), service, 0)]);
}

/** The fixture's app-owned roles on its root (stack-level ones aside). */
const FIXTURE_ROOT_APP_ROLES: [string, string][] = [
	['ModuleRole', 'glue.amazonaws.com'],
	['UserSM/EventsRole', 'events.amazonaws.com'],
	['app/NamespaceRole', 'glue.amazonaws.com'],
	['mine/SM/EventsRole', 'events.amazonaws.com'],
];

/** A plain stack covered as a Blocks root, with the trust check registered. */
function checkedStack(): { app: cdk.App; stack: cdk.Stack } {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'TrustCheckStack', { env: { account: '123456789012', region: 'us-east-1' } });
	coverBlocksRoot(stack);
	addServicePrincipalTrustCheck(stack);
	return { app, stack };
}

const roleResource = (role: iam.Role) => role.node.defaultChild as cdk.CfnResource;

describe('service-principal trust check', () => {
	test('passes for a service role whose trust carries aws:SourceAccount and aws:SourceArn', () => {
		const { app, stack } = checkedStack();
		new iam.Role(stack, 'Conditioned', {
			assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
				conditions: {
					StringEquals: { 'aws:SourceAccount': stack.account },
					ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:scheduler:${stack.region}:${stack.account}:*` },
				},
			}),
		});
		assert.doesNotThrow(() => app.synth());
	});

	test('passes for a Lambda execution role without conditions', () => {
		const { app, stack } = checkedStack();
		new iam.Role(stack, 'LambdaRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		new iam.Role(stack, 'EdgeRole', {
			assumedBy: new iam.CompositePrincipal(
				new iam.ServicePrincipal('lambda.amazonaws.com'),
				new iam.ServicePrincipal('edgelambda.amazonaws.com'),
			),
		});
		assert.doesNotThrow(() => app.synth());
	});

	test('passes for the API Gateway CloudWatch Logs role ensureApiGatewayAccount creates', () => {
		const { app, stack } = checkedStack();
		ensureApiGatewayAccount(stack);
		assert.doesNotThrow(() => app.synth());
	});

	test('exempts only apigateway.amazonaws.com, and only on a role an AWS::ApiGateway::Account names', () => {
		const { app, stack } = checkedStack();
		// Another principal on a CloudWatch Logs role is still reported.
		const cloudWatchRole = new iam.Role(stack, 'BlocksApiGatewayCloudWatchRole', {
			assumedBy: new iam.CompositePrincipal(
				new iam.ServicePrincipal('apigateway.amazonaws.com'),
				new iam.ServicePrincipal('glue.amazonaws.com'),
			),
		});
		new apigateway.CfnAccount(stack, 'Account', { cloudWatchRoleArn: cloudWatchRole.roleArn });
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(cloudWatchRole)), ['glue.amazonaws.com']);
		// API Gateway on a role no account names is reported, whatever its id.
		const other = new iam.Role(stack, 'OtherApiGatewayRole', {
			assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
		});
		const nested = new iam.Role(new Construct(stack, 'Nested'), 'BlocksApiGatewayCloudWatchRole', {
			assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
		});
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(other)), ['apigateway.amazonaws.com']);
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(nested)), ['apigateway.amazonaws.com']);
		assertSynthErrors(app, [
			trustError('TrustCheckStack/BlocksApiGatewayCloudWatchRole/Resource', 'glue.amazonaws.com'),
			trustError('TrustCheckStack/OtherApiGatewayRole/Resource', 'apigateway.amazonaws.com'),
			trustError('TrustCheckStack/Nested/BlocksApiGatewayCloudWatchRole/Resource', 'apigateway.amazonaws.com'),
		]);
	});

	test('reports API Gateway on a role an AWS::ApiGateway::Account in another stack names', () => {
		const { app, stack } = checkedStack();
		const role = new iam.Role(stack, 'LogsRole', {
			assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
		});
		const otherStack = new cdk.Stack(app, 'OtherStack', { env: { account: '123456789012', region: 'us-east-1' } });
		new apigateway.CfnAccount(otherStack, 'Account', { cloudWatchRoleArn: role.roleArn });
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), ['apigateway.amazonaws.com']);
	});

	test('fails synth for an unconditioned non-Lambda service role, naming the role path and principal', () => {
		const { app, stack } = checkedStack();
		new iam.Role(stack, 'Unconditioned', { assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com') });
		assertSynthErrors(app, [trustError('TrustCheckStack/Unconditioned/Resource', 'bedrock.amazonaws.com')]);
	});

	test('reports a trust whose only condition is an unrelated key (sts:ExternalId)', () => {
		const { app, stack } = checkedStack();
		const role = new iam.Role(stack, 'ExternalIdOnly', {
			assumedBy: new iam.ServicePrincipal('cognito-idp.amazonaws.com', {
				conditions: { StringEquals: { 'sts:ExternalId': 'x' } },
			}),
		});
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), ['cognito-idp.amazonaws.com']);
		assertSynthErrors(app, [trustError('TrustCheckStack/ExternalIdOnly/Resource', 'cognito-idp.amazonaws.com')]);
	});

	test('matches the source condition keys case-insensitively', () => {
		const { app, stack } = checkedStack();
		const role = new iam.Role(stack, 'LowerCaseKey', {
			assumedBy: new iam.ServicePrincipal('glue.amazonaws.com', {
				conditions: {
					ArnLike: { 'aws:sourcearn': `arn:${stack.partition}:glue:${stack.region}:${stack.account}:*` },
				},
			}),
		});
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), []);
		assert.doesNotThrow(() => app.synth());
	});

	test('counts the source keys under the same operator and value rules as the key-policy check', () => {
		const { app, stack } = checkedStack();
		const rules = `arn:${stack.partition}:events:${stack.region}`;
		const cases: [string, Record<string, unknown>][] = [
			['IfExists', { StringEqualsIfExists: { 'aws:SourceAccount': stack.account } }],
			['NullCheck', { Null: { 'aws:SourceArn': 'false' } }],
			['Negated', { StringNotEquals: { 'aws:SourceAccount': '999999999999' } }],
			['WildcardOnly', { ArnLike: { 'aws:SourceArn': '*' } }],
			['WildcardAccount', { ArnLike: { 'aws:SourceArn': `${rules}:*:rule/*` } }],
			['LiteralLedShortJoin', { StringLike: { 'aws:SourceArn': `arn:${stack.partition}:events:*` } }],
		];
		for (const [id, conditions] of cases) {
			const role = new iam.Role(stack, id, {
				assumedBy: new iam.ServicePrincipal('events.amazonaws.com', { conditions }),
			});
			assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), ['events.amazonaws.com'], id);
		}
		// A wildcard-account ARN still passes beside a concrete aws:SourceAccount
		// (sourceScopedConditions with accountInArn: false renders that shape).
		const paired = new iam.Role(stack, 'Paired', {
			assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com', {
				conditions: sourceScopedConditions(stack, 'apigateway', '/*', { accountInArn: false }),
			}),
		});
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(paired)), []);
		// Each error names the operator and value rules, so a key that is present
		// but doesn't count isn't reported as if it were missing.
		assertSynthErrors(
			app,
			cases.map(([id]) => trustError(`TrustCheckStack/${id}/Resource`, 'events.amazonaws.com')),
		);
	});

	test('accepts an ARN-valued source key built as an Fn::Join that starts with an intrinsic', () => {
		const { app, stack } = checkedStack();
		const target = new kms.Key(stack, 'Target');
		const cases: [string, string][] = [
			['KeyArnSuffix', `${target.keyArn}/*`],
			['ImportedArnSuffix', `${cdk.Fn.importValue('SomeArn')}:*`],
		];
		for (const [id, arn] of cases) {
			const role = new iam.Role(stack, id, {
				assumedBy: new iam.ServicePrincipal('events.amazonaws.com', {
					conditions: { ArnLike: { 'aws:SourceArn': arn } },
				}),
			});
			const trust = JSON.stringify(stack.resolve((roleResource(role) as iam.CfnRole).assumeRolePolicyDocument));
			assert.match(
				trust,
				/"aws:SourceArn":\{"Fn::Join":\["",\[\{"Fn::/,
				`${id} renders as an Fn::Join led by an intrinsic`,
			);
			assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), [], id);
		}
		assert.doesNotThrow(() => app.synth());
	});

	test('reports only the unconditioned principal of a role with several trust statements', () => {
		const { stack } = checkedStack();
		const role = new iam.Role(stack, 'Mixed', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		role.assumeRolePolicy?.addStatements(
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('ecs-tasks.amazonaws.com')],
				actions: ['sts:AssumeRole'],
				conditions: { StringEquals: { 'aws:SourceAccount': stack.account } },
			}),
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('states.amazonaws.com')],
				actions: ['sts:AssumeRole'],
			}),
		);
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), ['states.amazonaws.com']);
	});

	test('reads the trust policy after property overrides', () => {
		const { stack } = checkedStack();
		const role = new iam.Role(stack, 'Overridden', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		roleResource(role).addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Principal.Service', [
			'lambda.amazonaws.com',
			'glue.amazonaws.com',
		]);
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), ['glue.amazonaws.com']);
	});

	test('ignores Deny statements', () => {
		const { stack } = checkedStack();
		const role = new iam.Role(stack, 'WithDeny', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
		role.assumeRolePolicy?.addStatements(
			new iam.PolicyStatement({
				effect: iam.Effect.DENY,
				principals: [new iam.ServicePrincipal('glue.amazonaws.com')],
				actions: ['sts:AssumeRole'],
			}),
		);
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(role)), []);
	});

	test('BlocksStack fails synth for an unconditioned role a block creates', async () => {
		const { app } = await trustCheckBlocksStack('TrustCheckBlockRole', { blockRole: true });
		assertSynthErrors(app, [trustError('TrustCheckBlockRole/block/ServiceRole/Resource', 'glue.amazonaws.com')]);
	});

	test('BlocksStack warns, without failing synth, for unconditioned roles the app owns', async () => {
		const { app, stack } = await trustCheckBlocksStack('TrustCheckAppRoles', { blockRole: false });
		new iam.Role(stack, 'LateUnconditioned', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
		const assembly = app.synth();
		// The EventsRole CDK creates for `targets.SfnStateMachine` only warns: the
		// app owns it, on the root and inside the app's custom block (a `Scope`
		// subclass without an official `bbName`). (CDK already scopes the state
		// machine's own role.)
		const expected = expectedAppRoleWarnings('TrustCheckAppRoles', [
			['LateUnconditioned', 'glue.amazonaws.com'],
			...FIXTURE_ROOT_APP_ROLES,
		]);
		assert.deepStrictEqual(trustWarnings(assembly, stack).sort(byId), expected.sort(byId));
	});

	test('BlocksStack fails synth for an unconditioned role a block hoists to stack scope and marks', async () => {
		const { app } = await trustCheckBlocksStack('TrustCheckHelperRole', { helperRole: true });
		assertSynthErrors(app, [
			trustError('TrustCheckHelperRole/BlocksFakeHelperRole/Resource', 'glue.amazonaws.com'),
		]);
	});

	test('embedded BlocksBackend fails synth for an unconditioned role a block creates', async () => {
		const { app } = await trustCheckEmbeddedBackend('TrustCheckEmbeddedBlockRole', { blockRole: true });
		assertSynthErrors(app, [
			trustError('TrustCheckEmbeddedBlockRole/Blocks/block/ServiceRole/Resource', 'glue.amazonaws.com'),
		]);
	});

	test('embedded BlocksBackend fails synth for an unconditioned role a block hoists to stack scope and marks', async () => {
		const { app } = await trustCheckEmbeddedBackend('TrustCheckEmbeddedHelperRole', { helperRole: true });
		assertSynthErrors(app, [
			trustError('TrustCheckEmbeddedHelperRole/BlocksFakeHelperRole/Resource', 'glue.amazonaws.com'),
		]);
	});

	test('embedded BlocksBackend warns, without failing synth, for unconditioned roles its backend module adds', async () => {
		const { app, stack } = await trustCheckEmbeddedBackend('TrustCheckEmbeddedAppRoles', {});
		// A role the app adds to the stack itself, outside the backend, isn't
		// covered at all (as before): no warning, no error.
		new iam.Role(stack, 'OutsideBackend', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
		const expected = [
			...expectedAppRoleWarnings('TrustCheckEmbeddedAppRoles/Blocks', FIXTURE_ROOT_APP_ROLES),
			...expectedAppRoleWarnings('TrustCheckEmbeddedAppRoles', [['ModuleStackRole', 'glue.amazonaws.com']]),
		];
		assert.deepStrictEqual(trustWarnings(app.synth(), stack).sort(byId), expected.sort(byId));
	});

	test("BlocksStack doesn't warn for the CloudWatch Logs role of an app-owned RestApi", async () => {
		const { app, stack } = await trustCheckBlocksStack('TrustCheckUserRestApi', { blockRole: false });
		// CDK's default `cloudWatchRole`: the RestApi creates the role and an
		// AWS::ApiGateway::Account that names it.
		const api = new apigateway.RestApi(stack, 'UserApi');
		api.root.addMethod('GET', new apigateway.MockIntegration());
		const assembly = app.synth();
		const expected = expectedAppRoleWarnings('TrustCheckUserRestApi', FIXTURE_ROOT_APP_ROLES);
		assert.deepStrictEqual(trustWarnings(assembly, stack).sort(byId), expected.sort(byId));
		const role = api.node.findChild('CloudWatchRole').node.defaultChild as cdk.CfnResource;
		assert.deepStrictEqual(unconditionedServicePrincipals(role), []);
	});

	test('the app-owned role warning can be acknowledged on the stack', async () => {
		const { app, stack } = await trustCheckBlocksStack('TrustCheckAcknowledged', { blockRole: false });
		cdk.Annotations.of(stack).acknowledgeWarning(SERVICE_PRINCIPAL_TRUST_WARNING_ID);
		assert.deepStrictEqual(trustWarnings(app.synth(), stack), []);
	});

	test('the warning names the index of the unconditioned statement', async () => {
		const { app, stack } = await trustCheckBlocksStack('TrustCheckStatementIndex', { blockRole: false });
		const role = new iam.Role(stack, 'SecondStatement', {
			assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		role.assumeRolePolicy?.addStatements(
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('glue.amazonaws.com')],
				actions: ['sts:AssumeRole'],
			}),
		);
		const rolePath = 'TrustCheckStatementIndex/SecondStatement/Resource';
		const warnings = trustWarnings(app.synth(), stack).filter(([id]) => id === `/${rolePath}`);
		assert.deepStrictEqual(warnings, [[`/${rolePath}`, trustWarning(rolePath, 'glue.amazonaws.com', 1)]]);
	});
});

describe('sourceScopedConditions', () => {
	const stack = new cdk.Stack(new cdk.App(), 'ConditionsStack', {
		env: { account: '123456789012', region: 'eu-west-1' },
	});

	test('scopes to the stack account and an ARN pattern of the service', () => {
		assert.deepStrictEqual(stack.resolve(sourceScopedConditions(stack, 'states', 'stateMachine:*')), {
			StringEquals: { 'aws:SourceAccount': '123456789012' },
			ArnLike: {
				'aws:SourceArn': {
					'Fn::Join': [
						'',
						['arn:', { Ref: 'AWS::Partition' }, ':states:eu-west-1:123456789012:stateMachine:*'],
					],
				},
			},
		});
	});

	test('leaves the ARN account segment empty when accountInArn is false', () => {
		assert.deepStrictEqual(
			stack.resolve(sourceScopedConditions(stack, 'apigateway', '*', { accountInArn: false })),
			{
				StringEquals: { 'aws:SourceAccount': '123456789012' },
				ArnLike: {
					'aws:SourceArn': {
						'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':apigateway:eu-west-1::*']],
					},
				},
			},
		);
	});
});

/** The full error a KMS key AWS Blocks owns fails synth with. */
function keyPolicyError(keyPath: string, service: string, statement: number): string {
	return `[${keyPath}] ${keyPolicyProblem(keyPath, service, statement)}`;
}

function keyPolicyProblem(keyPath: string, service: string, statement: number): string {
	return (
		`KMS key ${keyPath} lets the service principal ${service} use it (key policy statement ${statement}) ` +
		'without an aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack ' +
		"account) or aws:SourceArn (ArnLike, an ARN pattern for this account's resources of that service) to the " +
		'statement. kms:EncryptionContext:aws:logs:arn also counts for CloudWatch Logs. ' +
		CONDITION_RULES
	);
}

/** The key-policy check warnings in `stack`'s synthesized messages: `[construct path, message]`. */
function keyPolicyWarnings(assembly: cdk.cx_api.CloudAssembly, stack: cdk.Stack): [string, string][] {
	return assembly
		.getStackArtifact(stack.artifactId)
		.messages.filter(
			(m) =>
				m.level === 'warning' &&
				typeof m.entry.data === 'string' &&
				m.entry.data.endsWith(`[ack: ${KMS_KEY_POLICY_WARNING_ID}]`),
		)
		.map((m) => [m.id, m.entry.data as string]);
}

/** A key on a checked stack whose second policy statement grants `service` under `conditions`. */
function serviceKey(stack: cdk.Stack, id: string, service: string, conditions?: Record<string, unknown>): kms.Key {
	const key = new kms.Key(stack, id);
	key.addToResourcePolicy(
		new iam.PolicyStatement({
			principals: [new iam.ServicePrincipal(service)],
			actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
			resources: ['*'],
			conditions,
		}),
	);
	return key;
}

const keyResource = (key: kms.Key) => key.node.defaultChild as cdk.CfnResource;

describe('KMS key-policy check', () => {
	test('passes for a service statement with StringEquals aws:SourceAccount and ArnLike aws:SourceArn', () => {
		const { app, stack } = checkedStack();
		const key = serviceKey(stack, 'Scoped', 'cloudwatch.amazonaws.com', {
			StringEquals: { 'aws:SourceAccount': stack.account },
			ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:*` },
		});
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), []);
		assert.doesNotThrow(() => app.synth());
	});

	test('accepts aws:SourceAccount or aws:SourceArn alone, keys compared case-insensitively', () => {
		const { stack } = checkedStack();
		const account = serviceKey(stack, 'AccountOnly', 'sns.amazonaws.com', {
			StringEquals: { 'aws:sourceaccount': stack.account },
		});
		const arn = serviceKey(stack, 'ArnOnly', 'cloudwatch.amazonaws.com', {
			ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:${stack.region}:${stack.account}:alarm:*` },
		});
		const anyValue = serviceKey(stack, 'ForAnyValue', 'sns.amazonaws.com', {
			'ForAnyValue:StringEquals': { 'aws:SourceAccount': [stack.account] },
		});
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(account)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(arn)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(anyValue)), []);
	});

	test('fails synth for an unconditioned service statement, naming the key path, principal and statement', () => {
		const { app, stack } = checkedStack();
		serviceKey(stack, 'Unscoped', 'cloudwatch.amazonaws.com');
		assertSynthErrors(app, [keyPolicyError('TrustCheckStack/Unscoped/Resource', 'cloudwatch.amazonaws.com', 1)]);
	});

	test('does not count an IfExists, Null, ForAllValues or negated operator, or a value that leaves the account open', () => {
		const { app, stack } = checkedStack();
		const alarms = (account: string) => `arn:${stack.partition}:cloudwatch:${stack.region}:${account}:alarm:*`;
		const cases: [string, Record<string, unknown>][] = [
			['IfExists', { StringEqualsIfExists: { 'aws:SourceAccount': stack.account } }],
			['NullCheck', { Null: { 'aws:SourceArn': 'false' } }],
			['ForAllValues', { 'ForAllValues:StringEquals': { 'aws:SourceAccount': [stack.account] } }],
			['StringNotEquals', { StringNotEquals: { 'aws:SourceAccount': '999999999999' } }],
			['StringNotLike', { StringNotLike: { 'aws:SourceAccount': '9*' } }],
			['ArnNotEquals', { ArnNotEquals: { 'aws:SourceArn': alarms('999999999999') } }],
			['ArnNotLike', { ArnNotLike: { 'aws:SourceArn': alarms('999999999999') } }],
			['Wildcard', { ArnLike: { 'aws:SourceArn': '*' } }],
			['WildcardAccountArn', { ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:*:*:alarm:*` } }],
			['LiteralLedShortJoin', { StringLike: { 'aws:SourceArn': `arn:${stack.partition}:cloudwatch:*` } }],
			['EmptyAccountArn', { ArnLike: { 'aws:SourceArn': alarms('') } }],
			['WildcardSourceAccount', { StringLike: { 'aws:SourceAccount': '?*' } }],
			['OneOpenValue', { StringLike: { 'aws:SourceAccount': [stack.account, '*'] } }],
			['SourceOrgID', { StringEquals: { 'aws:SourceOrgID': 'o-abc123' } }],
		];
		for (const [id, conditions] of cases) {
			const key = serviceKey(stack, id, 'cloudwatch.amazonaws.com', conditions);
			assert.deepStrictEqual(
				unscopedKeyPolicyServicePrincipals(keyResource(key)),
				['cloudwatch.amazonaws.com'],
				id,
			);
		}
		assertSynthErrors(
			app,
			cases.map(([id]) => keyPolicyError(`TrustCheckStack/${id}/Resource`, 'cloudwatch.amazonaws.com', 1)),
		);
	});

	test('accepts an aws:SourceArn built as an Fn::Join that starts with an intrinsic', () => {
		const { app, stack } = checkedStack();
		const target = new kms.Key(stack, 'Target');
		const key = serviceKey(stack, 'IntrinsicLed', 'cloudwatch.amazonaws.com', {
			ArnLike: { 'aws:SourceArn': { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['TargetResource', 'Arn'] }, '/*']] } },
		});
		const imported = serviceKey(stack, 'ImportLed', 'cloudwatch.amazonaws.com', {
			ArnLike: { 'aws:SourceArn': `${cdk.Fn.importValue('SomeArn')}:*` },
		});
		assert.ok(target);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(imported)), []);
		assert.doesNotThrow(() => app.synth());
	});

	test('accepts kms:EncryptionContext:aws:logs:arn for the CloudWatch Logs principal only', () => {
		const { stack } = checkedStack();
		const logGroups = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`;
		const logs = serviceKey(stack, 'Logs', `logs.${stack.region}.amazonaws.com`, {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': logGroups },
		});
		const china = serviceKey(stack, 'LogsChina', 'logs.cn-north-1.amazonaws.com.cn', {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': logGroups },
		});
		const other = serviceKey(stack, 'NotLogs', 'cloudwatch.amazonaws.com', {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': logGroups },
		});
		const anyAccount = serviceKey(stack, 'LogsAnyAccount', `logs.${stack.region}.amazonaws.com`, {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${stack.partition}:logs:*:*:*` },
		});
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(logs)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(china)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(other)), ['cloudwatch.amazonaws.com']);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(anyAccount)), [
			`logs.${stack.region}.amazonaws.com`,
		]);
	});

	test('matches the CloudWatch Logs principal of an environment-agnostic stack (an Fn::Join)', () => {
		const app = new cdk.App();
		const stack = new cdk.Stack(app, 'EnvAgnosticKeyStack');
		coverBlocksRoot(stack);
		addServicePrincipalTrustCheck(stack);
		const logGroups = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`;
		const logs = serviceKey(stack, 'Logs', `logs.${stack.region}.amazonaws.com`, {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': logGroups },
		});
		const suffix = serviceKey(stack, 'LogsUrlSuffix', `logs.${stack.region}.${stack.urlSuffix}`, {
			ArnLike: { 'kms:EncryptionContext:aws:logs:arn': logGroups },
		});
		const rendered = JSON.stringify(stack.resolve(keyResource(logs)._toCloudFormation()));
		assert.match(rendered, /"Service":\{"Fn::Join"/, 'the logs principal renders as an Fn::Join');
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(logs)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(suffix)), []);
		assert.doesNotThrow(() => app.synth());
	});

	test('does not count kms:ViaService, even with kms:CallerAccount, for a service principal', () => {
		const { stack } = checkedStack();
		const key = serviceKey(stack, 'ViaAndCaller', 'sqs.amazonaws.com', {
			StringEquals: { 'kms:ViaService': `sqs.${stack.region}.amazonaws.com`, 'kms:CallerAccount': stack.account },
		});
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), ['sqs.amazonaws.com']);
	});

	test('exempts events.amazonaws.com only for kms:GenerateDataKey* and kms:Decrypt', () => {
		const { app, stack } = checkedStack();
		const sns = new kms.Key(stack, 'EventBridgeToTopic');
		sns.addToResourcePolicy(
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('events.amazonaws.com')],
				actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
				resources: ['*'],
			}),
		);
		const wider = new kms.Key(stack, 'EventBridgeEncrypt');
		wider.addToResourcePolicy(
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('events.amazonaws.com')],
				actions: ['kms:Decrypt', 'kms:Encrypt'],
				resources: ['*'],
			}),
		);
		const notAction = new kms.Key(stack, 'EventBridgeNotAction');
		notAction.addToResourcePolicy(
			new iam.PolicyStatement({
				principals: [new iam.ServicePrincipal('events.amazonaws.com')],
				notActions: ['kms:ScheduleKeyDeletion'],
				resources: ['*'],
			}),
		);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(sns)), []);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(wider)), ['events.amazonaws.com']);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(notAction)), ['events.amazonaws.com']);
		assertSynthErrors(app, [
			keyPolicyError('TrustCheckStack/EventBridgeEncrypt/Resource', 'events.amazonaws.com', 1),
			keyPolicyError('TrustCheckStack/EventBridgeNotAction/Resource', 'events.amazonaws.com', 1),
		]);
	});

	test('reports only the unscoped principals of a statement whose Service lists several', () => {
		const { stack } = checkedStack();
		const key = new kms.Key(stack, 'Mixed');
		key.addToResourcePolicy(
			new iam.PolicyStatement({
				principals: [
					new iam.ServicePrincipal(`logs.${stack.region}.amazonaws.com`),
					new iam.ServicePrincipal('sns.amazonaws.com'),
				],
				actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
				resources: ['*'],
				conditions: {
					ArnLike: {
						'kms:EncryptionContext:aws:logs:arn': `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:*`,
					},
				},
			}),
		);
		const statement = (
			stack.resolve(keyResource(key)._toCloudFormation()) as {
				Resources: Record<
					string,
					{ Properties: { KeyPolicy: { Statement: { Principal: { Service: unknown } }[] } } }
				>;
			}
		).Resources;
		const services = Object.values(statement)[0].Properties.KeyPolicy.Statement[1].Principal.Service;
		assert.ok(Array.isArray(services) && services.length === 2, 'both principals share one statement');
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), ['sns.amazonaws.com']);
	});

	test('reads an L1 CfnKey whose policy has a single Statement object', () => {
		const { app, stack } = checkedStack();
		const key = new kms.CfnKey(stack, 'L1Key', {
			keyPolicy: {
				Version: '2012-10-17',
				Statement: {
					Effect: 'Allow',
					Principal: { Service: 'cloudwatch.amazonaws.com' },
					Action: ['kms:Decrypt'],
					Resource: '*',
				},
			},
		});
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(key), ['cloudwatch.amazonaws.com']);
		assertSynthErrors(app, [keyPolicyError('TrustCheckStack/L1Key', 'cloudwatch.amazonaws.com', 0)]);
	});

	test('ignores the default account-root statement, Deny statements and non-service principals', () => {
		const { app, stack } = checkedStack();
		const key = new kms.Key(stack, 'NoService');
		key.addToResourcePolicy(
			new iam.PolicyStatement({
				effect: iam.Effect.DENY,
				principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
				actions: ['kms:Decrypt'],
				resources: ['*'],
			}),
		);
		key.addToResourcePolicy(
			new iam.PolicyStatement({
				principals: [new iam.ArnPrincipal(`arn:${stack.partition}:iam::${stack.account}:role/Reader`)],
				actions: ['kms:Decrypt'],
				resources: ['*'],
			}),
		);
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), []);
		assert.doesNotThrow(() => app.synth());
	});

	test('reads the key policy after property overrides', () => {
		const { stack } = checkedStack();
		const key = serviceKey(stack, 'Overridden', 'cloudwatch.amazonaws.com', {
			StringEquals: { 'aws:SourceAccount': stack.account },
		});
		keyResource(key).addPropertyDeletionOverride('KeyPolicy.Statement.1.Condition');
		assert.deepStrictEqual(unscopedKeyPolicyServicePrincipals(keyResource(key)), ['cloudwatch.amazonaws.com']);
	});

	test('BlocksStack fails synth for an unscoped key a block creates', async () => {
		const { app } = await trustCheckBlocksStack('KeyCheckBlockKey', { blockKey: true });
		assertSynthErrors(app, [
			keyPolicyError('KeyCheckBlockKey/keyblock/Key/Resource', 'cloudwatch.amazonaws.com', 1),
		]);
	});

	test('embedded BlocksBackend fails synth for an unscoped key a block creates', async () => {
		const { app } = await trustCheckEmbeddedBackend('KeyCheckEmbeddedBlockKey', { blockKey: true });
		assertSynthErrors(app, [
			keyPolicyError('KeyCheckEmbeddedBlockKey/Blocks/keyblock/Key/Resource', 'cloudwatch.amazonaws.com', 1),
		]);
	});

	test('BlocksStack warns, without failing synth, for an unscoped key the app owns; the warning can be acknowledged', async () => {
		const { app, stack } = await trustCheckBlocksStack('KeyCheckAppKey', { appKey: true });
		const keyPath = 'KeyCheckAppKey/ModuleKey/Resource';
		assert.deepStrictEqual(keyPolicyWarnings(app.synth(), stack), [
			[
				`/${keyPath}`,
				`${keyPolicyProblem(keyPath, 'cloudwatch.amazonaws.com', 1)} To keep the statement as it is, acknowledge ` +
					`this warning: Annotations.of(key).acknowledgeWarning('${KMS_KEY_POLICY_WARNING_ID}'), or on the ` +
					`stack to acknowledge it for every key in the stack. [ack: ${KMS_KEY_POLICY_WARNING_ID}]`,
			],
		]);

		const acked = await trustCheckBlocksStack('KeyCheckAppKeyAcknowledged', { appKey: true });
		cdk.Annotations.of(acked.stack).acknowledgeWarning(KMS_KEY_POLICY_WARNING_ID);
		assert.deepStrictEqual(keyPolicyWarnings(acked.app.synth(), acked.stack), []);
	});

	test('embedded BlocksBackend warns, without failing synth, for an unscoped key its backend module adds at stack scope', async () => {
		const { app, stack } = await trustCheckEmbeddedBackend('KeyCheckEmbeddedStackKey', { appStackKey: true });
		const keyPath = 'KeyCheckEmbeddedStackKey/ModuleStackKey/Resource';
		assert.deepStrictEqual(keyPolicyWarnings(app.synth(), stack), [
			[
				`/${keyPath}`,
				`${keyPolicyProblem(keyPath, 'cloudwatch.amazonaws.com', 1)} To keep the statement as it is, acknowledge ` +
					`this warning: Annotations.of(key).acknowledgeWarning('${KMS_KEY_POLICY_WARNING_ID}'), or on the ` +
					`stack to acknowledge it for every key in the stack. [ack: ${KMS_KEY_POLICY_WARNING_ID}]`,
			],
		]);
	});

	test('a key outside an embedded backend is not checked', async () => {
		const { app, stack } = await trustCheckEmbeddedBackend('KeyCheckOutsideBackend', {});
		serviceKey(stack, 'OutsideBackend', 'cloudwatch.amazonaws.com');
		assert.deepStrictEqual(keyPolicyWarnings(app.synth(), stack), []);
	});
});
