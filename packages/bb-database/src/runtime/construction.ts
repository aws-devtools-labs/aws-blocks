// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-cdk-blocks/core';
import {
	AURORA_BACKUP_DAYS_MAX,
	AURORA_MAX_ACU,
	CONNECTION_NAME_PATTERN,
	CONNECTION_NAME_RULE,
	DEFAULT_AURORA_MAX_CAPACITY,
	DEFAULT_AURORA_MIN_CAPACITY,
	DEFAULT_CLUSTER_ID,
	DEFAULT_SCHEMA,
	EXTERNAL_CLUSTER_ID,
	isClusterType,
	sanitizeSchemaName,
} from '../constants.js';
import { configError } from '../errors.js';
import { assertCaPem } from '../external/connection.js';
import type {
	AuroraClusterOptions,
	ClusterKind,
	ClusterRef,
	ClusterType,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
	ExistingClusterOptions,
	ExistingClusterRef,
	LegacyDatabaseClusterOptions,
} from '../types.js';

/** `AuroraClusterOptions` with the capacity defaults filled in and every value checked. */
export type ResolvedAuroraClusterOptions = AuroraClusterOptions & { minCapacity: number; maxCapacity: number };

export type ResolvedClusterOptions =
	| Exclude<DatabaseClusterOptions, AuroraClusterOptions>
	| ResolvedAuroraClusterOptions;

function acu(value: number, name: string, floor: number, fullId: string): number {
	if (!Number.isFinite(value) || value < floor || value > AURORA_MAX_ACU || (value * 2) % 1 !== 0) {
		throw configError(
			`DatabaseCluster '${fullId}': ${name} must be a multiple of 0.5 between ${floor} and ${AURORA_MAX_ACU} ACUs, not ${value}.`,
		);
	}
	return value;
}

/**
 * Checks a `DatabaseCluster`'s options the same way in every entry point, so a value the service would reject
 * fails `npm run dev` and the unit tests, not the deploy. Aurora Serverless v2 scales in 0.5 ACU steps; a minimum of 0 pauses
 * the cluster, and the maximum is at least 1. Backups are kept 1 to 35 days.
 */
export function resolveClusterOptions(options: DatabaseClusterOptions, fullId: string): ResolvedClusterOptions {
	if (!isClusterType(options?.type)) {
		throw configError(`DatabaseCluster '${fullId}': 'type' must be 'dsql' or 'aurora'.`);
	}
	if (options.type !== 'aurora') return options;
	const minCapacity = acu(options.minCapacity ?? DEFAULT_AURORA_MIN_CAPACITY, 'minCapacity', 0, fullId);
	// The service requires a maximum above 0.5 ACU (CloudFormation: "The maximum capacity must be higher than 0.5 ACUs").
	const maxCapacity = acu(options.maxCapacity ?? DEFAULT_AURORA_MAX_CAPACITY, 'maxCapacity', 1, fullId);
	if (minCapacity > maxCapacity) {
		throw configError(
			`DatabaseCluster '${fullId}': minCapacity (${minCapacity}) is above maxCapacity (${maxCapacity}).`,
		);
	}
	const pitr = options.pointInTimeRecovery;
	if (typeof pitr === 'object' && pitr !== null) {
		const days = pitr.retentionDays;
		if (!Number.isInteger(days) || days < 1 || days > AURORA_BACKUP_DAYS_MAX) {
			throw configError(
				`DatabaseCluster '${fullId}': pointInTimeRecovery.retentionDays must be an integer from 1 to ${AURORA_BACKUP_DAYS_MAX}, not ${days}.`,
			);
		}
	}
	return { ...options, minCapacity, maxCapacity };
}

function isDatabaseClusterLike(value: unknown): value is DatabaseClusterLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'fullId' in value &&
		isClusterType((value as { type: unknown }).type)
	);
}

const OWNER = 'DatabaseCluster.fromExisting()';

/**
 * `DatabaseCluster.fromExisting()` in every entry point: checks the options and returns the reference. Nothing
 * is read or connected here; the reference only says where the connection string is.
 */
export function existingCluster(options: ExistingClusterOptions): ExistingClusterRef {
	const { name, connectionString, dataApi, ca } = options ?? {};
	if ([name, connectionString, dataApi].filter((v) => v !== undefined).length !== 1) {
		throw configError(`${OWNER}: give exactly one of 'name', 'connectionString' and 'dataApi'.`);
	}
	if (dataApi !== undefined) {
		for (const key of ['clusterArn', 'secretArn', 'database'] as const) {
			if (typeof dataApi?.[key] !== 'string' || dataApi[key] === '') {
				throw configError(`${OWNER}: 'dataApi.${key}' must be a non-empty string.`);
			}
		}
		if (ca !== undefined) {
			throw configError(
				`${OWNER}: 'ca' is for a connection string. The Data API has no server certificate to check.`,
			);
		}
	}
	if (name !== undefined && (typeof name !== 'string' || !CONNECTION_NAME_PATTERN.test(name))) {
		throw configError(`${OWNER}: 'name' ${CONNECTION_NAME_RULE}.`);
	}
	if (connectionString !== undefined && typeof connectionString?.get !== 'function') {
		throw configError(
			`${OWNER}: 'connectionString' must be an AppSetting, a Secret, or an object with get(). ` +
				'A connection string is never written in code.',
		);
	}
	assertCaPem(ca, OWNER);
	return {
		__brand: 'ExistingClusterRef',
		type: 'external',
		...(name !== undefined ? { name } : {}),
		...(connectionString !== undefined ? { connectionString } : {}),
		...(dataApi !== undefined
			? { dataApi: { clusterArn: dataApi.clusterArn, secretArn: dataApi.secretArn, database: dataApi.database } }
			: {}),
		...(ca !== undefined ? { ca } : {}),
	};
}

