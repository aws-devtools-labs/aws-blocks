// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
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
	/** The `DatabaseCluster` the block runs on; absent when the block owns its cluster. */
	shared?: DatabaseClusterLike;
}

function resolveCluster(blockId: string, blockFullId: string, options: DatabaseOptions | undefined): ResolvedCluster {
	const cluster = options?.cluster;
	const explicitSchema = options?.schemaName;
	if (cluster === undefined || cluster === null) {
		return { ref: { kind: 'dsql', id: DEFAULT_CLUSTER_ID }, schemaName: explicitSchema ?? DEFAULT_SCHEMA };
	}
	if (isDatabaseClusterLike(cluster)) {
		return {
			ref: { kind: cluster.type, id: cluster.fullId },
			schemaName: explicitSchema ?? sanitizeSchemaName(blockId),
			shared: cluster,
		};
	}
	throw configError(`Database '${blockFullId}': 'cluster' must be a DatabaseCluster.`);
}

export interface DatabaseRegistration extends ResolvedCluster {
	/** The fullId the cluster's resources are named after: the block's own, or the shared cluster's. */
	clusterFullId: string;
}

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
	const clusterFullId = resolved.shared ? resolved.shared.fullId : fullId;
	claimSchema(s, clusterFullId, resolved.schemaName, fullId);
	return { ...resolved, clusterFullId };
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
