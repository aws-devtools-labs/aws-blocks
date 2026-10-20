// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime helpers shared by every entry point for turning a `cluster` option
 * into a {@link ClusterRef} descriptor.
 */
import { DEFAULT_CLUSTER_ID, DEFAULT_SCHEMA, sanitizeSchemaName } from './constants.js';
import { configError } from './errors.js';
import type { ClusterRef, DatabaseClusterLike, DatabaseOptions } from './types.js';

/** Whether a `cluster` option value looks like a `DatabaseCluster` (any entry point's class). */
export function isDatabaseClusterLike(value: unknown): value is DatabaseClusterLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'fullId' in value &&
		(value as { type: unknown }).type === 'distributed'
	);
}

/** Everything a layer needs to know about the cluster a block was given. */
export interface ResolvedCluster {
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
			ref: { kind: 'distributed', id: DEFAULT_CLUSTER_ID },
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
