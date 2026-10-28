// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK infrastructure entry point (`cdk synth --conditions=cdk`).
 *
 * A `DatabaseCluster` provisions an Aurora DSQL cluster plus its migration
 * Lambdas. A `Database` either owns a `distributed` cluster or attaches to a
 * shared one, adding the CustomResource that creates its schema and runs its
 * migrations at deploy time. Both record their binding in stack metadata for
 * the deploy guard.
 */
import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import { resolveCluster } from './cluster-ref.js';
import { DEFAULT_CLUSTER_ID } from './constants.js';
import { configError } from './errors.js';
import { ClusterInfra } from './infra/cluster-infra.js';
import { resolveMigrationsPath } from './migrations/runner.js';
import { registerSchema, registerUniqueId } from './registry.js';
import type {
	ClusterRef,
	ClusterType,
	DatabaseClusterOptions,
	DatabaseOptions,
	DistributedDatabaseOptions,
	OwnedDatabaseOptions,
} from './types.js';

/** VPC requirements per cluster type: DSQL is reached over the public endpoint, so a VPC app needs egress. */
const VPC_REQUIREMENTS = { requiresEgress: true };

/** Project root passed to synth (`--context projectRoot=…`), falling back to the cwd. */
function projectRootOf(scope: BuildingBlockScope): string {
	const ctx = scope.node.tryGetContext('projectRoot');
	return typeof ctx === 'string' && ctx ? ctx : process.cwd();
}

/**
 * The cluster a `Database` runs on, when several blocks share one. Provisions
 * Aurora DSQL (`type: 'distributed'`) plus the migration Lambdas its blocks use.
 *
 * Part of the `Database` block, not a block itself. It extends
 * `BuildingBlockScope` only because that is how a construct declares its VPC
 * requirements and reaches the stack's execution role and defaults.
 */
export class DatabaseCluster extends BuildingBlockScope {
	/** The category this cluster was constructed with. */
	readonly type: ClusterType;
	/** @internal */
	readonly infra: ClusterInfra;

	constructor(scope: ScopeParent, id: string, options: DatabaseClusterOptions) {
		super(id, { parent: scope, vpc: VPC_REQUIREMENTS });
		this.type = options.type;
		registerUniqueId('DatabaseCluster', id, this.fullId);
		this.infra = new ClusterInfra({
			owner: this,
			fullId: this.fullId,
			type: options.type,
			options,
			defaults: this.defaults,
		});
		for (const [key, value] of Object.entries(this.infra.configEntries)) registerConfig(this, key, value);
		this.infra.grantRuntime(this.executionRole);
	}
}

/**
 * SQL database on PostgreSQL, infrastructure build. Owns a `distributed` cluster
 * when `cluster` is omitted; otherwise attaches to the given cluster.
 */
export class Database extends BuildingBlockScope {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
	private readonly migrationsPath: string | undefined;

	constructor(scope: ScopeParent, id: string, options?: OwnedDatabaseOptions);
	constructor(scope: ScopeParent, id: string, options: DistributedDatabaseOptions);
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		// A shared cluster declared its own requirements; an owned one needs egress to DSQL.
		super(id, { parent: scope, vpc: options.cluster ? {} : VPC_REQUIREMENTS });
		registerUniqueId('Database', id, this.fullId);

		const resolved = resolveCluster(id, this.fullId, options);
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;
		const clusterFullId = resolved.ref.id === DEFAULT_CLUSTER_ID ? this.fullId : resolved.ref.id;
		registerSchema(clusterFullId, this.schemaName, this.fullId);
		const projectRoot = projectRootOf(this);
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId, projectRoot);

		if (resolved.owned) {
			const owned = options as OwnedDatabaseOptions;
			const infra = new ClusterInfra({
				owner: this,
				fullId: this.fullId,
				type: 'distributed',
				options: { type: 'distributed', removalPolicy: owned.removalPolicy },
				defaults: this.defaults,
			});
			for (const [key, value] of Object.entries(infra.configEntries)) registerConfig(this, key, value);
			infra.grantRuntime(this.executionRole);
			infra.attach(
				{ scope: this, fullId: this.fullId, schemaName: this.schemaName, migrationsPath: this.migrationsPath },
				this.executionRole,
			);
			return;
		}

		if (!(resolved.shared instanceof DatabaseCluster)) {
			throw configError(`Database '${this.fullId}': 'cluster' must be a DatabaseCluster.`);
		}
		resolved.shared.infra.attach(
			{ scope: this, fullId: this.fullId, schemaName: this.schemaName, migrationsPath: this.migrationsPath },
			this.executionRole,
		);
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
}

export * from './exports.js';
