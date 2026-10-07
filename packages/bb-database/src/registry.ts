// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-wide registries that enforce two app-level rules at construction:
 *
 * 1. `Database` and `DatabaseCluster` short ids are unique per app, so a later
 *    compile-time binding check can look a block up by the literal in its
 *    constructor, and a rename after first deploy is a visible binding change.
 * 2. Two blocks on one cluster never share a schema.
 *
 * Both checks run in every entry point (dev server, synth, Lambda cold start);
 * the message text is the same everywhere. Keyed on `globalThis` so the three
 * entry files, loaded under different conditions in one process, agree.
 */
import { configError } from './errors.js';

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

/** Clear every registry. **For test cleanup only.** */
export function _resetDatabaseRegistry(): void {
	const s = state();
	s.databases.clear();
	s.clusters.clear();
	s.schemas.clear();
}
