// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { ScopeParent } from '../common/index.js';
import { ensureApiGatewayAccount } from './apigateway-account.js';
import { BlocksBackend } from './blocks-backend.js';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { ComputeBase } from './compute/compute.js';
import type { DefaultComputeFactory } from './compute/default-compute-factory.js';
import { BlocksStack } from './index.js';
import {
	findUnscopedServiceTrust,
	SERVICE_TRUST_EXCLUSIONS,
	scopeProviderWaiterTrust,
	UNSCOPED_SERVICE_TRUST_WARNING,
} from './service-trust.js';

// Same inline default-compute stub as permissions-boundary.test.ts.
class StubLambdaCompute extends ComputeBase {
	readonly fn: nodejs.NodejsFunction;

	constructor(scope: ScopeParent, id: string) {
		super(id, { parent: scope });
		this.fn = new nodejs.NodejsFunction(this, 'Handler', {
			entry: this.backendHandlerPath,
			runtime: lambda.Runtime.NODEJS_22_X,
			handler: 'handler',
			role: this.executionRole,
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
/** Its block creates a helper role trusted by bedrock.amazonaws.com with no conditions. */
const unscopedBackendPath = join(__dirname, '__fixtures__', 'iam-boundary-backend.js');
const noRoleBackendPath = join(__dirname, '__fixtures__', 'factory-backend.js');

const trust = (service: unknown, condition?: Record<string, unknown>, effect = 'Allow') => ({
	Version: '2012-10-17',
	Statement: [
		{
			Effect: effect,
			Principal: { Service: service },
			Action: 'sts:AssumeRole',
			...(condition ? { Condition: condition } : {}),
		},
	],
});
const BOTH = {
	StringEquals: { 'aws:SourceAccount': '123456789012' },
	ArnLike: { 'aws:SourceArn': 'arn:aws:states:us-east-1:123456789012:stateMachine:*' },
};
const WARNING_ACK_TAG = Match.stringLikeRegexp(`\\[ack: ${UNSCOPED_SERVICE_TRUST_WARNING}\\]$`);

describe('findUnscopedServiceTrust', () => {
	test('reports a service trust with neither key', () => {
		assert.deepStrictEqual(findUnscopedServiceTrust(trust('states.amazonaws.com')), [
			{ principal: 'states.amazonaws.com', missing: ['aws:SourceAccount', 'aws:SourceArn'] },
		]);
	});

	test('reports a service trust with aws:SourceAccount only', () => {
		const gaps = findUnscopedServiceTrust(
			trust('bedrock.amazonaws.com', { StringEquals: { 'aws:SourceAccount': '123456789012' } }),
		);
		assert.deepStrictEqual(gaps, [{ principal: 'bedrock.amazonaws.com', missing: ['aws:SourceArn'] }]);
	});

	test('accepts both keys under any operator, matching key names case-insensitively', () => {
		assert.deepStrictEqual(findUnscopedServiceTrust(trust('states.amazonaws.com', BOTH)), []);
		assert.deepStrictEqual(
			findUnscopedServiceTrust(
				trust('bedrock.amazonaws.com', {
					StringEquals: { 'aws:sourceaccount': '123456789012' },
					StringLike: { 'AWS:SourceArn': 'arn:aws:bedrock:us-east-1:123456789012:knowledge-base/*' },
				}),
			),
			[],
		);
	});

	test('a key under a non-constraining operator or with a wildcard-only value counts as missing', () => {
		const both = { principal: 'bedrock.amazonaws.com', missing: ['aws:SourceAccount', 'aws:SourceArn'] };
		for (const condition of [
			{ Null: { 'aws:SourceAccount': 'false', 'aws:SourceArn': 'false' } },
			{
				StringNotEquals: { 'aws:SourceAccount': '000000000000' },
				ArnNotLike: { 'aws:SourceArn': 'arn:aws:x:::y' },
			},
			{
				StringEqualsIfExists: { 'aws:SourceAccount': '123456789012' },
				ArnLikeIfExists: { 'aws:SourceArn': 'arn:*' },
			},
			{ 'ForAnyValue:StringEquals': { 'aws:SourceAccount': '123456789012', 'aws:SourceArn': 'arn:aws:x:::y' } },
			{ StringEquals: { 'aws:SourceAccount': '*' }, ArnLike: { 'aws:SourceArn': ['*'] } },
			{ StringLike: { 'aws:SourceAccount': '*' }, StringEquals: { 'aws:SourceArn': [] } },
		]) {
			assert.deepStrictEqual(
				findUnscopedServiceTrust(trust('bedrock.amazonaws.com', condition)),
				[both],
				JSON.stringify(condition),
			);
		}
		assert.deepStrictEqual(
			findUnscopedServiceTrust(
				trust('bedrock.amazonaws.com', {
					StringEquals: { 'aws:SourceAccount': '123456789012' },
					ArnNotLike: { 'aws:SourceArn': 'arn:aws:bedrock:*' },
				}),
			),
			[{ principal: 'bedrock.amazonaws.com', missing: ['aws:SourceArn'] }],
		);
	});

	test('an intrinsic condition value counts as concrete', () => {
		assert.deepStrictEqual(
			findUnscopedServiceTrust(
				trust('states.amazonaws.com', {
					StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
					ArnLike: {
						'aws:SourceArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':states:*']] },
					},
				}),
			),
			[],
		);
	});

	test('reports a service principal that is not a literal string instead of skipping it', () => {
		const principal = { 'Fn::Sub': 'bedrock.amazonaws.com' };
		assert.deepStrictEqual(findUnscopedServiceTrust(trust([principal, 'lambda.amazonaws.com'])), [
			{ principal: JSON.stringify(principal), missing: ['aws:SourceAccount', 'aws:SourceArn'] },
		]);
		assert.deepStrictEqual(findUnscopedServiceTrust(trust(principal, BOTH)), []);
	});

	test('reports each non-excluded principal of a multi-principal statement', () => {
		assert.deepStrictEqual(findUnscopedServiceTrust(trust(['lambda.amazonaws.com', 'states.amazonaws.com'])), [
			{ principal: 'states.amazonaws.com', missing: ['aws:SourceAccount', 'aws:SourceArn'] },
		]);
	});

	test('ignores Deny statements and non-service principals', () => {
		assert.deepStrictEqual(findUnscopedServiceTrust(trust('states.amazonaws.com', undefined, 'Deny')), []);
		assert.deepStrictEqual(
			findUnscopedServiceTrust({ Statement: [{ Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::1:root' } }] }),
			[],
		);
	});

	test('the Lambda execution-role principals are excluded on every role', () => {
		assert.deepStrictEqual(
			findUnscopedServiceTrust(trust(['lambda.amazonaws.com', 'edgelambda.amazonaws.com'])),
			[],
		);
	});

	test('apigateway.amazonaws.com is excluded only on the account-level CloudWatch Logs role', () => {
		const doc = trust('apigateway.amazonaws.com');
		assert.deepStrictEqual(findUnscopedServiceTrust(doc, ['BlocksApiGatewayCloudWatchRoleAB12CD34']), []);
		assert.deepStrictEqual(findUnscopedServiceTrust(doc, ['App/BlocksApiGatewayCloudWatchRole/Resource']), []);
		const gap = [{ principal: 'apigateway.amazonaws.com', missing: ['aws:SourceAccount', 'aws:SourceArn'] }];
		assert.deepStrictEqual(findUnscopedServiceTrust(doc, ['App/Api/CredentialsRole/Resource']), gap);
		// A construct whose id only starts with the role's name, and roles inside it, are not excluded.
		assert.deepStrictEqual(
			findUnscopedServiceTrust(doc, ['App/BlocksApiGatewayCloudWatchRoleHelper/AnyRole/Resource']),
			gap,
		);
		assert.deepStrictEqual(
			findUnscopedServiceTrust(doc, ['App/BlocksApiGatewayCloudWatchRole/Inner/Resource']),
			gap,
		);
		assert.deepStrictEqual(
			findUnscopedServiceTrust(doc, ['BlocksApiGatewayCloudWatchRoleHelperAnyRoleAB12CD34']),
			gap,
		);
	});

	test('every exclusion names a reason and an AWS documentation link', () => {
		for (const e of SERVICE_TRUST_EXCLUSIONS) {
			assert.ok(e.reason.length > 0, `${e.principal}: reason`);
			assert.match(e.reference, /^https:\/\/docs\.aws\.amazon\.com\//, `${e.principal}: reference`);
		}
	});
});

describe('scopeProviderWaiterTrust', () => {
	const fn = (stack: cdk.Stack, id: string) =>
		new lambda.Function(stack, id, {
			runtime: lambda.Runtime.NODEJS_22_X,
			handler: 'index.handler',
			code: lambda.Code.fromInline('exports.handler = async () => ({});'),
		});

	test("scopes the waiter state machine's role to this account's state machines", () => {
		const stack = new cdk.Stack(new cdk.App(), 'Waiter');
		const provider = new cr.Provider(stack, 'Provider', {
			onEventHandler: fn(stack, 'OnEvent'),
			isCompleteHandler: fn(stack, 'IsComplete'),
		});
		scopeProviderWaiterTrust(provider);
		const waiterRole = provider.node.findChild('waiter-state-machine').node.findChild('Role').node
			.defaultChild as cdk.CfnResource;
		const template = Template.fromStack(stack);
		const rendered =
			template.toJSON().Resources[stack.resolve(waiterRole.logicalId)].Properties.AssumeRolePolicyDocument;
		assert.deepStrictEqual(rendered.Statement, [
			{
				Effect: 'Allow',
				Principal: { Service: 'states.amazonaws.com' },
				Action: 'sts:AssumeRole',
				Condition: {
					StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
					ArnLike: {
						'aws:SourceArn': {
							'Fn::Join': [
								'',
								[
									'arn:',
									{ Ref: 'AWS::Partition' },
									':states:',
									{ Ref: 'AWS::Region' },
									':',
									{ Ref: 'AWS::AccountId' },
									':stateMachine:*',
								],
							],
						},
					},
				},
			},
		]);
		assert.deepStrictEqual(findUnscopedServiceTrust(rendered), []);
	});

	test('is a no-op for a provider without isCompleteHandler', () => {
		const stack = new cdk.Stack(new cdk.App(), 'NoWaiter');
		const provider = new cr.Provider(stack, 'Provider', { onEventHandler: fn(stack, 'OnEvent') });
		assert.doesNotThrow(() => scopeProviderWaiterTrust(provider));
	});
});

describe('unscoped service-trust synth warning', () => {
	const defaults: BlocksDefaults = { ...BlocksPresets.production, accessLogging: true };

	test('BlocksStack warns on a role a service can assume without the keys, and synth still succeeds', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'Unscoped', {
			backendHandlerPath: handlerPath,
			backendCDKPath: unscopedBackendPath,
			defaults,
			defaultComputeFactory: stubComputeFactory,
		});
		const annotations = Annotations.fromStack(stack);
		const warnings = annotations.findWarning('*', WARNING_ACK_TAG);
		assert.strictEqual(warnings.length, 1, JSON.stringify(warnings, null, 2));
		assert.match(warnings[0].id, /\/kv\/HelperRole\/Resource$/);
		assert.match(
			String(warnings[0].entry.data),
			/bedrock\.amazonaws\.com trust lacks aws:SourceAccount and aws:SourceArn/,
		);
	});

	test('acknowledging the warning id on an ancestor silences it', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'Acknowledged', {
			backendHandlerPath: handlerPath,
			backendCDKPath: unscopedBackendPath,
			defaults,
			defaultComputeFactory: stubComputeFactory,
		});
		cdk.Annotations.of(stack).acknowledgeWarning(UNSCOPED_SERVICE_TRUST_WARNING);
		Annotations.fromStack(stack).hasNoWarning('*', WARNING_ACK_TAG);
	});

	test('BlocksStack with access logging and no unscoped role adds no warning', async () => {
		const app = new cdk.App();
		const stack = await BlocksStack.create(app, 'Scoped', {
			backendHandlerPath: handlerPath,
			backendCDKPath: noRoleBackendPath,
			defaults,
			defaultComputeFactory: stubComputeFactory,
		});
		// The account-level CloudWatch Logs role (an excluded principal) is in the stack.
		ensureApiGatewayAccount(stack);
		Template.fromStack(stack).hasResourceProperties('AWS::ApiGateway::Account', {});
		Annotations.fromStack(stack).hasNoWarning('*', WARNING_ACK_TAG);
	});

	test('an embedded BlocksBackend warns on its own unscoped role', async () => {
		const app = new cdk.App();
		const parent = new cdk.Stack(app, 'Parent');
		new iam.Role(parent, 'CustomerRole', { assumedBy: new iam.ServicePrincipal('states.amazonaws.com') });
		await BlocksBackend.create(parent, 'Blocks', {
			backendHandlerPath: handlerPath,
			backendCDKPath: unscopedBackendPath,
			defaults,
			defaultComputeFactory: stubComputeFactory,
		});
		const warnings = Annotations.fromStack(parent).findWarning('*', WARNING_ACK_TAG);
		// The backend's helper role only: the customer's own role outside the backend is not a Blocks role.
		assert.deepStrictEqual(
			warnings.map((w) => w.id),
			['/Parent/Blocks/kv/HelperRole/Resource'],
		);
	});
});