const LEGACY_OWNER = 'LegacyDatabaseCluster';
const POSTGRES_VERSION = /^\d+\.\d+$/;

/** Checks the options of a `LegacyDatabaseCluster` the same way in every entry point. */
export function checkLegacyClusterOptions(options: LegacyDatabaseClusterOptions | undefined, fullId: string): void {
	const version = options?.postgresVersion;
	if (version !== undefined && !POSTGRES_VERSION.test(version)) {
		throw configError(
			`${LEGACY_OWNER} '${fullId}': postgresVersion must be "MAJOR.MINOR" like "16.13", not "${version}".`,
		);
	}
	const subnets = options?.subnets;
	if (
		subnets &&
		[subnets.subnetType, subnets.subnetGroupName, subnets.subnetIds].filter((v) => v !== undefined).length > 1
	) {
		throw configError(
			`${LEGACY_OWNER} '${fullId}': set at most one of 'subnetType', 'subnetGroupName' and 'subnetIds' in 'subnets'.`,
		);
	}
}

export function isExistingClusterRef(value: unknown): value is ExistingClusterRef {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { __brand?: unknown }).__brand === 'ExistingClusterRef' &&
		(value as { type?: unknown }).type === 'external'
	);
}

// Two blocks may use one existing database (each its own schema) or two databases (both `public`). A database is
// told apart by its `name`, or by the identity of its own connection string source.
const sourceIds = new WeakMap<object, number>();
let nextSourceId = 0;

function existingClusterKey(ref: ExistingClusterRef): string {
	if (ref.name !== undefined) return `${EXTERNAL_CLUSTER_ID}:${ref.name}`;
	if (ref.dataApi !== undefined)
		return `${EXTERNAL_CLUSTER_ID}:data-api:${ref.dataApi.clusterArn}/${ref.dataApi.database}`;
	const source = ref.connectionString as object;
	let id = sourceIds.get(source);
	if (id === undefined) {
		id = nextSourceId++;
		sourceIds.set(source, id);
	}
	return `${EXTERNAL_CLUSTER_ID}#${id}`;
}

/** A block on an existing database, or on a cluster that a block or a `DatabaseCluster` provisions. */
type ResolvedCluster =
	| {
			ref: ClusterRef & { kind: 'external' };
			schemaName: string;
			/** The existing database the block runs on (`DatabaseCluster.fromExisting()`). */
			external: ExistingClusterRef;
			shared?: undefined;
	  }
	| {
			ref: ClusterRef & { kind: ClusterType };
			schemaName: string;
			external?: undefined;
			/** The `DatabaseCluster` the block runs on; absent when the block owns its cluster. */
			shared?: DatabaseClusterLike;
	  };

/**
 * The schema of a block that names none: `public` on its own cluster and on an existing database, a schema
 * named after the block on a `DatabaseCluster` that several blocks share.
 */
export const defaultSchemaName = (blockId: string, shared: boolean): string =>
	shared ? sanitizeSchemaName(blockId) : DEFAULT_SCHEMA;

// A block that names no schema is in `public` on its own cluster and on an existing database, and in a schema
// named after it on a shared cluster. The Data API has no session, so a schema cannot be put on a search path:
// a database behind it is in `public` only.
function schemaOn(
	cluster: { dataApi?: unknown } | undefined,
	shared: boolean,
	blockId: string,
	blockFullId: string,
	explicitSchema: string | undefined,
): string {
	if (!cluster?.dataApi) return explicitSchema ?? defaultSchemaName(blockId, shared);
	if (explicitSchema !== undefined && explicitSchema !== DEFAULT_SCHEMA) {
		throw configError(
			`Database '${blockFullId}': a database that is reached through the RDS Data API has the schema ` +
				`'${DEFAULT_SCHEMA}'. Remove 'schemaName'.`,
		);
	}
	return DEFAULT_SCHEMA;
}

