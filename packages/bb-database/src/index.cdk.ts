// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { relative } from 'node:path';
/**
 * CDK infrastructure entry point (`cdk synth --conditions=cdk`).
 *
 * A `DatabaseCluster` provisions Aurora DSQL or Aurora Serverless v2 plus one
 * migration Lambda. A `Database` either owns a `distributed` cluster or attaches
 * to a shared one, adding the CustomResource that creates its schema and runs
 * its migrations at deploy time. Both record their binding in stack metadata
 * for the deploy guard.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, getVpcContext, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import type { DatabaseEngine } from '@aws-blocks/data-common';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { externalCluster, resolveCluster } from './cluster-ref.js';
import { DEFAULT_CLUSTER_ID } from './constants.js';
import { configError } from './errors.js';
import { recordClusterBinding, recordDatabaseBinding, recordExternalMigration } from './infra/bindings-metadata.js';
import { ClusterInfra, grantExternalDataApi } from './infra/cluster-infra.js';
import { resolveMigrationsPath } from './migrations/runner.js';
import { registerSchema, registerUniqueId } from './registry.js';
import type {
	AnyClusterDatabaseOptions,
	ClusterKind,
	ClusterOptionsOf,
	ClusterRef,
	ClusterType,
	DatabaseOptions,
	DistributedDatabaseOptions,
	ExternalCluster,
	ExternalClusterRef,
	ExternalDatabaseOptions,
	KindOf,
	OwnedDatabaseOptions,
	ProvisionedDatabaseOptions,
} from './types.js';

/** VPC requirements per cluster type: DSQL is public (egress), Aurora needs the Data API + Secrets Manager endpoints. */
function vpcRequirementsFor(type: ClusterType) {
	return type === 'distributed'
		? { requiresEgress: true }
		: {
				interfaceEndpoints: [
					ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
					ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
				],
			};
}

/** Project root passed to synth (`--context projectRoot=…`), falling back to the cwd. */
function projectRootOf(scope: BuildingBlockScope): string {
	const ctx = scope.node.tryGetContext('projectRoot');
	return typeof ctx === 'string' && ctx ? ctx : process.cwd();
}

/**
 * The cluster a `Database` runs on, when several blocks share one. Provisions
 * Aurora DSQL (`type: 'distributed'`) or Aurora Serverless v2
 * (`type: 'provisioned'`) plus the migration Lambda its blocks use.
 *
 * Part of the `Database` block, not a block itself. It extends
 * `BuildingBlockScope` only because that is how a construct declares its VPC
 * requirements and reaches the stack's execution role and defaults.
 */
export class DatabaseCluster<T extends ClusterType = ClusterType> extends BuildingBlockScope {
	readonly type: T;
	readonly kind: T;
	/** @internal */
	readonly infra: ClusterInfra;

	constructor(scope: ScopeParent, id: string, options: { type: T } & ClusterOptionsOf<T>) {
		super(id, { parent: scope, vpc: vpcRequirementsFor(options.type) });
		this.type = options.type;
		this.kind = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		this.infra = new ClusterInfra({
			owner: this,
			fullId: this.fullId,
			type: options.type,
			options,
			defaults: this.defaults,
			vpcContext: getVpcContext(this),
		});
		for (const [key, value] of Object.entries(this.infra.configEntries)) registerConfig(this, key, value);
		this.infra.grantRuntime(this.executionRole);
		recordClusterBinding(this, this.fullId, options.type);
	}

	/** Reference a PostgreSQL you already have. Returns a plain value, not a construct. */
	static fromExisting(ref: ExternalClusterRef): ExternalCluster {
		return externalCluster(ref);
	}
}

/**
 * SQL database on PostgreSQL, infrastructure build. Owns a `distributed` cluster
 * when `cluster` is omitted; otherwise attaches to the given cluster.
 */
export class Database<K extends ClusterKind = 'distributed'> extends BuildingBlockScope {
	readonly cluster: ClusterRef<K>;
	readonly schemaName: string;
	readonly migrationsPath: string | undefined;

	constructor(scope: ScopeParent, id: string, options?: OwnedDatabaseOptions);
	constructor(scope: ScopeParent, id: string, options: ProvisionedDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: ExternalDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: DistributedDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: AnyClusterDatabaseOptions & { cluster: KindOf<K> });
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		const pre = resolveClusterForVpc(options);
		super(id, { parent: scope, vpc: pre });
		registerUniqueId('Database', id, this.fullId);

