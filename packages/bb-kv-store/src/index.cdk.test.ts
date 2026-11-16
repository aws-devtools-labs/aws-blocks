// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for KVStore: the table's key schema for each form
 * of the store, TTL always on, the durability and encryption knobs, the GSI
 * manager, `fromExisting`, and the synth-time guards.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { KVStore, type KVStoreOptions } from './index.cdk.js';

const userSchema = z.object({
	userId: z.string(),
	email: z.string(),
	createdAt: z.number(),
});

// Minimal BlocksStack-shaped parent. The production code path uses BlocksStack,
// which exposes the shared `executionRole` (blocks grant to it) plus `handler`,
// both living inside a `cdk.Stack`. We reproduce them here so KVStore can call
// grantReadWriteData(this.executionRole) and still synth into a real stack. It
// also carries `defaults` — Building Blocks resolve `scope.defaults` by walking
// up to the owning BlocksStack/BlocksBackend, falling back to
// `globalThis.CURRENT_BLOCKS_STACK`, which is this stub in these tests.
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

// ── Key schema ──────────────────────────────────────────────────────────────

test('CDK: a store with no options provisions a table keyed by the string attribute _bkv_pk', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 1);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		TableName: 'TestStack-app-sessions',
		KeySchema: [{ AttributeName: '_bkv_pk', KeyType: 'HASH' }],
		AttributeDefinitions: [{ AttributeName: '_bkv_pk', AttributeType: 'S' }],
		BillingMode: 'PAY_PER_REQUEST',
	});
});

test('CDK: a schema without a key keeps the _bkv_pk key schema', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', { schema: userSchema, indexes: { byEmail: { partitionKey: 'email' } } });
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		KeySchema: [{ AttributeName: '_bkv_pk', KeyType: 'HASH' }],
	});
});

test('CDK: a declared key uses its fields as the key schema, with the attribute type probed from the schema', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', { schema: userSchema, key: { partitionKey: 'userId', sortKey: 'createdAt' } });
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		KeySchema: [
			{ AttributeName: 'userId', KeyType: 'HASH' },
			{ AttributeName: 'createdAt', KeyType: 'RANGE' },
		],
		AttributeDefinitions: Match.arrayWith([
			{ AttributeName: 'userId', AttributeType: 'S' },
			{ AttributeName: 'createdAt', AttributeType: 'N' },
		]),
	});
});

test('CDK: a key with one field has no sort key', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'jobs', {
		schema: z.object({ jobId: z.string(), state: z.string() }),
		key: { partitionKey: 'jobId' },
	});
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		KeySchema: [{ AttributeName: 'jobId', KeyType: 'HASH' }],
	});
});

test('CDK: a refined number key field and index field are numbers: the probe tries 0, 1 and -1', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'ledger', {
		schema: z.object({
			account: z.number().positive(),
			delta: z.number().negative(),
			owner: z.string().uuid(),
			rank: z.number().positive(),
		}),
		key: { partitionKey: 'account', sortKey: 'delta' },
		indexes: { byOwner: { partitionKey: 'owner', sortKey: 'rank' } },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		AttributeDefinitions: Match.arrayWith([
			{ AttributeName: 'account', AttributeType: 'N' },
			{ AttributeName: 'delta', AttributeType: 'N' },
		]),
	});
	template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
		Indexes: { byOwner: { partitionKey: 'owner', sortKey: 'rank', partitionKeyType: 'S', sortKeyType: 'N' } },
	});
});

// ── TTL ─────────────────────────────────────────────────────────────────────

test('CDK: TTL is always on, on _bkv_ttl by default', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions');
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		TimeToLiveSpecification: { AttributeName: '_bkv_ttl', Enabled: true },
	});
});

test('CDK: the ttl option names the field of the value that holds the expiry', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions', {
		schema: z.object({ id: z.string(), expiresAt: z.number() }),
		key: { partitionKey: 'id' },
		ttl: 'expiresAt',
	});
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
	});
});

// ── Durability ──────────────────────────────────────────────────────────────

test('CDK: table adopts the sandbox defaults (DESTROY, deletion protection off, no PITR)', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new KVStore(parent, 'sessions');
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete', UpdateReplacePolicy: 'Delete' });
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: false,
		PointInTimeRecoverySpecification: Match.absent(),
	});
});

