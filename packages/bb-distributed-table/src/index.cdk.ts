// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';
import { Table, type ITable, AttributeType, BillingMode, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Annotations, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Key, type IKey } from 'aws-cdk-lib/aws-kms';
import { BuildingBlockScope, synthGuard, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import type { VpcRequirements } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { ExternalTableRef, ExternalKmsKeyRef } from './types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export { DistributedTableErrors } from './errors.js';
export type { DistributedTableOptions, ReadValidationMode, TableKeyConfig, TableKey, PutOptions, DeleteOptions, QueryOptions, ScanOptions, ExternalTableRef, ExternalKmsKeyRef } from './types.js';

export class DistributedTable<T = any> extends BuildingBlockScope {
	private table: ITable;

	/**
	 * Reference an existing DynamoDB table instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts. The customer is responsible for ensuring the
	 * pre-existing table already has any required GSIs configured — Blocks
	 * will not modify the table when this factory is used.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	/**
	 * Reference an existing customer-managed KMS key to encrypt the table,
	 * instead of letting `encryption: 'customer-managed'` provision a dedicated
	 * key per table. Pass the result as the `encryption` option so several
	 * tables can share one key (and one monthly charge).
	 *
	 * @param keyArn - ARN of a KMS key you already own. The deploying principal
	 *   and the DynamoDB service must have the usual grants on it.
	 */
	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	getVpcRequirements(): VpcRequirements {
		return {
			gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB],
		};
	}

	constructor(scope: ScopeParent, id: string, public options: any) {
		super(id, { parent: scope });

		const config = options;

		if (config?.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and grant the runtime Lambda read/write + index query access.
			// We deliberately skip the GSI custom resource — the customer owns the
			// table's index lifecycle when they bring their own.
			//
			// Durability/encryption options don't apply to an existing table (we
			// never emit a `Table` resource to attach them to). Surface that at
			// synth so a `protection: 'locked'` on what looks like a fresh
			// table isn't a silent no-op.
			const ignoredForExisting = (['pointInTimeRecovery', 'protection', 'encryption'] as const)
				.filter((key) => config[key] !== undefined);
			if (ignoredForExisting.length > 0) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-distributed-table:IgnoredOptionsForExistingTable',
					`Ignoring ${ignoredForExisting.join(', ')} because this table is wrapped via fromExisting() — ` +
						`the existing table owns its own durability/encryption configuration.`,
				);
			}
			this.table = Table.fromTableName(this, 'table', config.table.tableName);
			this.table.grantReadWriteData(this.executionRole);
			this.executionRole.addToPrincipalPolicy(new PolicyStatement({
				actions: ['dynamodb:Query'],
				resources: [`${this.table.tableArn}/index/*`],
			}));
			return;
		}

		const tableName = this.fullId.substring(0, 255);
		const isSandbox = this.node.tryGetContext('sandboxMode') === 'true';

		// Probe the schema's validate() to determine if a key field is numeric.
		// Sends a test value of 0 for the field — if validation doesn't flag it,
		// the field accepts numbers. Uses only the StandardSchemaV1 interface.
		const isNumericField = (fieldName: string): boolean => {
			const probe = { [fieldName]: 0 };
			const result = config.schema['~standard'].validate(probe);
			// validate may return sync or async; at synth time schemas are sync
			if (result && 'issues' in result && result.issues) {
				return !result.issues.some(
					(i: any) => i.path?.length === 1 && i.path[0] === fieldName,
				);
			}
			return true; // no issues for this field → numeric
		};

		const getDdbType = (fieldName: string): AttributeType =>
			isNumericField(fieldName) ? AttributeType.NUMBER : AttributeType.STRING;

		// Secure-by-default durability & encryption.
		// The posture — removal policy, deletion protection, PITR — comes from the
		// stack-wide `defaults` (BlocksPresets, #302): production retains + protects
		// + backs up; sandbox is disposable so `sandbox:destroy` stays a one-command
		// teardown and throwaway stacks don't accrue backup cost. Blocks read
		// `this.defaults` rather than the `sandboxMode` context (and rather than the
		// stack-level SandboxDisableDeletionProtection mixin, which can't reach the
		// DynamoDB L2 `deletionProtection` prop — the reason that construct-level
		// mechanism exists). A per-block `protection`/`pointInTimeRecovery`/
		// `encryption` option always wins.
		//
		// `protection` is a single knob (disposable | retained | locked) spanning
		// removal policy + deletion protection, so the contradictory
		// "protect + destroy" state can't be expressed. `options` is typed `any`
		// here, so guard against an unrecognized string (typo) rather than
		// silently falling through to the stack default.
		const PROTECTION_VALUES = ['disposable', 'retained', 'locked'] as const;
		if (config.protection !== undefined && !PROTECTION_VALUES.includes(config.protection)) {
			Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-distributed-table:UnknownProtection',
				`Unrecognized protection '${String(config.protection)}' (expected 'disposable', 'retained', ` +
					`or 'locked') — falling back to the stack defaults.`,
			);
		}
		// `encryption` accepts two string literals or an ExternalKmsKeyRef
		// (a `{ __brand: 'ExternalKmsKeyRef', keyArn }` from `fromKmsKey`).
		// Anything else is a typo — warn rather than silently using the default.
		const isKmsKeyRef = typeof config.encryption === 'object'
			&& config.encryption !== null
			&& config.encryption.__brand === 'ExternalKmsKeyRef';
		if (
			config.encryption !== undefined
			&& config.encryption !== 'aws-managed'
			&& config.encryption !== 'customer-managed'
			&& !isKmsKeyRef
		) {
			Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-distributed-table:UnknownEncryption',
				`Unrecognized encryption '${String(config.encryption)}' (expected 'aws-managed', ` +
					`'customer-managed', or DistributedTable.fromKmsKey(arn)) — falling back to 'aws-managed'.`,
			);
		}

		// PITR is one knob (`boolean | { retentionDays }`) resolved from the
		// per-block option, else the stack-wide `defaults.pointInTimeRecovery`
		// (#302 follow-up) — production on, sandbox off. The object form both
		// enables PITR and pins the window, so "days set but PITR off" can't be
		// expressed. `retentionDays` must be 1–35; warn and drop back to the
		// 35-day default on an out-of-range value rather than failing the deploy.
		const pitrSetting = config.pointInTimeRecovery ?? this.defaults.pointInTimeRecovery;
		let pitrEnabled: boolean;
		let pitrDays: number | undefined;
		if (typeof pitrSetting === 'object' && pitrSetting !== null) {
			pitrEnabled = true;
			pitrDays = pitrSetting.retentionDays;
			if (!Number.isInteger(pitrDays) || (pitrDays as number) < 1 || (pitrDays as number) > 35) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-distributed-table:InvalidPitrDays',
					`pointInTimeRecovery.retentionDays must be an integer between 1 and 35 (got ${String(pitrDays)}) — ` +
						`falling back to the 35-day default.`,
				);
				pitrDays = undefined;
			}
		} else {
			pitrEnabled = pitrSetting === true;
			pitrDays = undefined;
		}
		// Resolve durability into the two CDK properties. The `protection` option
		// is the richer per-block override (#282): when set it fully determines
		// removal policy + deletion protection, and — being one knob — the
		// contradictory "protect + destroy" state can't be expressed. When
		// omitted, fall back to the stack-wide `defaults` (BlocksPresets, #302):
		// production → RETAIN + protected, sandbox → DESTROY + unprotected. Read
		// `deletionProtection` independently from `defaults`, never derived.
		let removalPolicy: RemovalPolicy;
		let deletionProtection: boolean;
		if (PROTECTION_VALUES.includes(config.protection)) {
			deletionProtection = config.protection === 'locked';
			removalPolicy = config.protection === 'disposable' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
		} else {
			removalPolicy = this.defaults.removalPolicy;
			deletionProtection = this.defaults.deletionProtection;
		}
		// `fromKmsKey(arn)` → encrypt with an existing CMK (shareable across
		// tables). `'customer-managed'` → CDK provisions a fresh dedicated CMK.
		// Otherwise the AWS-managed `aws/dynamodb` key.
		let encryptionKey: IKey | undefined;
		let encryption: TableEncryption;
		if (isKmsKeyRef) {
			encryption = TableEncryption.CUSTOMER_MANAGED;
			encryptionKey = Key.fromKeyArn(this, 'encryption-key', config.encryption.keyArn);
		} else if (config.encryption === 'customer-managed') {
			encryption = TableEncryption.CUSTOMER_MANAGED;
		} else {
			encryption = TableEncryption.AWS_MANAGED;
		}

		this.table = new Table(this, 'table', {
			tableName,
			partitionKey: {
				name: config.key.partitionKey,
				type: getDdbType(config.key.partitionKey),
			},
			sortKey: config.key.sortKey ? {
				name: config.key.sortKey,
				type: getDdbType(config.key.sortKey),
			} : undefined,
			billingMode: BillingMode.PAY_PER_REQUEST,
			timeToLiveAttribute: config.ttl || undefined,
			// PITR spec is only emitted when enabled — leaving it undefined keeps
			// the CloudFormation template clean for sandboxes / opt-outs.
			// recoveryPeriodInDays is only set when the caller narrows it (an
			// omitted value keeps DynamoDB's 35-day default without emitting it).
			pointInTimeRecoverySpecification: pitrEnabled
				? {
					pointInTimeRecoveryEnabled: true,
					...(pitrDays !== undefined ? { recoveryPeriodInDays: pitrDays } : {}),
				}
				: undefined,
			// Resolved above from `protection` (per-block override) or the
			// stack-wide `defaults` (#302) — supersedes main's placeholder that
			// read `this.defaults` directly.
			deletionProtection,
			removalPolicy,
			encryption,
			// Only set when bringing an existing CMK; `CUSTOMER_MANAGED` without a
			// key lets CDK provision a dedicated one.
			encryptionKey,
		});

		this.table.grantReadWriteData(this.executionRole);

		// Explicit index query permissions
		this.executionRole.addToPrincipalPolicy(new PolicyStatement({
			actions: ['dynamodb:Query'],
			resources: [`${this.table.tableArn}/index/*`],
		}));

		// Add GSI manager if indexes are defined
		if (config.indexes && Object.keys(config.indexes).length > 0) {
			const gsiProvider = getOrCreateGsiProvider(cdk.Stack.of(this));
			gsiProvider.addTableArn(this.table.tableArn, isSandbox);

			const indexesWithTypes: Record<string, any> = {};
			for (const [indexName, indexConfig] of Object.entries(config.indexes) as [string, any][]) {
				indexesWithTypes[indexName] = {
					partitionKey: indexConfig.partitionKey,
					sortKey: indexConfig.sortKey,
					partitionKeyType: getDdbType(indexConfig.partitionKey) === AttributeType.NUMBER ? 'N' : 'S',
					sortKeyType: indexConfig.sortKey
						? (getDdbType(indexConfig.sortKey) === AttributeType.NUMBER ? 'N' : 'S')
						: undefined,
				};
			}

			const gsiResource = new CustomResource(this, 'gsi-resource', {
				serviceToken: gsiProvider.serviceToken,
				properties: {
					TableName: this.table.tableName,
					Indexes: indexesWithTypes,
					SandboxMode: isSandbox ? 'true' : 'false',
					Version: '3',
				},
			});

			gsiResource.node.addDependency(this.table);
		}
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a DistributedTable resolves to this construct,
	// which only provisions infrastructure. The data methods live in the runtime
	// build; calling them at module top-level (which runs during synth) would
	// otherwise fail with a cryptic `X is not a function`. These stubs turn that
	// into an actionable message.
	get(..._args: unknown[]): never { return synthGuard('DistributedTable', 'get'); }
	put(..._args: unknown[]): never { return synthGuard('DistributedTable', 'put'); }
	delete(..._args: unknown[]): never { return synthGuard('DistributedTable', 'delete'); }
	query(..._args: unknown[]): never { return synthGuard('DistributedTable', 'query'); }
	scan(..._args: unknown[]): never { return synthGuard('DistributedTable', 'scan'); }
	getBatch(..._args: unknown[]): never { return synthGuard('DistributedTable', 'getBatch'); }
	putBatch(..._args: unknown[]): never { return synthGuard('DistributedTable', 'putBatch'); }
	deleteBatch(..._args: unknown[]): never { return synthGuard('DistributedTable', 'deleteBatch'); }
}

