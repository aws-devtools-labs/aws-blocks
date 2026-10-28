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
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
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

test('CDK: default PITR does not pin a recovery window (DynamoDB 35-day default)', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: {
			PointInTimeRecoveryEnabled: true,
			RecoveryPeriodInDays: Match.absent(),
		},
	});
});

test('CDK: pointInTimeRecovery { retentionDays } enables PITR and pins the window', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: { retentionDays: 7 },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: {
			PointInTimeRecoveryEnabled: true,
			RecoveryPeriodInDays: 7,
		},
	});
});

test('CDK: an out-of-range retentionDays falls back to the default window (still enabled)', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: { retentionDays: 60 },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: {
			PointInTimeRecoveryEnabled: true,
			RecoveryPeriodInDays: Match.absent(),
		},
	});
});

test('CDK: pointInTimeRecovery: false disables PITR', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: false,
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
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

// (Sandbox-default behavior — DESTROY, deletion protection off, PITR off — is
// covered by the "adopts sandbox defaults" / "PITR follows the stack defaults"
// tests above, which drive it through the stack `defaults` rather than the
// `sandboxMode` context.)

// ── Customer overrides win over the secure defaults ─────────────────────────

test('CDK: customer can opt OUT of PITR + protection in prod', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: false,
		protection: 'disposable',
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
		DeletionProtectionEnabled: false,
	});
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
});

test('CDK: customer can opt INTO durable/protected tables even under the sandbox preset', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: true,
		protection: 'locked',
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		DeletionProtectionEnabled: true,
	});
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
});

test("CDK: protection 'retained' orphans the table without locking deletes", () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		protection: 'retained',
	});
	const template = Template.fromStack(stack);
	// RETAIN on stack delete, but deletion protection OFF (a direct delete works).
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: false,
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

test('CDK: an auto-created CMK is DESTROYED with the table under the sandbox preset', () => {
	// #670: the dedicated CMK defaults to RemovalPolicy.RETAIN, so without the
	// guard it would survive a DESTROY table teardown as an orphaned, billed,
	// rotating key. Under sandbox the key must follow the table to DELETE.
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'customer-managed',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});

test('CDK: an auto-created CMK is RETAINED with the table under the production preset', () => {
	// The key is never less durable than the table it encrypts: production
	// RETAINs the table, so the key is retained too.
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'customer-managed',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
});

test('CDK: protection override wins for the CMK — a retained table under sandbox keeps its key', () => {
	// The guard applies the RESOLVED removal policy, which `protection` overrides
	// — not the preset default. A `retained` table under the sandbox preset must
	// keep its key: a retained table whose only CMK is scheduled for deletion is
	// unreadable and unrecoverable after the 30-day KMS window. This case fails
	// if the guard uses the preset (`this.defaults`) instead of the resolved
	// policy, which the preset-only tests above cannot detect.
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'customer-managed',
		protection: 'retained',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
});

test('CDK: protection override wins for the CMK — a disposable table under production destroys its key', () => {
	// The reverse override: a `disposable` table under the production preset must
	// DESTROY its key, reached only through the resolved policy, not the preset.
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'customer-managed',
		protection: 'disposable',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
});

test('CDK: an imported fromKmsKey survives the removal-policy guard under sandbox', () => {
	// The `!encryptionKey` guard matters because `applyRemovalPolicy` on an
	// imported `Key.fromKeyArn` THROWS — an imported key has no `CfnResource`
	// child to stamp a policy on. So the real thing this pins is that
	// construction does not throw under the sandbox preset (where an auto-created
	// key WOULD be destroyed) and that the table still encrypts with the imported
	// ARN. (The sibling `fromKmsKey ... provisions no new KMS key` test below
	// covers the resource count.)
	const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
	const { stack, parent } = setup(BlocksPresets.sandbox);
	assert.doesNotThrow(() => new DistributedTable(parent, 'orders', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: DistributedTable.fromKmsKey(keyArn),
	}));
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: keyArn },
	});
});

