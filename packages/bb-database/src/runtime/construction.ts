// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import {
	AURORA_BACKUP_DAYS_MAX,
	AURORA_MAX_ACU,
	DEFAULT_AURORA_MAX_CAPACITY,
	DEFAULT_AURORA_MIN_CAPACITY,
	DEFAULT_CLUSTER_ID,
	DEFAULT_SCHEMA,
	isClusterType,
	sanitizeSchemaName,
} from '../constants.js';
import { configError } from '../errors.js';
import type {
	AuroraClusterOptions,
	ClusterRef,
	DatabaseClusterLike,
	DatabaseClusterOptions,
	DatabaseOptions,
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