test('CDK: table adopts the production defaults (RETAIN, deletion protection on, PITR on with no pinned window)', () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new KVStore(parent, 'sessions');
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		DeletionProtectionEnabled: true,
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: Match.absent() },
	});
});

test("CDK: protection 'disposable' opts out of retention and deletion protection in prod", () => {
	const { stack, parent } = setup(BlocksPresets.production);
	new KVStore(parent, 'sessions', { protection: 'disposable' });
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
});

test("CDK: protection 'retained' orphans the table without locking deletes", () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new KVStore(parent, 'sessions', { protection: 'retained' });
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
});

test("CDK: protection 'locked' retains and protects even under the sandbox preset", () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new KVStore(parent, 'sessions', { protection: 'locked' });
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
	template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: an unrecognized protection value warns at synth and falls back to the defaults', () => {
	const { stack, parent } = setup();
	const options: KVStoreOptions = {};
	Object.assign(options, { protection: 'bulletproof' });
	new KVStore(parent, 'sessions', options);
	Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp("Unrecognized protection 'bulletproof'"));
	Template.fromStack(stack).hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
});

// ── PITR ────────────────────────────────────────────────────────────────────

test('CDK: pointInTimeRecovery { retentionDays } enables PITR and pins the window', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: 7 } });
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 },
	});
});

test('CDK: pointInTimeRecovery: false disables PITR; true enables it under sandbox', () => {
	const prod = setup();
	new KVStore(prod.parent, 'sessions', { pointInTimeRecovery: false });
	Template.fromStack(prod.stack).hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: Match.absent(),
	});
	const sandbox = setup(BlocksPresets.sandbox);
	new KVStore(sandbox.parent, 'sessions', { pointInTimeRecovery: true });
	Template.fromStack(sandbox.stack).hasResourceProperties('AWS::DynamoDB::Table', {
		PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
	});
});

for (const days of [1, 35]) {
	test(`CDK: retentionDays ${days} is accepted — pins the window with no warning`, () => {
		const { stack, parent } = setup();
		new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: days } });
		Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
			PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: days },
		});
		Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('retentionDays must be an integer'));
	});
}

for (const days of [0, 36, 7.5]) {
	test(`CDK: retentionDays ${days} is rejected — warns and drops to the default window (PITR still on)`, () => {
		const { stack, parent } = setup();
		new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: days } });
		Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
			PointInTimeRecoverySpecification: {
				PointInTimeRecoveryEnabled: true,
				RecoveryPeriodInDays: Match.absent(),
			},
		});
		Annotations.fromStack(stack).hasWarning(
			'*',
			Match.stringLikeRegexp('retentionDays must be an integer.*ack: @aws-blocks/bb-kv-store:InvalidPitrDays'),
		);
	});
}

// ── Encryption ──────────────────────────────────────────────────────────────

test('CDK: default KVStore emits aws-managed SSE (SSEEnabled, no SSEType)', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions');
	Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: Match.absent() },
	});
});

test('CDK: customer-managed encryption provisions a KMS key that follows the table removal policy', () => {
	const prod = setup(BlocksPresets.production);
	new KVStore(prod.parent, 'sessions', { encryption: 'customer-managed' });
	const prodTemplate = Template.fromStack(prod.stack);
	prodTemplate.resourceCountIs('AWS::KMS::Key', 1);
	prodTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
	});
	prodTemplate.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
	const sandbox = setup(BlocksPresets.sandbox);
	new KVStore(sandbox.parent, 'sessions', { encryption: 'customer-managed' });
	Template.fromStack(sandbox.stack).hasResource('AWS::KMS::Key', {
		DeletionPolicy: 'Delete',
		UpdateReplacePolicy: 'Delete',
	});
});

test('CDK: protection override wins for the CMK too', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new KVStore(parent, 'sessions', { encryption: 'customer-managed', protection: 'retained' });
	Template.fromStack(stack).hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
});

test('CDK: fromKmsKey encrypts with an existing key and provisions no new KMS key, shared across stores', () => {
	const { stack, parent } = setup();
	const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
	const shared = KVStore.fromKmsKey(keyArn);
	new KVStore(parent, 'orders', { encryption: shared });
	new KVStore(parent, 'events', { encryption: shared });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::KMS::Key', 0);
	template.resourceCountIs('AWS::DynamoDB::Table', 2);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: keyArn },
	});
});