test('CDK: fromKmsKey encrypts with an existing key and provisions no new KMS key', () => {
	const { stack, parent } = setup();
	const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
	new DistributedTable(parent, 'orders', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: DistributedTable.fromKmsKey(keyArn),
	});
	const template = Template.fromStack(stack);
	// Bringing an existing key must NOT mint a new one (the whole point — a
	// shared key across tables instead of one dedicated key each).
	template.resourceCountIs('AWS::KMS::Key', 0);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: keyArn },
	});
});

test('CDK: two tables sharing one fromKmsKey ref provision zero KMS keys', () => {
	const { stack, parent } = setup();
	const sharedKey = DistributedTable.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/shared-1');
	new DistributedTable(parent, 'orders', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: sharedKey,
	});
	new DistributedTable(parent, 'events', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: sharedKey,
	});
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::KMS::Key', 0);
	template.resourceCountIs('AWS::DynamoDB::Table', 2);
});

test('CDK: fromExisting ignores durability props (customer owns the table)', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		table: DistributedTable.fromExisting('preexisting-users-table'),
		// These must be inert when wrapping an existing table.
		pointInTimeRecovery: true,
		protection: 'locked',
		encryption: 'customer-managed',
	});
	const template = Template.fromStack(stack);
	// No table is provisioned, and customer-managed encryption does NOT
	// provision a CMK — proving the durability options are ignored.
	template.resourceCountIs('AWS::DynamoDB::Table', 0);
	template.resourceCountIs('AWS::KMS::Key', 0);
});

// ── Durability follows the stack `defaults` when no per-block override (#302) ──

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

test('CDK: PITR follows the stack defaults — off under the sandbox preset', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
	});
});

test('CDK: options.pointInTimeRecovery overrides the stack defaults (on under sandbox)', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: true,
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
	});
});

test('CDK: a per-block protection option overrides the stack defaults', () => {
	// Sandbox preset would give DESTROY + no protection; `protection: 'locked'`
	// must win, proving the per-block override sits on top of the #302 defaults.
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		protection: 'locked',
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: GSI manager Lambda log groups adopt defaults.logRetention', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: { byEmail: { partitionKey: 'email' } },
	});
	const template = Template.fromStack(stack);
	// The GSI manager + isComplete Lambdas now own explicit log groups whose
	// retention follows the stack-wide default (sandbox → one week), instead of
	// AWS's infinite default.
	template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
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

// ── Synth-time warnings actually fire (not just the fallback values) ─────────

test('CDK: an unrecognized protection value warns at synth', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		protection: 'retian', // intentional typo — exercise the synth guard
	});
	Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('Unrecognized protection'));
});

test('CDK: an unrecognized encryption value warns at synth', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		encryption: 'kms', // intentional typo — exercise the synth guard
	});
	Annotations.fromStack(stack).hasWarning(
		'*',
		Match.stringLikeRegexp('Unrecognized encryption.*ack: @aws-blocks/bb-distributed-table:UnknownEncryption'),
	);
});

test('CDK: an out-of-range retentionDays warns at synth', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		pointInTimeRecovery: { retentionDays: 60 },
	});
	Annotations.fromStack(stack).hasWarning(
		'*',
		Match.stringLikeRegexp('retentionDays must be an integer.*ack: @aws-blocks/bb-distributed-table:InvalidPitrDays'),
	);
});

test('CDK: durability options passed alongside fromExisting warn at synth', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		table: DistributedTable.fromExisting('preexisting-users-table'),
		protection: 'locked',
		pointInTimeRecovery: { retentionDays: 14 },
	});
	Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('wrapped via fromExisting'));
});

// --- GSI manager Delete: stack-status lookup ---
// On Delete the GSI manager reads its own stack's status and template so a
// table leaving the stack keeps its indexes (see gsi-manager-lambda.test.ts). The
// upgrade must not touch the table or re-invoke the custom resource: the
// template change is one IAM statement plus the Lambda code asset.