function resolveCluster(blockId: string, blockFullId: string, options: DatabaseOptions | undefined): ResolvedCluster {
	const cluster = options?.cluster;
	const explicitSchema = options?.schemaName;
	if (cluster === undefined || cluster === null) {
		return {
			ref: { kind: 'dsql', id: DEFAULT_CLUSTER_ID },
			schemaName: schemaOn(undefined, false, blockId, blockFullId, explicitSchema),
		};
	}
	if (isExistingClusterRef(cluster)) {
		// The tables that already exist are in `public`, so that is the block's schema unless it names another.
		return {
			ref: { kind: 'external', id: EXTERNAL_CLUSTER_ID },
			schemaName: schemaOn(cluster, false, blockId, blockFullId, explicitSchema),
			external: cluster,
		};
	}
	if (isDatabaseClusterLike(cluster)) {
		return {
			ref: { kind: cluster.type, id: cluster.fullId },
			schemaName: schemaOn(cluster, true, blockId, blockFullId, explicitSchema),
			shared: cluster,
		};
	}
	throw configError(
		`Database '${blockFullId}': 'cluster' must be a DatabaseCluster or the result of DatabaseCluster.fromExisting().`,
	);
}

export type DatabaseRegistration = ResolvedCluster & {
	/** The fullId the cluster's resources are named after: the block's own, or the shared cluster's. */
	clusterFullId: string;
	/**
	 * The kind whose file check applies to the block's migration files. The files of a `LegacyDatabaseCluster`
	 * are older than the block and may be applied already, as those of an existing database are, so they get
	 * no check.
	 */
	fileKind: ClusterKind;
};

/**
 * The construction sequence every entry point runs: unique id, cluster, then a schema claim on that cluster.
 * `block` is the block itself, after `super()`; its scope chain tells which app it belongs to.
 */
export function registerDatabase(
	block: ScopeParent,
	id: string,
	fullId: string,
	options: DatabaseOptions | undefined,
): DatabaseRegistration {
	const s = state(block);
	claimUniqueId(s, 'Database', id, fullId);
	const resolved = resolveCluster(id, fullId, options);
	const clusterFullId = resolved.external
		? existingClusterKey(resolved.external)
		: resolved.shared
			? resolved.shared.fullId
			: fullId;
	claimSchema(s, clusterFullId, resolved.schemaName, fullId);
	return { ...resolved, clusterFullId, fileKind: resolved.shared?.dataApi ? 'external' : resolved.ref.kind };
}

interface RegistryState {
	databases: Map<string, string>;
	clusters: Map<string, string>;
	schemas: Map<string, Map<string, string>>;
}

// On globalThis: entry files loaded under different conditions in one process must share one registry.
const KEY = Symbol.for('BLOCKS_DATABASE_REGISTRY');

function registries(): Map<string, RegistryState> {
	const g = globalThis as unknown as Record<symbol, Map<string, RegistryState> | undefined>;
	let all = g[KEY];
	if (!all) {
		all = new Map();
		g[KEY] = all;
	}
	return all;
}

// Uniqueness is per app, and one process can hold several: a CDK app with two `BlocksBackend`s, or a test
// file. The app is the top of the block's scope chain: the `BlocksStack`/`BlocksBackend` at synth, the
// `{ id: BLOCKS_STACK_NAME }` parent at runtime (an anonymous one locally).
function appRootKey(block: ScopeParent): string {
	let root: ScopeParent = block;
	while ('parent' in root && root.parent) root = root.parent;
	if ('fullId' in root && typeof root.fullId === 'string') return root.fullId;
	return root.id ?? '';
}

function state(block: ScopeParent): RegistryState {
	const all = registries();
	const key = appRootKey(block);
	let s = all.get(key);
	if (!s) {
		s = { databases: new Map(), clusters: new Map(), schemas: new Map() };
		all.set(key, s);
	}
	return s;
}

export function registerUniqueId(
	kind: 'Database' | 'DatabaseCluster',
	block: ScopeParent,
	id: string,
	fullId: string,
): void {
	claimUniqueId(state(block), kind, id, fullId);
}

function claimUniqueId(s: RegistryState, kind: 'Database' | 'DatabaseCluster', id: string, fullId: string): void {
	const map = kind === 'Database' ? s.databases : s.clusters;
	const existing = map.get(id);
	if (existing !== undefined && existing !== fullId) {
		throw configError(
			`${kind} id '${id}' is used twice: '${existing}' and '${fullId}'. ${kind} ids must be unique per app.`,
		);
	}
	map.set(id, fullId);
}

function claimSchema(s: RegistryState, clusterId: string, schemaName: string, blockFullId: string): void {
	let bySchema = s.schemas.get(clusterId);
	if (!bySchema) {
		bySchema = new Map();
		s.schemas.set(clusterId, bySchema);
	}
	const existing = bySchema.get(schemaName);
	if (existing !== undefined && existing !== blockFullId) {
		throw configError(
			`Database '${existing}' and '${blockFullId}' both use schema '${schemaName}' on cluster '${clusterId}'.`,
		);
	}
	bySchema.set(schemaName, blockFullId);
}

/** @internal For test cleanup only. */
export function _resetDatabaseRegistry(): void {
	registries().clear();
}
