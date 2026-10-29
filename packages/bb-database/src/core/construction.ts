// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What every entry point's constructor does before anything else, so the
 * mock, aws and cdk layers never disagree: resolve the `cluster` option into a
 * {@link ClusterRef} descriptor plus the schema name, and check that `Database`
 * and `DatabaseCluster` short ids are unique per app and that blocks on one
 * cluster never share a schema. Registry state lives on `globalThis` so entry
 * files loaded under different conditions in one process agree.
 */
import { DEFAULT_CLUSTER_ID, DEFAULT_SCHEMA, sanitizeSchemaName } from '../constants.js';
import { configError } from '../errors.js';
import type { ClusterRef, DatabaseClusterLike, DatabaseOptions } from '../types.js';

/** Whether a `cluster` option value looks like a `DatabaseCluster` (any entry point's class). */
function isDatabaseClusterLike(value: unknown): value is DatabaseClusterLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'fullId' in value &&
		(value as { type: unknown }).type === 'dsql'
	);
}

/** Everything a layer needs to know about the cluster a block was given. */
interface ResolvedCluster {
	ref: ClusterRef;
	/** The schema this block's tables live in. */
	schemaName: string;
	/** Set when the block owns its cluster. */
	owned: boolean;
	/** The `DatabaseCluster` instance when shared. */
	shared?: DatabaseClusterLike;
}

/**
 * Resolve a `Database`'s `cluster` option into a descriptor plus the schema
 * name. Shared by the mock, aws and cdk constructors so the three layers never
 * disagree about kind or schema.
 */
export function resolveCluster(
	blockId: string,
	blockFullId: string,
	options: DatabaseOptions | undefined,
): ResolvedCluster {
	const cluster = options?.cluster;
	const explicitSchema = options?.schemaName;
	if (cluster === undefined || cluster === null) {
		return {
			ref: { kind: 'dsql', id: DEFAULT_CLUSTER_ID },
			schemaName: explicitSchema ?? DEFAULT_SCHEMA,
			owned: true,
		};
	}
	if (isDatabaseClusterLike(cluster)) {
		return {
			ref: { kind: cluster.type, id: cluster.fullId },
			schemaName: explicitSchema ?? sanitizeSchemaName(blockId),
			owned: false,
			shared: cluster,
		};
	}
	throw configError(`Database '${blockFullId}': 'cluster' must be a DatabaseCluster.`);
}

interface RegistryState {
	databases: Map<string, string>;
	clusters: Map<string, string>;
	/** cluster id → (schema → block full id) */
	schemas: Map<string, Map<string, string>>;
}

const KEY = Symbol.for('BLOCKS_DATABASE_REGISTRY');

function state(): RegistryState {
	const g = globalThis as unknown as Record<symbol, RegistryState | undefined>;
	let s = g[KEY];
	if (!s) {
		s = { databases: new Map(), clusters: new Map(), schemas: new Map() };
		g[KEY] = s;
	}
	return s;
}

/** Register a block's short id; throws when another block in a different scope already uses it. */
export function registerUniqueId(kind: 'Database' | 'DatabaseCluster', id: string, fullId: string): void {
	const map = kind === 'Database' ? state().databases : state().clusters;
	const existing = map.get(id);
	if (existing !== undefined && existing !== fullId) {
		throw configError(
			`${kind} id '${id}' is used twice: '${existing}' and '${fullId}'. ${kind} ids must be unique per app.`,
		);
	}
	map.set(id, fullId);
}

/** Register a block's schema on a cluster; throws when another block on that cluster already uses it. */
export function registerSchema(clusterId: string, schemaName: string, blockFullId: string): void {
	const s = state();
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

/** @internal Clear every registry. **For test cleanup only.** */
export function _resetDatabaseRegistry(): void {
	const s = state();
	s.databases.clear();
	s.clusters.clear();
	s.schemas.clear();
}
