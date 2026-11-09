// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct unit tests for the shared DynamoDB protection resolver. bb-kv-store and
 * bb-distributed-table both delegate to it, and their CDK suites exercise it
 * transitively — but this helper is now the single owner of the logic, so it is
 * tested here at the layer that owns it: a future edit to a branch regresses a
 * test in THIS file rather than depending on a downstream suite still covering it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { Table, type ITable, AttributeType, BillingMode, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { BlocksPresets, type BlocksDefaults } from './blocks-defaults.js';
import { type DynamoDbProtectionOptions, type ExternalKmsKeyRef, resolveDynamoDbProtection } from './dynamodb-protection.js';

const IDENTITY = { warningPrefix: '@aws-blocks/bb-test', fromKmsKeyHint: 'TestBlock.fromKmsKey' } as const;
const HINT = IDENTITY.fromKmsKeyHint;
const PREFIX = IDENTITY.warningPrefix;

/** Resolve under a throwaway scope so warnings land on a readable stack. */
function resolve(
	options: DynamoDbProtectionOptions | undefined,
	defaults: BlocksDefaults = BlocksPresets.production,
): { stack: cdk.Stack; scope: Construct; result: ReturnType<typeof resolveDynamoDbProtection> } {
	const stack = new cdk.Stack(new cdk.App(), 'TestStack');
	const scope = new Construct(stack, 'scope');
	const result = resolveDynamoDbProtection(scope, options, defaults, IDENTITY);
	return { stack, scope, result };
}

describe('resolveDynamoDbProtection — encryption', () => {
	test('undefined → AWS_MANAGED, no key, no warning', () => {
		const { stack, result } = resolve(undefined);
		assert.strictEqual(result.encryption, TableEncryption.AWS_MANAGED);
		assert.strictEqual(result.encryptionKey, undefined);
		Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('Unrecognized encryption'));
	});

	test("'aws-managed' → AWS_MANAGED, no key", () => {
		const { result } = resolve({ encryption: 'aws-managed' });
		assert.strictEqual(result.encryption, TableEncryption.AWS_MANAGED);
		assert.strictEqual(result.encryptionKey, undefined);
	});

	test("'customer-managed' → CUSTOMER_MANAGED, no imported key (CDK mints one)", () => {
		const { result } = resolve({ encryption: 'customer-managed' });
		assert.strictEqual(result.encryption, TableEncryption.CUSTOMER_MANAGED);
		assert.strictEqual(result.encryptionKey, undefined);
	});

	test('fromKmsKey ref → CUSTOMER_MANAGED with an imported key', () => {
		const ref: ExternalKmsKeyRef = {
			__brand: 'ExternalKmsKeyRef',
			keyArn: 'arn:aws:kms:us-east-1:111122223333:key/abc',
		};
		const { result } = resolve({ encryption: ref });
		assert.strictEqual(result.encryption, TableEncryption.CUSTOMER_MANAGED);
		assert.ok(result.encryptionKey, 'an imported key is resolved');
		// Pin the logical ID: two Key.fromKeyArn under one scope would collide.
		assert.strictEqual(result.encryptionKey?.node.path, 'TestStack/scope/encryption-key');
	});

	test('an unrecognized string warns and falls back to AWS_MANAGED', () => {
		const { stack, result } = resolve({ encryption: 'bogus' as unknown as 'aws-managed' });
		assert.strictEqual(result.encryption, TableEncryption.AWS_MANAGED);
		// Assert the annotation ID, not just the message — the "same warnings"
		// guarantee rides on the exact `${warningPrefix}:UnknownEncryption` id,
		// which addWarningV2 surfaces as a `[ack: <id>]` suffix.
		Annotations.fromStack(stack).hasWarning(
			'*',
			Match.stringLikeRegexp(`Unrecognized encryption 'bogus'.*${HINT}.*ack: ${PREFIX}:UnknownEncryption`),
		);
	});

	test('a non-branded object warns (isKmsKeyRef discriminant rejects it)', () => {
		const { stack, result } = resolve({ encryption: { keyArn: 'x' } as unknown as ExternalKmsKeyRef });
		assert.strictEqual(result.encryption, TableEncryption.AWS_MANAGED);
		Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp(`ack: ${PREFIX}:UnknownEncryption`));
	});
});