test('CDK: an unrecognized encryption value fails the synth', () => {
	const { parent } = setup();
	// The typed `encryption` union can't express an unrecognized value, so build
	// it at runtime via Object.assign (no cast) to exercise the encryption synth
	// guard. A JS caller's typo must not silently downgrade to the AWS-managed key.
	const options: KVStoreOptions = {};
	Object.assign(options, { encryption: 'kms-managed' });
	assert.throws(
		() => new KVStore(parent, 'sessions', options),
		/Unrecognized encryption 'kms-managed'.*'aws-managed', 'customer-managed', or KVStore\.fromKmsKey\(arn\)/,
	);
});

// ── Permissions ─────────────────────────────────────────────────────────────

test('CDK: the execution role can read/write the table and query its indexes', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', { schema: userSchema, key: { partitionKey: 'userId' } });
	const statements = Object.values(Template.fromStack(stack).toJSON().Resources as Record<string, any>)
		.filter((r) => r.Type === 'AWS::IAM::Policy')
		.flatMap((r) => r.Properties.PolicyDocument.Statement as any[]);
	assert.ok(statements.some((s) => [s.Action].flat().includes('dynamodb:PutItem')));
	assert.ok(
		statements.some(
			(s) => [s.Action].flat().includes('dynamodb:Query') && JSON.stringify(s.Resource).includes('/index/*'),
		),
	);
});

// ── Indexes ─────────────────────────────────────────────────────────────────

type CfnResource = { Type: string; Properties?: any; DependsOn?: string[] };

function gsiTemplate(defaults: BlocksDefaults = BlocksPresets.production): Record<string, CfnResource> {
	const { stack, parent } = setup(defaults);
	new KVStore(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: { byEmail: { partitionKey: 'email' }, byCreated: { partitionKey: 'email', sortKey: 'createdAt' } },
	});
	return Template.fromStack(stack).toJSON().Resources;
}

function policyStatementsOf(resources: Record<string, CfnResource>, functionPrefix: string) {
	const [fnId, fn] =
		Object.entries(resources).find(
			([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(functionPrefix),
		) ?? [];
	assert.ok(fn, `function ${functionPrefix} not found`);
	const roleId = fn.Properties.Role['Fn::GetAtt'][0];
	const policies = Object.entries(resources).filter(
		([, r]) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((ref: any) => ref.Ref === roleId),
	);
	return { fnId, fn, policies };
}

test('CDK: indexes provision the GSI custom resource with typed index keys, Version 3', () => {
	const resources = gsiTemplate();
	const custom = Object.values(resources).filter((r) => r.Type === 'AWS::CloudFormation::CustomResource');
	assert.strictEqual(custom.length, 1);
	const { ServiceToken: _token, ...props } = custom[0].Properties;
	assert.deepStrictEqual(Object.keys(props).sort(), ['Indexes', 'SandboxMode', 'TableName', 'Version']);
	assert.strictEqual(props.Version, '3');
	assert.strictEqual(props.SandboxMode, 'false');
	assert.deepStrictEqual(props.Indexes, {
		byEmail: { partitionKey: 'email', partitionKeyType: 'S' },
		byCreated: { partitionKey: 'email', sortKey: 'createdAt', partitionKeyType: 'S', sortKeyType: 'N' },
	});
});

test('CDK: an index on a string store provisions the GSI custom resource too', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', { schema: userSchema, indexes: { byEmail: { partitionKey: 'email' } } });
	Template.fromStack(stack).resourceCountIs('AWS::CloudFormation::CustomResource', 1);
});

test('CDK: GSI manager Lambda log groups adopt defaults.logRetention', () => {
	const resources = gsiTemplate(BlocksPresets.sandbox);
	const groups = Object.values(resources).filter((r) => r.Type === 'AWS::Logs::LogGroup');
	assert.ok(groups.some((g) => g.Properties.RetentionInDays === 7));
});

test('CDK: the GSI provider waiter state machine role trusts Step Functions with aws:SourceAccount and aws:SourceArn', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: { byEmail: { partitionKey: 'email' } },
	});
	const template = Template.fromStack(stack);
	template.hasResourceProperties('AWS::IAM::Role', {
		AssumeRolePolicyDocument: {
			Statement: [
				Match.objectLike({
					Effect: 'Allow',
					Action: 'sts:AssumeRole',
					Principal: { Service: 'states.amazonaws.com' },
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
				}),
			],
		},
	});
});

