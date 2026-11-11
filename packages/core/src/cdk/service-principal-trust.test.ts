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
import type { ScopeParent } from '../common/index.js';
import { coverBlocksRoot } from './blocks-roles.js';
import { BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';
import { addServicePrincipalTrustCheck, unconditionedServicePrincipals } from './service-principal-trust.js';

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
const iamBackendPath = join(__dirname, '__fixtures__', 'iam-boundary-backend.js');

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

	test('fails synth for an unconditioned non-Lambda service role, naming the role path and principal', () => {
		const { app, stack } = checkedStack();
		new iam.Role(stack, 'Unconditioned', { assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com') });
		assert.throws(
			() => app.synth(),
			(err: Error) =>
				err.message.includes('TrustCheckStack/Unconditioned/Resource') &&
				err.message.includes('bedrock.amazonaws.com') &&
				err.message.includes('aws:SourceAccount'),
		);
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

	test('BlocksStack registers the check for roles its blocks create', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'TrustCheckBlocksStack', {
			backendHandlerPath: handlerPath,
			backendCDKPath: iamBackendPath,
			defaults: BlocksPresets.production,
			defaultComputeFactory: stubComputeFactory,
		});
		new iam.Role(stack, 'LateUnconditioned', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
		assert.throws(
			() => app.synth(),
			(err: Error) =>
				err.message.includes('TrustCheckBlocksStack/LateUnconditioned/Resource') &&
				err.message.includes('glue.amazonaws.com'),
		);
	});
});
