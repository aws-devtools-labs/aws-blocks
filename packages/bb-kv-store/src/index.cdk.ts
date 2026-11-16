// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { computeScopeFullId, type ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, DEFAULT_NODE_RUNTIME, isSandboxContext, synthGuard } from '@aws-blocks/core/cdk';
import {
	deployTimeLambdaCode,
	markAddedChildrenBlocksOwned,
	resolveDynamoDbProtection,
	scopeProviderWaiterTrust,
} from '@aws-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Aspects, CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, type ITable, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { CfnTaskDefinition } from 'aws-cdk-lib/aws-ecs';
import { type IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnFunction, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, type RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct, type IConstruct } from 'constructs';
import { checkMigrateFrom, type KeyAttributes, looseOptions, probeKeyType, resolveKeyModel } from './item.js';
import {
	DEFAULT_DRAIN_SECONDS,
	MIGRATE_COPY_RESOURCE_TYPE,
	MIGRATE_DRAIN_RESOURCE_TYPE,
	MIGRATE_PARAMETER_PATH,
	RELEASE_PK,
	RELEASE_TTL,
} from './migrate-names.js';
import type {
	ExternalKmsKeyRef,
	ExternalTableRef,
	IndexConfig,
	KeyConfig,
	KVStoreOptions,
	MigrateFrom,
} from './types.js';
import { BB_NAME } from './version.js';

// Re-export public types and errors (no runtime dependencies)
export { KVStoreErrors } from './errors.js';
export type * from './types.js';

const PROTECTION_VALUES = ['disposable', 'retained', 'locked'] as const;

