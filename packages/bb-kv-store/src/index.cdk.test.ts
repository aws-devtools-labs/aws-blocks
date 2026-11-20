// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for KVStore: the table's key schema for each form
 * of the store, TTL always on, the durability and encryption knobs, the GSI
 * manager, `fromExisting`, and the synth-time guards.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { type BlocksDefaults, BlocksPresets, DEFAULT_NODE_RUNTIME, Scope } from '@aws-cdk-blocks/core/cdk';
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

function setup(
	defaults: BlocksDefaults = BlocksPresets.production,
	context?: Record<string, string>,
): { stack: StubBlocksStack; parent: Scope } {
	const app = new cdk.App({ context });
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
			Match.stringLikeRegexp(
				'retentionDays must be an integer.*ack: @aws-cdk-blocks/bb-kv-store:InvalidPitrDays',
			),
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

const actionsOf = (statement: any): string[] => [statement.Action].flat();

/** The sandbox stack that `build` fills, with the fast-path statement and the KMS statements of the GSI manager. */
function sandboxStatementsOfGsiManager(build: (parent: Scope) => void) {
	// `sandboxMode` is app context, so it must be set before the stack is built.
	const { stack, parent } = setup(BlocksPresets.sandbox, { sandboxMode: 'true' });
	build(parent);
	const resources: Record<string, CfnResource> = Template.fromStack(stack).toJSON().Resources;
	const { policies } = policyStatementsOf(resources, 'BlocksGsiManager');
	const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[]);
	const fastPath = statements.find((s) => actionsOf(s).includes('dynamodb:CreateTable'));
	const kms = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
	const custom = Object.values(resources).filter((r) => r.Type === 'AWS::CloudFormation::CustomResource');
	return { resources, fastPath, kms, custom };
}

test('CDK: in sandbox, the GSI manager may read and set again the settings of the tables it recreates', () => {
	const { fastPath, kms, custom } = sandboxStatementsOfGsiManager((parent) => {
		new KVStore(parent, 'users', { schema: userSchema, indexes: { byEmail: { partitionKey: 'email' } } });
	});
	assert.strictEqual(custom[0].Properties.SandboxMode, 'true');
	assert.strictEqual(custom[0].Properties.EncryptionKeyArn, undefined, 'no customer key: the AWS-managed key');
	assert.deepStrictEqual(custom[0].Properties.DeclaredSettings, { TimeToLiveAttribute: '_bkv_ttl' });
	assert.ok(fastPath);
	assert.deepStrictEqual(actionsOf(fastPath).sort(), [
		'dynamodb:BatchWriteItem',
		'dynamodb:CreateTable',
		'dynamodb:DeleteTable',
		'dynamodb:DescribeContinuousBackups',
		'dynamodb:DescribeTimeToLive',
		'dynamodb:ListTagsOfResource',
		'dynamodb:Scan',
		'dynamodb:TagResource',
		'dynamodb:UpdateContinuousBackups',
		'dynamodb:UpdateTimeToLive',
	]);
	assert.deepStrictEqual([fastPath.Resource].flat().length, 1, 'only the table of the store');
	assert.ok(JSON.stringify(fastPath.Resource).includes('Arn'));
	assert.deepStrictEqual(kms, []);
});

test('CDK: in sandbox, a customer key is passed to the GSI manager and usable only through DynamoDB', () => {
	const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
	const { kms, custom } = sandboxStatementsOfGsiManager((parent) => {
		const shared = KVStore.fromKmsKey(keyArn);
		new KVStore(parent, 'users', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
			encryption: shared,
		});
		new KVStore(parent, 'events', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
			encryption: shared,
		});
	});
	assert.deepStrictEqual(
		custom.map((c) => c.Properties.EncryptionKeyArn),
		[keyArn, keyArn],
	);
	assert.strictEqual(kms.length, 1);
	assert.deepStrictEqual(actionsOf(kms[0]).sort(), [
		'kms:CreateGrant',
		'kms:Decrypt',
		'kms:DescribeKey',
		'kms:Encrypt',
		'kms:GenerateDataKey*',
		'kms:ReEncrypt*',
	]);
	assert.deepStrictEqual([kms[0].Resource].flat(), [keyArn], 'the shared key once, no other key');
	assert.deepStrictEqual(kms[0].Condition, {
		StringEquals: {
			'kms:ViaService': { 'Fn::Join': ['', ['dynamodb.', { Ref: 'AWS::Region' }, '.amazonaws.com']] },
		},
	});
});