		const resolved = resolveCluster(id, this.fullId, options);
		this.cluster = resolved.ref as ClusterRef<K>;
		this.schemaName = resolved.schemaName;
		const clusterFullId = resolved.ref.id === DEFAULT_CLUSTER_ID ? this.fullId : resolved.ref.id;
		registerSchema(resolved.external ? `external:${this.fullId}` : clusterFullId, this.schemaName, this.fullId);
		const projectRoot = projectRootOf(this);
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId, projectRoot);
		recordDatabaseBinding(this, this.fullId, { cluster: resolved.ref.id, type: resolved.ref.kind });

		if (resolved.owned) {
			const owned = options as OwnedDatabaseOptions;
			const infra = new ClusterInfra({
				owner: this,
				fullId: this.fullId,
				type: 'distributed',
				options: { type: 'distributed', removalPolicy: owned.removalPolicy },
				defaults: this.defaults,
				vpcContext: getVpcContext(this),
			});
			for (const [key, value] of Object.entries(infra.configEntries)) registerConfig(this, key, value);
			infra.grantRuntime(this.executionRole);
			infra.attach(
				{ scope: this, fullId: this.fullId, schemaName: this.schemaName, migrationsPath: this.migrationsPath },
				this.executionRole.roleArn,
			);
			return;
		}

		if (resolved.external) {
			const ref = resolved.external.ref;
			if ('host' in ref) {
				grantExternalDataApi(this, this.fullId, ref, this.executionRole);
				if (this.migrationsPath) {
					throw configError(
						`Database '${this.fullId}': migrations on a fromExisting({ host, secretArn }) cluster are not applied at deploy. ` +
							'Apply them with `npx bb-database migrate` or use fromExisting({ connectionString }).',
					);
				}
			} else if (this.migrationsPath) {
				// Applied host-side by the predeploy step, which reads this entry from the template.
				recordExternalMigration(this, {
					fullId: this.fullId,
					schemaName: this.schemaName,
					migrationsPath: relative(projectRoot, this.migrationsPath),
				});
			}
			return;
		}

		if (!(resolved.shared instanceof DatabaseCluster)) {
			throw configError(
				`Database '${this.fullId}': 'cluster' must be a DatabaseCluster or DatabaseCluster.fromExisting().`,
			);
		}
		resolved.shared.infra.attach(
			{ scope: this, fullId: this.fullId, schemaName: this.schemaName, migrationsPath: this.migrationsPath },
			this.executionRole.roleArn,
		);
	}

	/** Alias of `DatabaseCluster.fromExisting()`. */
	static fromExisting(ref: ExternalClusterRef): ExternalCluster {
		return externalCluster(ref);
	}

	query(..._a: unknown[]): never {
		return synthGuard('Database', 'query');
	}
	queryOne(..._a: unknown[]): never {
		return synthGuard('Database', 'queryOne');
	}
	execute(..._a: unknown[]): never {
		return synthGuard('Database', 'execute');
	}
	transaction(..._a: unknown[]): never {
		return synthGuard('Database', 'transaction');
	}
	withRLS(..._a: unknown[]): never {
		return synthGuard('Database', 'withRLS');
	}
	crud(..._a: unknown[]): never {
		return synthGuard('Database', 'crud');
	}
	simulateConflict(..._a: unknown[]): never {
		return synthGuard('Database', 'simulateConflict');
	}
	/** Runtime-only: this build defines infrastructure and has no engine. */
	getEngine(): Promise<DatabaseEngine> {
		return synthGuard('Database', 'getEngine');
	}
}

/** VPC requirements a `Database` declares, decided before `super()` from the raw options. */
function resolveClusterForVpc(options: DatabaseOptions) {
	const cluster = options.cluster;
	if (!cluster) return vpcRequirementsFor('distributed');
	if ('__brand' in cluster) {
		return 'host' in cluster.ref
			? {
					interfaceEndpoints: [
						ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
						ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
					],
				}
			: { requiresEgress: true };
	}
	// Shared cluster: the DatabaseCluster declared its own requirements.
	return {};
}

export * from './exports.js';
