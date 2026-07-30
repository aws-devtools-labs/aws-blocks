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
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
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

function setup(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App();
	const stack = new StubBlocksStack(app, 'TestStack');
	const parent = new Scope('app');
	return { stack, parent };
}

/** Same as setup() but simulates a sandbox deploy (`--context sandboxMode=true`). */
function setupSandbox(): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App({ context: { sandboxMode: 'true' } });
	const stack = new StubBlocksStack(app, 'TestStack');
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

// ── Secure-by-default durability & encryption (prod) ────────────────────────
// Regression for the bug bash finding: prod DDB tables shipped with
// DeletionProtection off, PITR disabled, and SSE (KMS) unset.

test('CDK: prod DistributedTable enables PITR by default', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
	});
});

test('CDK: prod DistributedTable enables DeletionProtection by default', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: true,
	});
});

test('CDK: prod DistributedTable enables SSE (KMS-managed) by default', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	// AWS_MANAGED emits SSEEnabled:true with no SSEType (the aws/dynamodb key).
	// Contrast with the AWS-owned default, which emits no SSESpecification at all,
	// and customer-managed, which adds SSEType:'KMS' + a KMSMasterKeyId.
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: Match.absent() },
	});
});

test('CDK: prod DistributedTable table is RETAINed on stack delete by default', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Retain',
	});
});

// ── Sandbox stays cheap & fully deletable ───────────────────────────────────

test('CDK: sandbox DistributedTable disables DeletionProtection (so sandbox:destroy works)', () => {
	const { stack, parent } = setupSandbox();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: false,
	});
});

test('CDK: sandbox DistributedTable does not enable PITR (cost)', () => {
	const { stack, parent } = setupSandbox();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
	});
});

test('CDK: sandbox DistributedTable table is DESTROYed on stack delete', () => {
	const { stack, parent } = setupSandbox();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Delete',
	});
});

// ── Customer overrides win over the secure defaults ─────────────────────────

test('CDK: customer can opt OUT of PITR/DeletionProtection in prod', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: false,
		deletionProtection: false,
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
		DeletionProtectionEnabled: false,
	});
});

test('CDK: customer can opt INTO durable/protected tables even in sandbox', () => {
	const { stack, parent } = setupSandbox();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: true,
		deletionProtection: true,
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		DeletionProtectionEnabled: true,
	});
});

test('CDK: customer-managed encryption provisions a KMS key', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'customer-managed',
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::KMS::Key', 1);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
	});
});

test('CDK: fromExisting does not emit durability props (customer owns the table)', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		table: DistributedTable.fromExisting('preexisting-users-table'),
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 0);
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