test('CDK: GSI manager may read its own stack only, from a policy its function depends on', () => {
	const resources = gsiTemplate();
	const { fn, policies } = policyStatementsOf(resources, 'BlocksGsiManager');
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
});

test('CDK: the table name is a literal in the template, as the GSI manager Delete check requires', () => {
	const resources = gsiTemplate();
	const tables = Object.values(resources).filter((r) => r.Type === 'AWS::DynamoDB::Table');
	assert.strictEqual(tables.length, 1);
	assert.strictEqual(tables[0].Properties.TableName, 'TestStack-app-users');
});

test('CDK: a store without indexes gets no GSI provider and no stack-status lookup', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', { schema: userSchema, key: { partitionKey: 'userId', sortKey: 'createdAt' } });
	const json = JSON.stringify(Template.fromStack(stack).toJSON());
	assert.ok(!json.includes('cloudformation:'));
	Template.fromStack(stack).resourceCountIs('AWS::CloudFormation::CustomResource', 0);
});

// ── fromExisting ────────────────────────────────────────────────────────────

test('CDK: KVStore.fromExisting does NOT provision a table or the GSI custom resource', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', {
		schema: userSchema,
		key: { partitionKey: 'userId', sortKey: 'createdAt' },
		indexes: { byEmail: { partitionKey: 'email' } },
		table: KVStore.fromExisting('preexisting-users-table'),
	});
	new KVStore(parent, 'sessions', { table: KVStore.fromExisting('preexisting-sessions') });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 0);
	template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
});

test('CDK: KVStore.fromExisting returns a branded ref', () => {
	const ref = KVStore.fromExisting('foo');
	assert.strictEqual(ref.tableName, 'foo');
	assert.strictEqual(ref.__brand, 'ExternalTableRef');
});

test('CDK: durability options passed alongside fromExisting warn at synth', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions', {
		table: KVStore.fromExisting('preexisting-table-123'),
		protection: 'locked',
		pointInTimeRecovery: { retentionDays: 14 },
		encryption: 'customer-managed',
	});
	Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('wrapped via fromExisting'));
});

// ── Synth guards ────────────────────────────────────────────────────────────

test('CDK: calling a runtime data method throws an actionable error (not a cryptic TypeError)', () => {
	const { parent } = setup();
	const store = new KVStore(parent, 'sessions') as any;
	for (const method of ['get', 'put', 'delete', 'query', 'scan', 'getBatch', 'putBatch', 'deleteBatch']) {
		assert.throws(
			() => store[method]('k'),
			/cannot be called during CDK synth/,
			`${method}() should throw the actionable synth-time error`,
		);
	}
});

// ── migrateFrom ──────────────────────────────────────────────────────

test('CDK: migrateFrom keeps the table of the release under its old logical id, with a stream, and adds the copy and the drain', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'cache-v2', { migrateFrom: { id: 'cache', ttl: true } });
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 2);
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		TableName: 'TestStack-app-cache',
		KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
		AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
		TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
		StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
	});
	template.hasResourceProperties('AWS::DynamoDB::Table', {
		TableName: 'TestStack-app-cache-v2',
		KeySchema: [{ AttributeName: '_bkv_pk', KeyType: 'HASH' }],
	});
	template.resourceCountIs('Custom::BlocksKvMigrateCopy', 1);
	template.resourceCountIs('Custom::BlocksKvMigrateDrain', 1);

	// The old table has the logical id of the table of a store with the old id.
	const release = setup();
	new KVStore(release.parent, 'cache');
	const [oldLogicalId] = Object.keys(Template.fromStack(release.stack).findResources('AWS::DynamoDB::Table'));
	assert.ok(oldLogicalId in template.findResources('AWS::DynamoDB::Table'), oldLogicalId);
});

test('CDK: without migrateFrom a store has no old table and no migration resource', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'cache-v2');
	const template = Template.fromStack(stack);
	template.resourceCountIs('AWS::DynamoDB::Table', 1);
	template.resourceCountIs('Custom::BlocksKvMigrateCopy', 0);
	template.resourceCountIs('Custom::BlocksKvMigrateDrain', 0);
});

