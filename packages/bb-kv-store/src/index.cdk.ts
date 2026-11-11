// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, DEFAULT_NODE_RUNTIME, isSandboxContext, synthGuard } from '@aws-blocks/core/cdk';
import { deployTimeLambdaCode, resolveDynamoDbProtection } from '@aws-blocks/core/cdk/internal';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as cdk from 'aws-cdk-lib';
import { Annotations, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, type ITable, Table } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { PK_ATTRIBUTE, TTL_ATTRIBUTE } from './ttl.js';
import type {
	ExternalKmsKeyRef,
	ExternalTableRef,
	IndexConfig,
	KeyConfig,
	KVStoreOptions,
	SchemaOptions,
} from './types.js';
import { BB_NAME } from './version.js';

// Re-export public types and errors (no runtime dependencies)
export { KVStoreErrors } from './errors.js';
export type {
	AtLeastOne,
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	DeleteOptions,
	Entry,
	Expiry,
	ExternalKmsKeyRef,
	ExternalTableRef,
	FieldsOf,
	GetOptions,
	IndexConfig,
	IndexField,
	IsRecord,
	KeyConfig,
	KeyField,
	KeyOf,
	KVStoreOptions,
	NumberField,
	OneOf,
	OtherPart,
	Page,
	PartitionCondition,
	PutBatchEntry,
	PutOptions,
	QueryOptions,
	ReadValidationMode,
	RecordPart,
	Results,
	ScanOptions,
	SchemaOptions,
	SortCondition,
	TableOptions,
	ValueCheck,
	ValueOf,
	Where,
} from './types.js';

const PROTECTION_VALUES = ['disposable', 'retained', 'locked'] as const;

export class KVStore<
	In = string,
	Out = In,
	K extends KeyConfig<In, Out> | undefined = undefined,
	I extends Record<string, IndexConfig<In, Out>> = {},