export class KVStore<
	In = string,
	Out = In,
	K extends KeyConfig<In, Out> | undefined = undefined,
	// biome-ignore lint/complexity/noBannedTypes: `{}` is the empty index map; `keyof {}` is `never`, so a store without indexes accepts no index name
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

		// Read the options through the loosely typed view that the runtime shares:
		// the construct provisions from field names, not from the inferred value types.
		const config = looseOptions(options);
		const migrateFrom = checkMigrateFrom(id, options);

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
		const { schema } = config;

		// Probe the schema's validate() to determine if a key field or an index
		// field is numeric. `probeKeyType` sends the test values 0, 1 and -1 for
		// the field — if validation doesn't flag one of them, the field accepts
		// numbers. Uses only the StandardSchemaV1 interface. A schema that
		// validates asynchronously cannot be probed at synth, and its field counts
		// as numeric, as before. The runtimes call the same function, so they
		// accept exactly the type that this construct provisions.
		const getDdbType = (fieldName: string): AttributeType =>
			probeKeyType(schema, fieldName) === 'N' ? AttributeType.NUMBER : AttributeType.STRING;

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
		const model = resolveKeyModel(options);
		const keyAttribute = (name: string) => ({
			name,
			type: model.declared ? getDdbType(name) : AttributeType.STRING,
		});
		this.table = new Table(this, 'table', {
			tableName,
			partitionKey: keyAttribute(model.table.partitionKey),
			sortKey: model.table.sortKey ? keyAttribute(model.table.sortKey) : undefined,
			billingMode: BillingMode.PAY_PER_REQUEST,
			// TTL is always on: on the named field of the value, or on `_bkv_ttl`.
			// Every read hides an expired item regardless; this lets DynamoDB reap it.
			timeToLiveAttribute: model.ttlAttribute,
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
		let gsiResource: CustomResource | undefined;
		if (indexes && Object.keys(indexes).length > 0) {
			const gsiProvider = getOrCreateGsiProvider(cdk.Stack.of(this), this.defaults.logRetention);
			gsiProvider.addTableArn(this.table.tableArn, isSandbox);

			const indexesWithTypes: Record<string, unknown> = {};
			for (const [indexName, indexConfig] of Object.entries(indexes)) {
				indexesWithTypes[indexName] = {
					partitionKey: indexConfig.partitionKey,
					sortKey: indexConfig.sortKey,
					partitionKeyType: probeKeyType(schema, indexConfig.partitionKey),
					sortKeyType: indexConfig.sortKey ? probeKeyType(schema, indexConfig.sortKey) : undefined,
				};
			}

			gsiResource = new CustomResource(this, 'gsi-resource', {
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

		if (migrateFrom) attachMigration(this, migrateFrom, this.table, { indexes, ttl: config.ttl }, gsiResource);
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

// ── `migrateFrom`: keep the table of an earlier release, copy its items, follow it through the switch ──

const MIGRATE_PROVIDER_KEY = Symbol.for('BLOCKS_KV_MIGRATE_PROVIDER');

interface MigrateProvider {
	serviceToken: string;
	/** The function that does the work (`isComplete` of the provider). The tables grant it access. */
	worker: LambdaFunction;
	/** The apps of the stack by execution role. A stack can hold more than one backend, each with its own role. */
	apps: Map<string, MigrateApp>;
}

interface MigrateApp {
	/** The copy of each store of the app. Every function that runs the app waits for all of them. */
	copies: cdk.CfnResource[];
	/** The logical ids of the functions that run the app. An aspect fills it at synth. */
	functions: string[];
}

/** One provider for every store of the stack that has `migrateFrom`. See `migrate-lambda.ts`. */
function getOrCreateMigrateProvider(stack: cdk.Stack, logRetention: RetentionDays): MigrateProvider {
	const existing = (stack as unknown as Record<symbol, MigrateProvider | undefined>)[MIGRATE_PROVIDER_KEY];
	if (existing) return existing;

	// `dist/migrate-lambda/` (build:lambda) when installed; a vendorized copy
	// (src/ only) bundles src/migrate-lambda.ts at synth instead.
	const migrateCode = () =>
		deployTimeLambdaCode({
			moduleUrl: import.meta.url,
			bundleDir: './migrate-lambda',
			source: './migrate-lambda',
			target: 'node24', // = build:lambda
		});

	// Everything added to the stack below is AWS Blocks' own (marked at the end).
	const stackChildrenBefore = new Set(stack.node.children);

	const onEvent = new LambdaFunction(stack, 'BlocksKvMigrate', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: migrateCode(),
		timeout: Duration.minutes(1),
		logGroup: new LogGroup(stack, 'BlocksKvMigrateLogs', {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});
	// The work is in isComplete: a slice of the copy, or of the drain. The
	// provider calls it again until the phase is done.
	const worker = new LambdaFunction(stack, 'BlocksKvMigrateWorker', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.isCompleteHandler',
		code: migrateCode(),
		timeout: Duration.minutes(15),
		// For the CPU, not for the heap: a slice converts items in eight segments at once.
		memorySize: 2048,
		logGroup: new LogGroup(stack, 'BlocksKvMigrateWorkerLogs', {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});
	// The drain keeps its position in a parameter between two invocations, and
	// removes it when it ends. A Delete of a drain (a rollback) removes it too.
	for (const fn of [onEvent, worker]) {
		fn.addToRolePolicy(
			new PolicyStatement({
				actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
				resources: [
					stack.formatArn({
						service: 'ssm',
						resource: 'parameter',
						resourceName: `${MIGRATE_PARAMETER_PATH.slice(1)}*`,
					}),
				],
			}),
		);
	}
	// The drain reads, from this stack only, whether the app's functions are
	// updated and what else is in progress. Read-only.
	worker.addToRolePolicy(
		new PolicyStatement({
			actions: ['cloudformation:ListStackResources'],
			resources: [stack.stackId],
		}),
	);

	const provider = new Provider(stack, 'BlocksKvMigrateProvider', {
		onEventHandler: onEvent,
		isCompleteHandler: worker,
		queryInterval: Duration.seconds(5),
		// The most that CloudFormation gives a custom resource. The copy of a store, and its drain, each have this long.
		totalTimeout: Duration.hours(1),
	});
	scopeProviderWaiterTrust(provider);

	// The functions and the provider sit at stack scope but belong to the block,
	// so the service-principal trust check treats their roles as AWS Blocks roles.
	markAddedChildrenBlocksOwned(stack, stackChildrenBefore);

	const shared: MigrateProvider = { serviceToken: provider.serviceToken, worker, apps: new Map() };

	// The switch. A function that runs an app has the execution role of that
	// app. It may be constructed after the store, so an aspect finds it. The
	// aspect compares resolved values: the same role gives the same Fn::GetAtt
	// whether the function got the role object or its ARN.
	Aspects.of(stack).add({
		visit(node: IConstruct) {
			if (cdk.Stack.of(node) !== stack) return;
			if (node instanceof CfnFunction) {
				const app = shared.apps.get(JSON.stringify(stack.resolve(node.role)));
				if (!app) return;
				for (const copy of app.copies) node.addResourceDependency(copy);
				const logicalId = stack.getLogicalId(node);
				if (!app.functions.includes(logicalId)) app.functions.push(logicalId);
			} else if (
				node instanceof CfnTaskDefinition &&
				shared.apps.has(JSON.stringify(stack.resolve(node.taskRoleArn)))
			) {
				// Only Lambda functions are ordered after the copy. A container would read and write the new table
				// while the copy runs, and the copy would write over what it wrote.
				Annotations.of(node).addError(
					'KVStore migrateFrom cannot move a store of an app that also runs on a container. ' +
						'The deploy orders only the Lambda functions of the app after the copy, so the container would use the new table during the copy.',
				);
			}
		},
	});

	(stack as unknown as Record<symbol, MigrateProvider>)[MIGRATE_PROVIDER_KEY] = shared;
	return shared;
}

/** The copies and the functions of the app that has this execution role. */
function migrateApp(provider: MigrateProvider, stack: cdk.Stack, executionRole: IRole): MigrateApp {
	const key = JSON.stringify(stack.resolve(executionRole.roleArn));
	let app = provider.apps.get(key);
	if (!app) {
		app = { copies: [], functions: [] };
		provider.apps.set(key, app);
	}
	return app;
}

/**
 * The `migrateFrom` option: keep the table of the store of an earlier release
 * in the stack, copy its items into `newTable`, and order the deploy so that
 * the app switches to `newTable` after the copy.
 *
 * - The old table is declared as release 0.4.0 declares it, under the construct
 *   path that the old store had. The path gives the logical id, so
 *   CloudFormation sees the table that it has. The one change is a stream.
 * - `copy` (a custom resource) copies the items and replays the stream.
 * - Each function that runs the app depends on the copy of every store of the
 *   app: CloudFormation updates it after the copies.
 * - `drain` (a custom resource) starts when `copy` ends and follows the stream
 *   through that update. It gets the logical ids of the functions as text. A
 *   reference would make it wait for them.
 *
 * @param keyOptions - The `indexes` and `ttl` options of the new store: the copy lays each item out as a write of that store does.
 * @param after - What the copy waits for: the index resource of the new table, so that the copy fills the indexes.
 */
function attachMigration(
	store: BuildingBlockScope,
	from: MigrateFrom,
	newTable: ITable,
	keyOptions: { indexes?: Record<string, KeyAttributes>; ttl?: string },
	after: IConstruct | undefined,
): void {
	const stack = cdk.Stack.of(store);
	const legacy = new Construct(store.node.scope as Construct, from.id);
	const removalPolicy =
		from.removalPolicy === 'destroy'
			? RemovalPolicy.DESTROY
			: from.removalPolicy === 'retain'
				? RemovalPolicy.RETAIN
				: store.defaults.removalPolicy;
	const protection = resolveDynamoDbProtection(legacy, from, store.defaults, {
		warningPrefix: '@aws-blocks/bb-kv-store',
		fromKmsKeyHint: 'KVStore.fromKmsKey',
	});
	const oldTable = new Table(legacy, 'table', {
		// The name that the old store had: the full id of a store with its id, under the same parent.
		tableName: computeScopeFullId({ id: from.id, parent: store.parent }).substring(0, 255),
		partitionKey: { name: RELEASE_PK, type: AttributeType.STRING },
		billingMode: BillingMode.PAY_PER_REQUEST,
		removalPolicy,
		deletionProtection: from.deletionProtection ?? store.defaults.deletionProtection,
		timeToLiveAttribute: from.ttl ? RELEASE_TTL : undefined,
		pointInTimeRecoverySpecification: protection.pointInTimeRecoverySpecification,
		encryption: protection.encryption,
		encryptionKey: protection.encryptionKey,
		// The one change to the table: the migration replays its changes.
		stream: StreamViewType.NEW_IMAGE,
	});
	protection.applyKeyRemovalPolicy(oldTable, removalPolicy);
	// The code of the earlier release runs until the functions are updated, so the role keeps its access.
	oldTable.grantReadWriteData(store.executionRole);

	const provider = getOrCreateMigrateProvider(stack, store.defaults.logRetention);
	const app = migrateApp(provider, stack, store.executionRole);
	oldTable.grantReadData(provider.worker);
	oldTable.grantStreamRead(provider.worker);
	newTable.grantReadWriteData(provider.worker);

	const properties = {
		OldTable: oldTable.tableName,
		NewTable: newTable.tableName,
		StreamArn: oldTable.tableStreamArn as string,
		KeyOptions: JSON.stringify(keyOptions),
	};
	const copy = new CustomResource(store, 'migrate-copy', {
		serviceToken: provider.serviceToken,
		resourceType: MIGRATE_COPY_RESOURCE_TYPE,
		properties: { ...properties, Phase: 'copy' },
	});
	copy.node.addDependency(newTable, oldTable);
	// The grants above are policies of the role: the copy must not start before they exist.
	if (provider.worker.role) copy.node.addDependency(provider.worker.role);
	if (after) copy.node.addDependency(after);
	app.copies.push(copy.node.defaultChild as cdk.CfnResource);

	new CustomResource(store, 'migrate-drain', {
		serviceToken: provider.serviceToken,
		resourceType: MIGRATE_DRAIN_RESOURCE_TYPE,
		properties: {
			...properties,
			Phase: 'drain',
			Checkpoints: copy.getAttString('Checkpoints'),
			DrainSeconds: String(from.drainSeconds ?? DEFAULT_DRAIN_SECONDS),
			FunctionLogicalIds: cdk.Lazy.list({ produce: () => app.functions }),
		},
	});
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

	// Everything added to the stack below is AWS Blocks' own (marked at the end).
	const stackChildrenBefore = new Set(stack.node.children);

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
	scopeProviderWaiterTrust(provider);

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

	// The shared GSI-manager functions and provider sit at stack scope but belong
	// to the block, so the service-principal trust check treats their roles as
	// AWS Blocks roles rather than the app's.
	markAddedChildrenBlocksOwned(stack, stackChildrenBefore);

	(stack as unknown as Record<symbol, SharedGsiProvider>)[GSI_PROVIDER_KEY] = shared;
	return shared;
}