// ── Shared GSI Manager Provider (one per stack) ─────────────────────────────

const GSI_PROVIDER_KEY = Symbol.for('BLOCKS_GSI_MANAGER_PROVIDER');

interface SharedGsiProvider {
	serviceToken: string;
	addTableArn: (tableArn: string, isSandbox: boolean) => void;
}

function getOrCreateGsiProvider(stack: cdk.Stack): SharedGsiProvider {
	const existing = (stack as any)[GSI_PROVIDER_KEY] as SharedGsiProvider | undefined;
	if (existing) return existing;

	const __dirname = dirname(fileURLToPath(import.meta.url));

	const tableArns: string[] = [];
	const sandboxTableArns: string[] = [];

	const gsiManagerLambda = new LambdaFunction(stack, 'BlocksGsiManager', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: Code.fromAsset(join(__dirname, 'gsi-manager-lambda')),
		timeout: Duration.minutes(15),
	});

	const gsiIsCompleteLambda = new LambdaFunction(stack, 'BlocksGsiIsComplete', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.isCompleteHandler',
		code: Code.fromAsset(join(__dirname, 'gsi-manager-lambda')),
		timeout: Duration.minutes(1),
	});

	// Production permissions — lazily resolved so ARNs accumulate as tables register
	gsiManagerLambda.addToRolePolicy(new PolicyStatement({
		actions: ['dynamodb:DescribeTable', 'dynamodb:UpdateTable'],
		resources: cdk.Lazy.list({ produce: () => tableArns }),
	}));

	gsiIsCompleteLambda.addToRolePolicy(new PolicyStatement({
		actions: ['dynamodb:DescribeTable', 'dynamodb:UpdateTable'],
		resources: cdk.Lazy.list({ produce: () => tableArns }),
	}));

	// Sandbox permissions — only added if any table requests sandbox mode
	let sandboxPolicyAdded = false;

	const provider = new Provider(stack, 'BlocksGsiProvider', {
		onEventHandler: gsiManagerLambda,
		isCompleteHandler: gsiIsCompleteLambda,
		queryInterval: Duration.seconds(10),
		totalTimeout: Duration.hours(2),
	});

	const shared: SharedGsiProvider = {
		serviceToken: provider.serviceToken,
		addTableArn: (tableArn: string, isSandbox: boolean) => {
			tableArns.push(tableArn);
			if (isSandbox) {
				sandboxTableArns.push(tableArn);
				if (!sandboxPolicyAdded) {
					sandboxPolicyAdded = true;
					gsiManagerLambda.addToRolePolicy(new PolicyStatement({
						actions: [
							'dynamodb:DeleteTable',
							'dynamodb:CreateTable',
							'dynamodb:Scan',
							'dynamodb:BatchWriteItem',
						],
						resources: cdk.Lazy.list({ produce: () => sandboxTableArns }),
					}));
				}
			}
		},
	};

	(stack as any)[GSI_PROVIDER_KEY] = shared;
	return shared;
}