> extends BuildingBlockScope {
	private table: ITable;

	/**
	 * Reference an existing DynamoDB table instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts. The customer is responsible for ensuring the
	 * pre-existing table already has the key schema the `key` option names and
	 * any required indexes — Blocks will not modify the table when this factory
	 * is used.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	/**
	 * Reference an existing customer-managed KMS key to encrypt the table,
	 * instead of letting `encryption: 'customer-managed'` provision a dedicated
	 * key per table. Pass the result as the `encryption` option so several
	 * stores can share one key (and one monthly charge).
	 *
	 * @param keyArn - ARN of a KMS key you already own. Because this is an
	 *   imported key, Blocks can only attach IAM-side grants to this stack's
	 *   execution role; it cannot edit the key's own key policy. For the table
	 *   to read and write through the key, that key policy must already allow
	 *   this stack's execution role — either by naming it directly or by
	 *   delegating to account IAM (a statement granting `kms:*` to the account
	 *   root). The key must also live in the same account and region as the
	 *   table. A key policy that does neither surfaces only as an AccessDenied
	 *   when the table is first used at runtime, with no signal at deploy time.
	 */
	static fromKmsKey(keyArn: string): ExternalKmsKeyRef {
		return { __brand: 'ExternalKmsKeyRef' as const, keyArn };
	}

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<In, Out, K, I>) {
		super(id, {
			parent: scope,
			bbName: BB_NAME,
			vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] },
		});

		// Read the schema-bound options through one loosely typed view: the
		// construct provisions from field names, not from the inferred value types.
		const config = (options ?? {}) as Partial<
			SchemaOptions<unknown, unknown, KeyConfigLike, Record<string, KeyConfigLike>>
		> &
			Omit<KVStoreOptions, 'schema' | 'key' | 'indexes' | 'ttl' | 'readValidation'>;

		if (config.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and grant the runtime Lambda read/write + index query access. We
			// deliberately skip the GSI custom resource — the customer owns the
			// table's index lifecycle (and its TTL setting) when they bring their own.
			//
			// Durability/encryption options don't apply to an existing table (we
			// never emit a `Table` resource to attach them to). Surface that at synth
			// so a `protection: 'locked'` on what looks like a fresh table isn't a
			// silent no-op.
			const ignoredForExisting = (['pointInTimeRecovery', 'protection', 'encryption'] as const).filter(
				(key) => config[key] !== undefined,
			);
			if (ignoredForExisting.length > 0) {
				Annotations.of(this).addWarningV2(
					'@aws-blocks/bb-kv-store:IgnoredOptionsForExistingTable',
					`Ignoring ${ignoredForExisting.join(', ')} because this table is wrapped via fromExisting() — ` +
						`the existing table owns its own durability/encryption configuration.`,
				);
			}
			this.table = Table.fromTableName(this, 'table', config.table.tableName);
			this.table.grantReadWriteData(this.executionRole);
			this.executionRole.addToPrincipalPolicy(
				new PolicyStatement({
					actions: ['dynamodb:Query'],
					resources: [`${this.table.tableArn}/index/*`],
				}),
			);
			return;
		}

		const tableName = this.fullId.substring(0, 255);
		const isSandbox = isSandboxContext(this);
		const schema = config.schema as StandardSchemaV1 | undefined;

		// Probe the schema's validate() to determine if a key field is numeric.
		// Sends a test value of 0 for the field — if validation doesn't flag it,
		// the field accepts numbers. Uses only the StandardSchemaV1 interface.
		const isNumericField = (fieldName: string): boolean => {
			if (!schema) return false;
			const probe = { [fieldName]: 0 };
			const result = schema['~standard'].validate(probe);
			// validate may return sync or async; at synth time schemas are sync
			if (result && 'issues' in result && result.issues) {
				return !result.issues.some((i) => i.path?.length === 1 && pathSegment(i.path[0]) === fieldName);
			}
			return true; // no issues for this field → numeric
		};

		const getDdbType = (fieldName: string): AttributeType =>
			isNumericField(fieldName) ? AttributeType.NUMBER : AttributeType.STRING;

		// Secure-by-default durability & encryption.
		// The posture — removal policy, deletion protection, PITR — comes from the
		// stack-wide `defaults` (BlocksPresets, #302): production retains + protects
		// + backs up; sandbox is disposable so `sandbox:destroy` stays a one-command
		// teardown and throwaway stacks don't accrue backup cost. A per-block
		// `protection`/`pointInTimeRecovery`/`encryption` option always wins.
		//
		// `protection` is a single knob (disposable | retained | locked) spanning
		// removal policy + deletion protection, so the contradictory
		// "protect + destroy" state can't be expressed. Guard against an
		// unrecognized string (a typo through JavaScript) rather than silently
		// falling through to the stack default.
		const protectionValue = config.protection as string | undefined;
		if (protectionValue !== undefined && !(PROTECTION_VALUES as readonly string[]).includes(protectionValue)) {
			Annotations.of(this).addWarningV2(
				'@aws-blocks/bb-kv-store:UnknownProtection',
				`Unrecognized protection '${String(protectionValue)}' (expected 'disposable', 'retained', ` +
					`or 'locked') — falling back to the stack defaults.`,
			);
		}

		// PITR + encryption resolve through the one helper in
		// @aws-blocks/core/cdk/internal shared by every Blocks-provisioned
		// DynamoDB table, so blocks can't drift.
		const protection = resolveDynamoDbProtection(this, config, this.defaults, {
			warningPrefix: '@aws-blocks/bb-kv-store',
			fromKmsKeyHint: 'KVStore.fromKmsKey',
		});

		// Resolve durability into the two CDK properties. The `protection` option
		// is the per-block override: when set it fully determines removal policy +
		// deletion protection. When omitted, fall back to the stack-wide
		// `defaults` (BlocksPresets, #302): production → RETAIN + protected,
		// sandbox → DESTROY + unprotected. Read `deletionProtection` independently
		// from `defaults`, never derived.
		let removalPolicy: RemovalPolicy;
		let deletionProtection: boolean;
		if (protectionValue !== undefined && (PROTECTION_VALUES as readonly string[]).includes(protectionValue)) {
			deletionProtection = protectionValue === 'locked';
			removalPolicy = protectionValue === 'disposable' ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
		} else {
			removalPolicy = this.defaults.removalPolicy;
			deletionProtection = this.defaults.deletionProtection;
		}

		// The key schema: the declared key fields, or the block's own `_bkv_pk`
		// string attribute. A store fixes its key when it creates its table.
		const key = config.key;
		this.table = new Table(this, 'table', {
			tableName,
			partitionKey: key
				? { name: key.partitionKey, type: getDdbType(key.partitionKey) }
				: { name: PK_ATTRIBUTE, type: AttributeType.STRING },
			sortKey: key?.sortKey ? { name: key.sortKey, type: getDdbType(key.sortKey) } : undefined,
			billingMode: BillingMode.PAY_PER_REQUEST,
			// TTL is always on: on the named field of the value, or on `_bkv_ttl`.
			// Every read hides an expired item regardless; this lets DynamoDB reap it.
			timeToLiveAttribute: config.ttl ?? TTL_ATTRIBUTE,
			pointInTimeRecoverySpecification: protection.pointInTimeRecoverySpecification,
			deletionProtection,
			removalPolicy,
			encryption: protection.encryption,
			// Only set when bringing an existing CMK; `CUSTOMER_MANAGED` without a
			// key lets CDK provision a dedicated one.
			encryptionKey: protection.encryptionKey,
		});

		// Align an auto-created CMK's removal policy with the table's so the key
		// is never less durable than the table it encrypts.
		//
		// Tradeoff when PITR is on (production + `protection: 'disposable'`, or
		// sandbox + `pointInTimeRecovery: true`): CloudFormation keeps DynamoDB's
		// system backup for 35 days and any on-demand/AWS Backup copies outlive
		// the table, all encrypted under this CMK. A DESTROY key goes into
		// `PendingDeletion` in the same stack delete, so those backups can't be
		// restored once the 30-day KMS window elapses. This is intentional — a
		// `disposable` table opts out of durable backups by definition. See
		// DESIGN.md.
		protection.applyKeyRemovalPolicy(this.table, removalPolicy);

		this.table.grantReadWriteData(this.executionRole);

		// Explicit index query permissions
		this.executionRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['dynamodb:Query'],
				resources: [`${this.table.tableArn}/index/*`],
			}),
		);

		// Add GSI manager if indexes are defined
		const indexes = config.indexes;
		if (indexes && Object.keys(indexes).length > 0) {
			const gsiProvider = getOrCreateGsiProvider(cdk.Stack.of(this), this.defaults.logRetention);
			gsiProvider.addTableArn(this.table.tableArn, isSandbox);

			const indexesWithTypes: Record<string, unknown> = {};
			for (const [indexName, indexConfig] of Object.entries(indexes)) {
				indexesWithTypes[indexName] = {
					partitionKey: indexConfig.partitionKey,
					sortKey: indexConfig.sortKey,
					partitionKeyType: getDdbType(indexConfig.partitionKey) === AttributeType.NUMBER ? 'N' : 'S',
					sortKeyType: indexConfig.sortKey
						? getDdbType(indexConfig.sortKey) === AttributeType.NUMBER
							? 'N'
							: 'S'
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
	// Under `--conditions=cdk` a KVStore resolves to this construct, which only
	// provisions infrastructure. The data methods live in the runtime build.
	// Calling them at module top-level (which runs during synth) would otherwise
	// fail with a cryptic `X is not a function`; these stubs turn that into an
	// actionable message.
	get(..._args: unknown[]): never {
		return synthGuard('KVStore', 'get');
	}
	put(..._args: unknown[]): never {
		return synthGuard('KVStore', 'put');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('KVStore', 'delete');
	}
	query(..._args: unknown[]): never {
		return synthGuard('KVStore', 'query');
	}
	scan(..._args: unknown[]): never {
		return synthGuard('KVStore', 'scan');
	}
	getBatch(..._args: unknown[]): never {
		return synthGuard('KVStore', 'getBatch');
	}
	putBatch(..._args: unknown[]): never {
		return synthGuard('KVStore', 'putBatch');
	}
	deleteBatch(..._args: unknown[]): never {
		return synthGuard('KVStore', 'deleteBatch');
	}
}

/** The loosely typed key config the construct reads field names from. */
interface KeyConfigLike {
	partitionKey: string;
	sortKey?: string;
}

/** A StandardSchemaV1 issue path segment: a key, or an object with a `key`. */
function pathSegment(segment: unknown): unknown {
	return typeof segment === 'object' && segment !== null && 'key' in segment
		? (segment as { key: unknown }).key
		: segment;
}

// ── Shared GSI Manager Provider (one per stack) ─────────────────────────────

const GSI_PROVIDER_KEY = Symbol.for('BLOCKS_GSI_MANAGER_PROVIDER');

interface SharedGsiProvider {
	serviceToken: string;
	addTableArn: (tableArn: string, isSandbox: boolean) => void;
}

function getOrCreateGsiProvider(stack: cdk.Stack, logRetention: RetentionDays): SharedGsiProvider {
	const existing = (stack as unknown as Record<symbol, SharedGsiProvider | undefined>)[GSI_PROVIDER_KEY];
	if (existing) return existing;

	// `dist/gsi-manager-lambda/` (build:lambda) when installed; a vendorized copy
	// (src/ only) bundles src/gsi-manager-lambda.ts at synth instead.
	const gsiManagerCode = () =>
		deployTimeLambdaCode({
			moduleUrl: import.meta.url,
			bundleDir: './gsi-manager-lambda',
			source: './gsi-manager-lambda',
			target: 'node24', // = build:lambda
		});

	const tableArns: string[] = [];
	const sandboxTableArns: string[] = [];

	// Own the GSI-manager Lambdas' log groups so their retention follows the
	// stack-wide default instead of AWS's infinite retention. Torn down with the
	// stack (logs are not durable state).
	const gsiManagerLambda = new LambdaFunction(stack, 'BlocksGsiManager', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: gsiManagerCode(),
		timeout: Duration.minutes(15),
		logGroup: new LogGroup(stack, 'BlocksGsiManagerLogs', {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});

	const gsiIsCompleteLambda = new LambdaFunction(stack, 'BlocksGsiIsComplete', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.isCompleteHandler',
		code: gsiManagerCode(),
		timeout: Duration.minutes(1),
		logGroup: new LogGroup(stack, 'BlocksGsiIsCompleteLogs', {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});

	// Production permissions — lazily resolved so ARNs accumulate as tables register
	gsiManagerLambda.addToRolePolicy(
		new PolicyStatement({
			actions: ['dynamodb:DescribeTable', 'dynamodb:UpdateTable'],
			resources: cdk.Lazy.list({ produce: () => tableArns }),
		}),
	);

	// On Delete, onEvent reads its own stack's status and template to tell a
	// table leaving the stack (keep the indexes: the table is retained in
	// production) from `indexes` being removed in an update (drop them).
	// Read-only, this stack only. Added to the role's default policy, which the
	// function DependsOn, so a stack delete cannot remove it before the custom
	// resource's Delete runs (`addToRolePolicy` would emit a separate, unordered
	// policy here because the statements above use a Lazy resource list).
	gsiManagerLambda.role?.addToPrincipalPolicy(
		new PolicyStatement({
			actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
			resources: [stack.stackId],
		}),
	);

	gsiIsCompleteLambda.addToRolePolicy(
		new PolicyStatement({
			actions: ['dynamodb:DescribeTable', 'dynamodb:UpdateTable'],
			resources: cdk.Lazy.list({ produce: () => tableArns }),
		}),
	);

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
					gsiManagerLambda.addToRolePolicy(
						new PolicyStatement({
							actions: [
								'dynamodb:DeleteTable',
								'dynamodb:CreateTable',
								'dynamodb:Scan',
								'dynamodb:BatchWriteItem',
							],
							resources: cdk.Lazy.list({ produce: () => sandboxTableArns }),
						}),
					);
				}
			}
		},
	};

	(stack as unknown as Record<symbol, SharedGsiProvider>)[GSI_PROVIDER_KEY] = shared;
	return shared;
}