test('CDK: migrateFrom restates the options of the old store, and the copy waits for the indexes of the new one', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox);
	new KVStore(parent, 'users-v2', {
		schema: userSchema,
		indexes: { byEmail: { partitionKey: 'email' } },
		migrateFrom: { id: 'users', removalPolicy: 'retain', pointInTimeRecovery: true, drainSeconds: 90 },
	});
	const template = Template.fromStack(stack);
	template.hasResource('AWS::DynamoDB::Table', {
		DeletionPolicy: 'Retain',
		Properties: {
			TableName: 'TestStack-app-users',
			PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
		},
	});
	template.hasResourceProperties('Custom::BlocksKvMigrateDrain', { DrainSeconds: '90', Phase: 'drain' });
	const [copyId] = Object.keys(template.findResources('Custom::BlocksKvMigrateCopy'));
	const copy = template.findResources('Custom::BlocksKvMigrateCopy')[copyId];
	assert.strictEqual(copy.Properties.KeyOptions, JSON.stringify({ indexes: { byEmail: { partitionKey: 'email' } } }));
	const [indexResourceId] = Object.keys(template.findResources('AWS::CloudFormation::CustomResource'));
	assert.ok(copy.DependsOn.includes(indexResourceId), `the copy depends on ${indexResourceId}`);
});

test('CDK: migrateFrom refuses the id of the store itself, a declared key, and a table from fromExisting', () => {
	const { parent } = setup();
	assert.throws(() => new KVStore(parent, 'cache', { migrateFrom: { id: 'cache' } }), /Give this store a new id/);
	const options: Record<string, unknown> = {
		schema: userSchema,
		key: { partitionKey: 'email' },
		migrateFrom: { id: 'old' },
	};
	assert.throws(() => new KVStore(parent, 'keyed', options as never), /cannot declare a key/);
	const wrapped: Record<string, unknown> = { table: KVStore.fromExisting('a-table'), migrateFrom: { id: 'old' } };
	assert.throws(() => new KVStore(parent, 'wrapped', wrapped as never), /cannot wrap a table with fromExisting/);
	assert.throws(
		() => new KVStore(parent, 'slow-v2', { migrateFrom: { id: 'slow', drainSeconds: Number.NaN } }),
		/drainSeconds must be a number from 0 to 900/,
	);
});

test('CDK: migrateFrom gives the copy the ttl field of the new store, and refuses an app that also runs on a container', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'sessions-v2', {
		schema: z.object({ userId: z.string(), expiresAt: z.number() }),
		ttl: 'expiresAt',
		migrateFrom: { id: 'sessions', ttl: true },
	});
	const [copy] = Object.values(Template.fromStack(stack).findResources('Custom::BlocksKvMigrateCopy'));
	assert.strictEqual(copy.Properties.KeyOptions, JSON.stringify({ ttl: 'expiresAt' }));
	Annotations.fromStack(stack).hasNoError('*', Match.anyValue());

	new cdk.aws_ecs.CfnTaskDefinition(stack, 'Task', { taskRoleArn: stack.executionRole.roleArn });
	Annotations.fromStack(stack).hasError(
		'*',
		Match.stringLikeRegexp('migrateFrom cannot move a store of an app that also runs on a container'),
	);
});

test('CDK: every function that runs the app is updated after the copy, and the drain gets its logical id as text', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'cache-v2', { migrateFrom: { id: 'cache' } });
	const template = Template.fromStack(stack);
	const [copyId] = Object.keys(template.findResources('Custom::BlocksKvMigrateCopy'));
	const [drain] = Object.values(template.findResources('Custom::BlocksKvMigrateDrain'));
	// The stub stack has one function with the shared execution role: the app's handler.
	const functions = template.findResources('AWS::Lambda::Function');
	const appIds: string[] = drain.Properties.FunctionLogicalIds;
	assert.strictEqual(appIds.length, 1);
	assert.ok(functions[appIds[0]].DependsOn.includes(copyId), 'the app is updated after the copy');
	assert.ok(
		!(drain.DependsOn ?? []).includes(appIds[0]),
		'the drain starts with the update of the app, not after it',
	);
	// The functions of the migration itself do not wait for the copy.
	for (const [id, fn] of Object.entries(functions)) {
		if (id !== appIds[0]) assert.ok(!(fn.DependsOn ?? []).includes(copyId), id);
	}
});
