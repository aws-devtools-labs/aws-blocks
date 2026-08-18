// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for DistributedTable.
 *
 * History: DistributedTable.fromExisting was advertised in the runtime build
 * but the CDK constructor unconditionally provisioned a new DynamoDB table
 * AND the static factory was missing entirely from the CDK class. These
 * tests pin the fix and ensure GSI custom resources are NOT created when
 * binding to an external table.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { z } from 'zod';
import { DistributedTable } from './index.cdk.js';

const userSchema = z.object({
	userId: z.string(),
	email: z.string(),
	createdAt: z.number(),
});

class StubBlocksStack extends cdk.Stack {
	public readonly handler: cdk.aws_lambda.Function;
	public readonly id: string;
	public defaults: BlocksDefaults = BlocksPresets.production;
	constructor(scope: Construct, id: string) {
		super(scope, id);
		this.id = id;
		(globalThis as any).CURRENT_BLOCKS_STACK = this;
		this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
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

test('CDK: default DistributedTable provisions a DynamoDB table', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 1);
});

test('CDK: table adopts sandbox defaults (DESTROY, deletion protection off)', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
});

test('CDK: table adopts production defaults (RETAIN, deletion protection on)', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: DistributedTable.fromExisting does NOT provision a table (regression)', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		table: DistributedTable.fromExisting('preexisting-users-table'),
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 0);
});

test('CDK: DistributedTable.fromExisting with indexes does NOT provision the GSI custom resource', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: {
			byEmail: { partitionKey: 'email' },
		},
		table: DistributedTable.fromExisting('preexisting-users-table'),
	});
	const template = Template.fromStack(stack);
	// The GSI manager is realized as a Provider (Lambda + custom resource).
	// `fromExisting` must opt out of touching indexes — the customer owns
	// the existing table's index lifecycle.
	template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
});

test('CDK: DistributedTable.fromExisting returns a branded ref', () => {
	const ref = DistributedTable.fromExisting('foo');
	assert.strictEqual(ref.tableName, 'foo');
	assert.strictEqual(ref.__brand, 'ExternalTableRef');
});

test('CDK: calling a runtime data method throws an actionable error (not a cryptic TypeError)', () => {
	const { parent } = setup();
	const table = new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	}) as any;
	for (const method of ['get', 'put', 'delete', 'query', 'scan', 'getBatch', 'putBatch', 'deleteBatch']) {
		assert.throws(
			() => table[method]('k'),
			/cannot be called during CDK synth/,
			`${method}() should throw the actionable synth-time error`,
		);
	}
});
