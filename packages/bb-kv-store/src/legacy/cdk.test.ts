// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side tests for LegacyKVStore: the table is declared as release 0.4.0
 * declares it, under the logical id that a store with the same id has, and the
 * app's role gets the grant of that release.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-cdk-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';
import { KVStore, LegacyKVStore } from '../index.cdk.js';

// Minimal BlocksStack-shaped parent: the shared `executionRole`, a handler, and `defaults`.
class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly executionRole: cdk.aws_iam.IRole;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
			assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
		});
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
			role: this.executionRole,
		});
	}
}

function setup(defaults: BlocksDefaults = BlocksPresets.production): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	stack.defaults = defaults;
	const parent = new Scope('app');
	return { stack, parent };
}

/** Every IAM action that the stack grants on DynamoDB. */
function dynamoDbActions(template: Template): string[] {
	const actions: string[] = [];
	for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
		for (const statement of policy.Properties.PolicyDocument.Statement) {
			for (const action of [statement.Action].flat()) {
				if (typeof action === 'string' && action.startsWith('dynamodb:')) actions.push(action);
			}
		}
	}
	return actions;
}

test('CDK: LegacyKVStore declares the table of release 0.4.0: key pk, the name from the id, no TTL', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new LegacyKVStore(parent, 'prefs');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 1);
	template.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Delete',
		Properties: {
			TableName: 'TestStack-app-prefs',
			KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
			AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
			BillingMode: 'PAY_PER_REQUEST',
			TimeToLiveSpecification: Match.absent(),
			StreamSpecification: Match.absent(),
		},
	});
});

test('CDK: the table has the logical id of the table of a KVStore with the same id', () => {
	const legacy = setup();
	new LegacyKVStore(legacy.parent, 'prefs');
	const [legacyId] = Object.keys(Template.fromStack(legacy.stack).findResources('AWS::DynamoDB::Table'));
	const store = setup();
	new KVStore(store.parent, 'prefs');
	const [storeId] = Object.keys(Template.fromStack(store.stack).findResources('AWS::DynamoDB::Table'));
	assert.strictEqual(legacyId, storeId);
});

test('CDK: the options of the old store give the table its 0.4.0 properties', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new LegacyKVStore(parent, 'prefs', {
		ttl: true,
		removalPolicy: 'retain',
		deletionProtection: true,
		pointInTimeRecovery: { retentionDays: 7 },
		encryption: 'customer-managed',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Retain',
		UpdateReplacePolicy: 'Retain',
		Properties: {
			TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
			DeletionProtectionEnabled: true,
			PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
			SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
		},
	});
	template.resourceCountIs('AWS::KMS::Key', 1);
});

test('CDK: with no options the stack defaults apply, as in the release', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new LegacyKVStore(parent, 'prefs');
	Template.fromStack(stack).hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Retain',
		Properties: {
			DeletionProtectionEnabled: true,
			PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		},
	});
});

test('CDK: the app role gets the grant of release 0.4.0 on the table: read and write', () => {
	const { stack, parent } = setup();
	new LegacyKVStore(parent, 'prefs');
	const actions = dynamoDbActions(Template.fromStack(stack));
	for (const granted of ['dynamodb:GetItem', 'dynamodb:Scan', 'dynamodb:PutItem', 'dynamodb:DeleteItem']) {
		assert.ok(actions.includes(granted), `${granted} is granted`);
	}
	// The release grants with `grantReadWriteData`. The same call on a plain table gives the same actions.
	const plain = setup();
	new Table(plain.stack, 'plain', { partitionKey: { name: 'pk', type: AttributeType.STRING } }).grantReadWriteData(
		plain.stack.executionRole,
	);
	assert.deepStrictEqual([...actions].sort(), dynamoDbActions(Template.fromStack(plain.stack)).sort());
});

test('CDK: a table from KVStore.fromExisting is not declared, and its table options warn', () => {
	const { stack, parent } = setup();
	new LegacyKVStore(parent, 'prefs', { table: KVStore.fromExisting('my-table'), ttl: true });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 0);
	Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('Ignoring ttl'));
	assert.ok(dynamoDbActions(template).includes('dynamodb:DeleteItem'));
});

test('CDK: the data methods throw the synth guard', () => {
	const { parent } = setup();
	const old = new LegacyKVStore(parent, 'prefs');
	for (const method of ['get', 'put', 'scan', 'delete'] as const) {
		assert.throws(
			() => old[method]('a'),
			new RegExp(`LegacyKVStore\\.${method}\\(\\) cannot be called during CDK synth`),
		);
	}
});