describe('resolveDynamoDbProtection — point-in-time recovery', () => {
	test('production default → PITR enabled, no pinned window', () => {
		const { result } = resolve(undefined, BlocksPresets.production);
		assert.deepStrictEqual(result.pointInTimeRecoverySpecification, {
			pointInTimeRecoveryEnabled: true,
		});
	});

	test('sandbox default → PITR off (spec undefined)', () => {
		const { result } = resolve(undefined, BlocksPresets.sandbox);
		assert.strictEqual(result.pointInTimeRecoverySpecification, undefined);
	});

	test('pointInTimeRecovery: false overrides a production default', () => {
		const { result } = resolve({ pointInTimeRecovery: false }, BlocksPresets.production);
		assert.strictEqual(result.pointInTimeRecoverySpecification, undefined);
	});

	test('{ retentionDays } enables PITR and pins the window', () => {
		const { result } = resolve({ pointInTimeRecovery: { retentionDays: 7 } }, BlocksPresets.sandbox);
		assert.deepStrictEqual(result.pointInTimeRecoverySpecification, {
			pointInTimeRecoveryEnabled: true,
			recoveryPeriodInDays: 7,
		});
	});

	for (const bad of [0, 36, 7.5]) {
		test(`retentionDays ${bad} is rejected — warns, drops the window, PITR stays on`, () => {
			const { stack, result } = resolve({ pointInTimeRecovery: { retentionDays: bad } });
			assert.deepStrictEqual(result.pointInTimeRecoverySpecification, {
				pointInTimeRecoveryEnabled: true,
			});
			Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp(`retentionDays must be an integer.*ack: ${PREFIX}:InvalidPitrDays`));
		});
	}

	for (const ok of [1, 35]) {
		test(`retentionDays ${ok} is accepted at the boundary`, () => {
			const { stack, result } = resolve({ pointInTimeRecovery: { retentionDays: ok } });
			assert.deepStrictEqual(result.pointInTimeRecoverySpecification, {
				pointInTimeRecoveryEnabled: true,
				recoveryPeriodInDays: ok,
			});
			Annotations.fromStack(stack).hasNoWarning('*', Match.stringLikeRegexp('retentionDays must be an integer'));
		});
	}
});

describe('resolveDynamoDbProtection — applyKeyRemovalPolicy', () => {
	// Build a real table so the minted CMK's DeletionPolicy is observable.
	function tableWith(options: DynamoDbProtectionOptions | undefined, removalPolicy: RemovalPolicy): Template {
		const stack = new cdk.Stack(new cdk.App(), 'TableStack');
		const result = resolveDynamoDbProtection(stack, options, BlocksPresets.production, IDENTITY);
		const table: ITable = new Table(stack, 'table', {
			partitionKey: { name: 'pk', type: AttributeType.STRING },
			billingMode: BillingMode.PAY_PER_REQUEST,
			removalPolicy,
			encryption: result.encryption,
			encryptionKey: result.encryptionKey,
		});
		result.applyKeyRemovalPolicy(table, removalPolicy);
		return Template.fromStack(stack);
	}

	test('an auto-created CMK takes the table removal policy — DESTROY', () => {
		const template = tableWith({ encryption: 'customer-managed' }, RemovalPolicy.DESTROY);
		template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Delete' });
	});

	test('an auto-created CMK takes the table removal policy — RETAIN', () => {
		const template = tableWith({ encryption: 'customer-managed' }, RemovalPolicy.RETAIN);
		template.hasResource('AWS::KMS::Key', { DeletionPolicy: 'Retain' });
	});

	test('no CMK is minted for aws-managed encryption', () => {
		const template = tableWith(undefined, RemovalPolicy.DESTROY);
		template.resourceCountIs('AWS::KMS::Key', 0);
	});

	test('an imported fromKmsKey is left untouched — zero KMS keys provisioned', () => {
		const ref: ExternalKmsKeyRef = {
			__brand: 'ExternalKmsKeyRef',
			keyArn: 'arn:aws:kms:us-east-1:111122223333:key/abc',
		};
		const template = tableWith({ encryption: ref }, RemovalPolicy.DESTROY);
		template.resourceCountIs('AWS::KMS::Key', 0);
	});

	// Pin the `encryption === CUSTOMER_MANAGED && !encryptionKey` guard directly,
	// independent of the KMS resource count, by spying on a table whose key
	// records every applyRemovalPolicy call.
	function spyTable(): { table: ITable; calls: RemovalPolicy[] } {
		const calls: RemovalPolicy[] = [];
		const table = {
			encryptionKey: { applyRemovalPolicy: (p: RemovalPolicy) => calls.push(p) },
		} as unknown as ITable;
		return { table, calls };
	}

	test('guard fires for an auto-created CMK — the key adopts the table policy', () => {
		const stack = new cdk.Stack(new cdk.App(), 'GuardStack');
		const result = resolveDynamoDbProtection(stack, { encryption: 'customer-managed' }, BlocksPresets.production, IDENTITY);
		const { table, calls } = spyTable();
		result.applyKeyRemovalPolicy(table, RemovalPolicy.DESTROY);
		assert.deepStrictEqual(calls, [RemovalPolicy.DESTROY]);
	});

	test('guard is a no-op for an imported fromKmsKey — applyRemovalPolicy is never called', () => {
		const ref: ExternalKmsKeyRef = {
			__brand: 'ExternalKmsKeyRef',
			keyArn: 'arn:aws:kms:us-east-1:111122223333:key/abc',
		};
		const stack = new cdk.Stack(new cdk.App(), 'GuardStack');
		const result = resolveDynamoDbProtection(stack, { encryption: ref }, BlocksPresets.production, IDENTITY);
		const { table, calls } = spyTable();
		result.applyKeyRemovalPolicy(table, RemovalPolicy.DESTROY);
		assert.deepStrictEqual(calls, [], 'an imported key is owned by the caller and left untouched');
	});

	test('guard is a no-op for aws-managed encryption', () => {
		const stack = new cdk.Stack(new cdk.App(), 'GuardStack');
		const result = resolveDynamoDbProtection(stack, undefined, BlocksPresets.production, IDENTITY);
		const { table, calls } = spyTable();
		result.applyKeyRemovalPolicy(table, RemovalPolicy.DESTROY);
		assert.deepStrictEqual(calls, []);
	});
});
