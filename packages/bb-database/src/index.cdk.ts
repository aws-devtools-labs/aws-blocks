// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-cdk-blocks/core';
import { BuildingBlockScope, registerConfig, synthGuard } from '@aws-cdk-blocks/core/cdk';
import { markBlocksOwned } from '@aws-cdk-blocks/core/cdk/internal';
import * as cdk from 'aws-cdk-lib';
import { connectionParameterName } from './constants.js';
import { ClusterInfra, ownedDsqlClusterLogicalId } from './deploy/cluster-infra.js';
import {
	type ConnectionStore,
	dataApiStore,
	externalMigrations,
	secretStore,
	ssmStore,
} from './deploy/external-infra.js';
import { configError } from './errors.js';
import { LEGACY_VPC_REQUIREMENTS, type LegacyClusterInfra, legacyClusterInfra } from './legacy/aurora-cluster.js';
import { lintMigrationFiles } from './migrations/plan.js';
import { loadMigrationFiles, resolveMigrationsPath } from './migrations/runner.js';
import {
	checkLegacyClusterOptions,
	existingCluster,
	type ResolvedClusterOptions,
	registerDatabase,
	registerUniqueId,
	resolveClusterOptions,
} from './runtime/construction.js';
import type {
	ClusterRef,
	ClusterType,
	DatabaseClusterOptions,
	DatabaseOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	LegacyDatabaseClusterOptions,
} from './types.js';
import { BB_NAME } from './version.js';

// DSQL is reached over its public endpoint, so an app in a VPC needs egress.
const VPC_REQUIREMENTS = { requiresEgress: true };

function projectRootOf(scope: BuildingBlockScope): string {
	const ctx = scope.node.tryGetContext('projectRoot');
	return typeof ctx === 'string' && ctx ? ctx : process.cwd();
}

function clusterInfra(
	owner: BuildingBlockScope,
	options: ResolvedClusterOptions,
	clusterLogicalId?: string,
): ClusterInfra {
	const infra = new ClusterInfra({ owner, fullId: owner.fullId, options, clusterLogicalId });
	for (const [key, value] of Object.entries(infra.configEntries)) registerConfig(owner, key, value);
	return infra;
}

/**
 * The cluster a `Database` runs on, when several blocks share one. Provisions
 * Aurora DSQL (`type: 'dsql'`) or Aurora PostgreSQL Serverless v2 with the
 * express configuration (`type: 'aurora'`), plus the migration Lambdas its
 * blocks use. Both kinds are reached over a public endpoint, so neither needs a VPC.
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
		// Part of the `Database` block but not a block: it passes no `bbName`, so mark it for the
		// service-principal trust check, which then treats its roles as CDK Blocks roles.
		markBlocksOwned(this);
		const resolved = resolveClusterOptions(options, this.fullId);
		this.type = resolved.type;
		registerUniqueId('DatabaseCluster', this, id, this.fullId);
		this.infra = clusterInfra(this, resolved);
	}

	/** Refer to an existing PostgreSQL database; see the local entry for the full description. */
	static fromExisting(options: ExistingClusterOptions): ExistingClusterRef {
		return existingCluster(options);
	}
}

/**
 * The Aurora cluster of `Database` in `@aws-blocks/bb-data` 0.5.0; see the local entry for the full
 * description. Declares the VPC, the security group, the cluster with its writer and its credentials secret
 * as that block did, under the same logical ids, so a deploy changes none of them.
 *
 * @deprecated Only for an app that deployed `Database` of `@aws-blocks/bb-data`.
 */
export class LegacyDatabaseCluster extends BuildingBlockScope {
	/** The engine of the cluster: Aurora PostgreSQL. */
	readonly type = 'aurora' as const;
	/** The block reaches this cluster through the RDS Data API. */
	readonly dataApi = true as const;
	/** @internal */
	readonly legacy: LegacyClusterInfra;

	constructor(scope: ScopeParent, id: string, options?: LegacyDatabaseClusterOptions) {
		super(id, { parent: scope, vpc: LEGACY_VPC_REQUIREMENTS });
		markBlocksOwned(this);
		checkLegacyClusterOptions(options, this.fullId);
		registerUniqueId('DatabaseCluster', this, id, this.fullId);
		this.legacy = legacyClusterInfra(this, options);
	}