type CfnResource = { Type: string; Properties?: any; DependsOn?: string[] };

function gsiTemplate(): Record<string, CfnResource> {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: { byEmail: { partitionKey: 'email' }, byCreated: { partitionKey: 'email', sortKey: 'createdAt' } },
	});
	return Template.fromStack(stack).toJSON().Resources;
}

function policyStatementsOf(resources: Record<string, CfnResource>, functionPrefix: string) {
	const [fnId, fn] = Object.entries(resources).find(
		([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(functionPrefix),
	) ?? [];
	assert.ok(fn, `function ${functionPrefix} not found`);
	const roleId = fn.Properties.Role['Fn::GetAtt'][0];
	const policies = Object.entries(resources).filter(
		([, r]) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((ref: any) => ref.Ref === roleId),
	);
	return { fnId, fn, policies };
}

test('CDK: GSI manager may read its own stack only, from a policy its function depends on', () => {
	const resources = gsiTemplate();
	const { fn, policies } = policyStatementsOf(resources, 'BlocksGsiManager');
	// One policy per role: a separate policy would have no DependsOn edge and a
	// stack delete could remove it before the custom resource's Delete runs.
	assert.strictEqual(policies.length, 1);
	const [policyId, policy] = policies[0];
	assert.ok(fn.DependsOn?.includes(policyId), 'the GSI manager function DependsOn its policy');
	const stackRead = policy.Properties.PolicyDocument.Statement.filter((s: any) =>
		[s.Action].flat().some((a: string) => a.startsWith('cloudformation:')),
	);
	assert.deepStrictEqual(stackRead, [
		{
			Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
			Effect: 'Allow',
			Resource: { Ref: 'AWS::StackId' },
		},
	]);
});

test('CDK: only the GSI onEvent function gets the stack-status lookup', () => {
	const resources = gsiTemplate();
	const { policies } = policyStatementsOf(resources, 'BlocksGsiIsComplete');
	const actions = policies.flatMap(([, p]) =>
		p.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat()),
	);
	assert.ok(!actions.some((a: string) => a.startsWith('cloudformation:')));
	const anyCfn = Object.values(resources)
		.filter((r) => r.Type === 'AWS::IAM::Policy')
		.flatMap((p) => p.Properties.PolicyDocument.Statement)
		.filter((s: any) => [s.Action].flat().some((a: string) => a.startsWith('cloudformation:')));
	assert.strictEqual(anyCfn.length, 1);
});

test('CDK: GSI custom resource properties are unchanged, so upgrading does not re-invoke it', () => {
	const resources = gsiTemplate();
	const custom = Object.values(resources).filter((r) => r.Type === 'AWS::CloudFormation::CustomResource');
	assert.strictEqual(custom.length, 1);
	const { ServiceToken: _token, ...props } = custom[0].Properties;
	assert.deepStrictEqual(Object.keys(props).sort(), ['Indexes', 'SandboxMode', 'TableName', 'Version']);
	assert.strictEqual(props.Version, '3');
	assert.strictEqual(props.SandboxMode, 'false');
});

test('CDK: the table name is a literal in the template, as the GSI manager Delete check requires', () => {
	// On Delete the GSI manager compares this literal with the custom resource's
	// TableName to tell whether the table stays in the stack. A token here would
	// never match, and removing `indexes` would silently stop dropping them.
	const resources = gsiTemplate();
	const tables = Object.values(resources).filter((r) => r.Type === 'AWS::DynamoDB::Table');
	assert.strictEqual(tables.length, 1);
	assert.strictEqual(tables[0].Properties.TableName, 'TestStack-app-users');
});

test('CDK: a table without indexes gets no stack-status lookup', () => {
	const { stack, parent } = setup();
	new DistributedTable(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
	});
	const json = JSON.stringify(Template.fromStack(stack).toJSON());
	assert.ok(!json.includes('cloudformation:'));
});