test('CDK: in sandbox, a provisioned customer key is granted by its own ARN', () => {
	const { resources, kms, custom } = sandboxStatementsOfGsiManager((parent) => {
		new KVStore(parent, 'users', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
			encryption: 'customer-managed',
		});
	});
	const [keyId] = Object.entries(resources).find(([, r]) => r.Type === 'AWS::KMS::Key') ?? [];
	assert.ok(keyId);
	const keyRef = { 'Fn::GetAtt': [keyId, 'Arn'] };
	assert.deepStrictEqual(custom[0].Properties.EncryptionKeyArn, keyRef);
	assert.strictEqual(kms.length, 1);
	assert.deepStrictEqual([kms[0].Resource].flat(), [keyRef]);
});

test('CDK: in production, the GSI manager gets no fast-path, settings or KMS permissions, and no key property', () => {
	const { stack, parent } = setup();
	new KVStore(parent, 'users', {
		schema: userSchema,
		indexes: { byEmail: { partitionKey: 'email' } },
		encryption: 'customer-managed',
	});
	const resources: Record<string, CfnResource> = Template.fromStack(stack).toJSON().Resources;
	const { policies } = policyStatementsOf(resources, 'BlocksGsiManager');
	const actions = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement.flatMap(actionsOf));
	for (const a of ['dynamodb:CreateTable', 'dynamodb:UpdateTimeToLive', 'dynamodb:TagResource', 'kms:CreateGrant']) {
		assert.ok(!actions.includes(a), `${a} is sandbox-only`);
	}
	const custom = Object.values(resources).find((r) => r.Type === 'AWS::CloudFormation::CustomResource');
	assert.strictEqual(custom?.Properties.EncryptionKeyArn, undefined);
	assert.strictEqual(custom?.Properties.DeclaredSettings, undefined);
});

// The fast path copies the live table's settings, so a table that lost them
// would stay without them. In sandbox the GSI manager is told what the table
// declares, as strings (CloudFormation makes every property value one).
test('CDK: in sandbox, the GSI manager is told the TTL field and point-in-time recovery that the table declares', () => {
	const { custom } = sandboxStatementsOfGsiManager((parent) => {
		new KVStore(parent, 'sessions', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
			ttl: 'createdAt',
			pointInTimeRecovery: { retentionDays: 7 },
		});
		new KVStore(parent, 'users', {
			schema: userSchema,
			indexes: { byEmail: { partitionKey: 'email' } },
			pointInTimeRecovery: true,
		});
	});
	assert.deepStrictEqual(
		custom.map((c) => c.Properties.DeclaredSettings),
		[
			{ TimeToLiveAttribute: 'createdAt', PointInTimeRecovery: 'true', RecoveryPeriodInDays: '7' },
			{ TimeToLiveAttribute: '_bkv_ttl', PointInTimeRecovery: 'true' },
		],
	);
});

// History: the sandbox fast path creates the table again from what it reads off the live one, and it lost every
// setting it did not read. A new property on the table needs `readTableSettings` (gsi-manager-lambda.ts) to keep
// it, or the fast path to skip that table, before it is added to this list.
test('CDK: every property of a table with indexes is one the sandbox recreate keeps', () => {
	const { stack, parent } = setup(BlocksPresets.sandbox, { sandboxMode: 'true' });
	new KVStore(parent, 'users', {
		schema: userSchema,
		indexes: { byEmail: { partitionKey: 'email' } },
		encryption: 'customer-managed',
		pointInTimeRecovery: true,
		protection: 'locked',
	});
	const resources: Record<string, CfnResource> = Template.fromStack(stack).toJSON().Resources;
	const [table] = Object.values(resources).filter((r) => r.Type === 'AWS::DynamoDB::Table');
	assert.deepStrictEqual(Object.keys(table.Properties).sort(), [
		'AttributeDefinitions',
		'BillingMode',
		'DeletionProtectionEnabled',
		'KeySchema',
		'PointInTimeRecoverySpecification',
		'SSESpecification',
		'TableName',
		'TimeToLiveSpecification',
	]);
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

test('CDK: indexes given as an array fail the synth, with the error of the runtimes', () => {
	const { parent } = setup();
	assert.throws(
		() => new KVStore(parent, 'users', { schema: userSchema, indexes: [{ partitionKey: 'email' }] } as never),
		/InvalidQueryException: indexes must be an object keyed by index name, .*\(received an array\)$/,
	);
});