	/**
	 * @internal The migrations of a block on this cluster. The cluster has made the app's grants; the block's
	 * files run in the migration function of an existing database, through the Data API, after the cluster exists.
	 */
	attach(block: BuildingBlockScope, schemaName: string, migrations: Record<string, string> | undefined): void {
		if (!migrations || Object.keys(migrations).length === 0) return;
		externalMigrations({
			owner: block,
			fullId: block.fullId,
			schemaName,
			migrations,
			store: this.legacy.store,
			dependsOn: this.legacy.cluster,
		});
	}
}

// An `AppSetting` exposes its parameter name at synth, a `Secret` its ARN; that is how the migration function
// can be granted the read. Any other object with `get()` works at run time but tells synth nothing.
function connectionStoreOf(stack: cdk.Stack, source: object): ConnectionStore | undefined {
	const { parameterName, secretArn } = source as { parameterName?: unknown; secretArn?: unknown };
	if (typeof parameterName === 'string') return ssmStore(stack, parameterName);
	if (typeof secretArn === 'string') return secretStore(secretArn);
	return undefined;
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
		// An owned cluster and an existing database are both reached over a public endpoint from the app's
		// functions; a shared `DatabaseCluster` declares that need itself.
		super(id, {
			parent: scope,
			bbName: BB_NAME,
			vpc: !options.cluster || options.cluster.type === 'external' ? VPC_REQUIREMENTS : {},
		});
		const resolved = registerDatabase(this, id, this.fullId, options);
		this.cluster = resolved.ref;
		this.schemaName = resolved.schemaName;
		this.migrationsPath = resolveMigrationsPath(options.migrationsPath, id, this.fullId, projectRootOf(this));
		// Checked here, before any deploy: the migration Lambda runs the files without the linter, which is not
		// deployed with it.
		const migrations = this.migrationsPath ? loadMigrationFiles(this.migrationsPath) : undefined;
		if (migrations) lintMigrationFiles(migrations, resolved.fileKind);

		if (resolved.external) {
			this.existingDatabase(resolved.external, migrations);
			return;
		}

		let infra: ClusterInfra;
		if (!options.cluster) {
			infra = clusterInfra(
				this,
				resolveClusterOptions({ type: 'dsql', removalPolicy: options.removalPolicy }, this.fullId),
				ownedDsqlClusterLogicalId(cdk.Stack.of(this), this.fullId),
			);
		} else if (resolved.shared instanceof LegacyDatabaseCluster) {
			resolved.shared.attach(this, this.schemaName, migrations);
			return;
		} else if (resolved.shared instanceof DatabaseCluster) {
			infra = resolved.shared.infra;
		} else {
			throw configError(`Database '${this.fullId}': 'cluster' must be a DatabaseCluster.`);
		}
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
	asUser(..._a: unknown[]): never {
		return synthGuard('Database', 'asUser');
	}
	asRole(..._a: unknown[]): never {
		return synthGuard('Database', 'asRole');
	}

	// No cluster to provision. The app's role is granted the read of what the block itself names: the one SSM
	// SecureString that `npm run db -- connect --stage` writes, under the name the Lambda entry derives the same
	// way, or the cluster and the secret of the Data API. With the app's own store, that block has made the grant.
	private existingDatabase(external: ExistingClusterRef, migrations: Record<string, string> | undefined): void {
		const stack = cdk.Stack.of(this);
		const named = external.dataApi
			? dataApiStore(external.dataApi)
			: external.name !== undefined
				? ssmStore(stack, connectionParameterName(this.backendStackName, external.name))
				: undefined;
		named?.grantRead(this.executionRole);
		const store =
			named ?? (external.connectionString ? connectionStoreOf(stack, external.connectionString) : undefined);
		if (!migrations || Object.keys(migrations).length === 0) return;
		if (!store) {
			throw configError(
				`Database '${this.fullId}': migrations on an existing database need a connection string that the ` +
					"deploy can read: use DatabaseCluster.fromExisting({ name }), an AppSetting or a Secret as 'connectionString'.",
			);
		}
		externalMigrations({
			owner: this,
			fullId: this.fullId,
			schemaName: this.schemaName,
			migrations,
			ca: external.ca,
			store,
		});
	}
}

export * from './exports.js';
