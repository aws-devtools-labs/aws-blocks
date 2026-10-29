// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_CLUSTER_ID, DEFAULT_SCHEMA, sanitizeSchemaName } from '../constants.js';
import { configError } from '../errors.js';
import type { ClusterRef, DatabaseClusterLike, DatabaseOptions } from '../types.js';

function isDatabaseClusterLike(value: unknown): value is DatabaseClusterLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'fullId' in value &&
		(value as { type: unknown }).type === 'dsql'
	);
}

interface ResolvedCluster {
	ref: ClusterRef;
	schemaName: string;
	owned: boolean;
	shared?: DatabaseClusterLike;
}

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
	schemas: Map<string, Map<string, string>>;
}

// On globalThis: entry files loaded under different conditions in one process must share one registry.
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

/** @internal For test cleanup only. */
export function _resetDatabaseRegistry(): void {
	const s = state();
	s.databases.clear();
	s.clusters.clear();
	s.schemas.clear();
}
