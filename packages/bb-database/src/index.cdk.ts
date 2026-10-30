// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import { BuildingBlockScope, registerConfig, synthGuard } from '@aws-blocks/core/cdk';
import { registerDatabase, registerUniqueId } from './core/construction.js';
import { configError } from './errors.js';
import { recordClusterBinding, recordDatabaseBinding } from './infra/bindings-metadata.js';
import { ClusterInfra } from './infra/cluster-infra.js';
import { lintMigrationFiles } from './migrations/plan.js';
import { loadMigrationFiles, resolveMigrationsPath } from './migrations/runner.js';
import type { ClusterRef, ClusterType, DatabaseBinding, DatabaseClusterOptions, DatabaseOptions } from './types.js';

// DSQL is reached over its public endpoint, so an app in a VPC needs egress.
const VPC_REQUIREMENTS = { requiresEgress: true };

function projectRootOf(scope: BuildingBlockScope): string {
	const ctx = scope.node.tryGetContext('projectRoot');
	return typeof ctx === 'string' && ctx ? ctx : process.cwd();
}

function clusterInfra(owner: BuildingBlockScope, options: DatabaseClusterOptions): ClusterInfra {
	const infra = new ClusterInfra({ owner, fullId: owner.fullId, options });
	for (const [key, value] of Object.entries(infra.configEntries)) registerConfig(owner, key, value);
	return infra;
}

/**
 * The cluster a `Database` runs on, when several blocks share one. Provisions
 * Aurora DSQL (`type: 'dsql'`) plus the migration Lambdas its blocks use.
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
		this.infra = clusterInfra(this, options);
		recordClusterBinding(this, this.fullId, { type: options.type, resource: this.infra.clusterLogicalId });
	}
}

/**
 * SQL database on PostgreSQL, infrastructure build. Owns a `dsql` cluster
 * when `cluster` is omitted; otherwise attaches to the given cluster.
 */
export class Database extends BuildingBlockScope {
	readonly cluster: ClusterRef;
	readonly schemaName: string;
	private readonly migrationsPath: string | undefined;

	/**
	 * Without `cluster`, the block owns an Aurora DSQL cluster and `removalPolicy`
	 * applies to it. With `cluster`, the block runs in its own schema on that shared
	 * `DatabaseCluster`, whose own options then apply.
	 */
	constructor(scope: ScopeParent, id: string, options: DatabaseOptions = {}) {
		super(id, { parent: scope, vpc: options.cluster ? {} : VPC_REQUIREMENTS });
		const resolved = registerDatabase(id, this.fullId, options);
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId, projectRootOf(this));
		// Checked with dsql-lint here, before any deploy: the migration Lambda runs the files without the
		// linter, which is not deployed with it.
		const migrations = this.migrationsPath ? loadMigrationFiles(this.migrationsPath) : undefined;
		if (migrations) lintMigrationFiles(migrations);

		let infra: ClusterInfra;
		const binding: DatabaseBinding = { cluster: resolved.ref.id, type: resolved.ref.kind };
		if (!options.cluster) {
			infra = clusterInfra(this, { type: 'dsql', removalPolicy: options.removalPolicy });
			binding.resource = infra.clusterLogicalId;
		} else if (resolved.shared instanceof DatabaseCluster) {
			infra = resolved.shared.infra;
		} else {
			throw configError(`Database '${this.fullId}': 'cluster' must be a DatabaseCluster.`);
		}
		recordDatabaseBinding(this, this.fullId, binding);
		infra.attach({ scope: this, fullId: this.fullId, schemaName: this.schemaName, migrations });
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
