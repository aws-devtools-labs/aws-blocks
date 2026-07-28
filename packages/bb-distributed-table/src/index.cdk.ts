// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';
import { Table, type ITable, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { CustomResource, Duration } from 'aws-cdk-lib';
import { Code, Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Scope, synthGuard, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import type { ScopeParent } from '@aws-blocks/core';
import type { ExternalTableRef } from './types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export { DistributedTableErrors } from './errors.js';
export type { DistributedTableOptions, TableKeyConfig, TableKey, PutOptions, DeleteOptions, QueryOptions, ScanOptions, ExternalTableRef } from './types.js';

export class DistributedTable<T = any> extends Scope {
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

	constructor(scope: ScopeParent, id: string, public options: any) {
		super(id, { parent: scope });

		// Register VPC endpoint for DynamoDB access
		this.registerVpcEndpoint(ec2.GatewayVpcEndpointAwsService.DYNAMODB);

		const config = options;

		if (config?.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and grant the runtime Lambda read/write + index query access.
			// We deliberately skip the GSI custom resource — the customer owns the
			// table's index lifecycle when they bring their own.
			this.table = Table.fromTableName(this, 'table', config.table.tableName);
			this.table.grantReadWriteData(this.handler);
			this.handler.addToRolePolicy(new PolicyStatement({
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
		});

		this.table.grantReadWriteData(this.handler);

		// Explicit index query permissions
		this.handler.addToRolePolicy(new PolicyStatement({
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
