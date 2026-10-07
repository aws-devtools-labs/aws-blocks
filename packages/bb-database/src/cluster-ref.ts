// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime helpers shared by every entry point for turning a `cluster` option
 * into a {@link ClusterRef} descriptor, and for `DatabaseCluster.fromExisting()`.
 */
import { DEFAULT_CLUSTER_ID, DEFAULT_SCHEMA, EXTERNAL_CLUSTER_ID, sanitizeSchemaName } from './constants.js';
import { configError } from './errors.js';
import type {
	ClusterKind,
	ClusterRef,
	ClusterType,
	DatabaseClusterLike,
	DatabaseOptions,
	ExternalCluster,
	ExternalClusterRef,
} from './types.js';

/** Build the reference value for a PostgreSQL you already have. */
export function externalCluster(ref: ExternalClusterRef): ExternalCluster {
	if (!ref || typeof ref !== 'object') {
		throw configError(
			'DatabaseCluster.fromExisting() needs { connectionString } or { host, secretArn, database }.',
		);
	}
	const hasConn = 'connectionString' in ref && ref.connectionString !== undefined && ref.connectionString !== null;
	const hasHost = 'host' in ref && typeof ref.host === 'string';
	if (!hasConn && !hasHost) {
		throw configError(
			'DatabaseCluster.fromExisting() needs a connectionString (set DATABASE_URL, or pass an AppSetting) ' +
				'or { host, secretArn, database }.',
		);
	}
	return Object.freeze({ __brand: 'ExternalCluster', kind: 'external', ref }) as ExternalCluster;
}

/** Whether a `cluster` option value is a `fromExisting()` reference. */
export function isExternalCluster(value: unknown): value is ExternalCluster {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__brand' in value &&
		(value as { __brand: unknown }).__brand === 'ExternalCluster'
	);
}

/** Whether a `cluster` option value looks like a `DatabaseCluster` (any entry point's class). */
export function isDatabaseClusterLike(value: unknown): value is DatabaseClusterLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		'fullId' in value &&
		((value as { type: unknown }).type === 'distributed' || (value as { type: unknown }).type === 'provisioned')
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
	/** The external reference when `fromExisting()`. */
	external?: ExternalCluster;
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
	if (isExternalCluster(cluster)) {
		return {
			ref: { kind: 'external', id: EXTERNAL_CLUSTER_ID },
			schemaName: explicitSchema ?? sanitizeSchemaName(blockId),
			owned: false,
			external: cluster,
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
	throw configError(
		`Database '${blockFullId}': 'cluster' must be a DatabaseCluster or the value of DatabaseCluster.fromExisting().`,
	);
}

/** Whether a kind supports Row Level Security and `crud()`. */
export function supportsRls(kind: ClusterKind): kind is 'provisioned' | 'external' {
	return kind === 'provisioned' || kind === 'external';
}

/** Whether a kind is one `DatabaseCluster` provisions. */
export function isClusterType(kind: ClusterKind): kind is ClusterType {
	return kind === 'distributed' || kind === 'provisioned';
}
