// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import type { ScopeParent } from '../common/index.js';
import { ensureApiGatewayAccount } from './apigateway-account.js';
import { BlocksPresets } from './blocks-defaults.js';
import { coverBlocksRoot } from './blocks-roles.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';
import {
	addServicePrincipalTrustCheck,
	SERVICE_PRINCIPAL_TRUST_WARNING_ID,
	sourceScopedConditions,
	unconditionedServicePrincipals,
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

/** The full error a role AWS Blocks owns fails synth with. */
function trustError(rolePath: string, service: string): string {
	return (
		`[${rolePath}] IAM role ${rolePath} trusts the service principal ${service} without an ` +
		'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
		'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement.'
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
		"For a role a CDK construct creates with no prop for its trust, set the condition on the role's L1 resource: " +
		`role.node.defaultChild.addPropertyOverride('AssumeRolePolicyDocument.Statement.${index}.Condition', ` +
		"{ StringEquals: { 'aws:SourceAccount': ... }, ArnLike: { 'aws:SourceArn': ... } }). " +
		'To keep the trust as it is, acknowledge this warning: ' +
		`Annotations.of(role).acknowledgeWarning('${SERVICE_PRINCIPAL_TRUST_WARNING_ID}'), or on the stack ` +
		`to acknowledge it for every role in the stack. [ack: ${SERVICE_PRINCIPAL_TRUST_WARNING_ID}]`
	);
}

/** A BlocksStack whose backend module is the trust-check fixture. */
async function trustCheckBlocksStack(id: string, { blockRole }: { blockRole: boolean }) {
	const app = new cdk.App();
	if (blockRole) process.env.TRUST_CHECK_BLOCK_ROLE = '1';
	try {
		const stack = await BlocksStack.create(app, id, {
			backendHandlerPath: handlerPath,
			backendCDKPath: trustBackendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		});
		return { app, stack };
	} finally {
		delete process.env.TRUST_CHECK_BLOCK_ROLE;
	}
}

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

	test('exempts only apigateway.amazonaws.com, and only on the stack-level CloudWatch Logs role', () => {
		const { app, stack } = checkedStack();
		// Another principal on the CloudWatch Logs role id is still reported.
		const cloudWatchRole = new iam.Role(stack, 'BlocksApiGatewayCloudWatchRole', {
			assumedBy: new iam.CompositePrincipal(
				new iam.ServicePrincipal('apigateway.amazonaws.com'),
				new iam.ServicePrincipal('glue.amazonaws.com'),
			),
		});
		assert.deepStrictEqual(unconditionedServicePrincipals(roleResource(cloudWatchRole)), ['glue.amazonaws.com']);
		// API Gateway on any other role, or on the same id below stack scope, is reported.
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
		const path = (p: string) => `TrustCheckAppRoles/${p}/Resource`;
		const byId = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);
		// The EventsRole CDK creates for `targets.SfnStateMachine` only warns: the
		// app owns it. (CDK already scopes the state machine's own role.)
		const expected: [string, string][] = [
			['LateUnconditioned', 'glue.amazonaws.com'],
			['ModuleRole', 'glue.amazonaws.com'],
			['UserSM/EventsRole', 'events.amazonaws.com'],
			['app/NamespaceRole', 'glue.amazonaws.com'],
		].map(([role, service]) => [`/${path(role)}`, trustWarning(path(role), service, 0)]);
		assert.deepStrictEqual(trustWarnings(assembly, stack).sort(byId), expected.sort(byId));
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
