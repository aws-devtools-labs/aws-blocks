// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

/**
 * Shared constants for the Database Building Block.
 */

/** Regex to sanitize names into valid environment variable / resource name segments. */
export const ENV_NAME_SANITIZE_PATTERN = /[^a-zA-Z0-9]/g;

/** Prefix for config keys injected by the CDK layer and read by the runtime engines. */
export const ENV_VAR_PREFIX = 'BLOCKS';

/** Default minimum Aurora Capacity Units (ACUs) for a `provisioned` cluster. */
export const DEFAULT_MIN_CAPACITY = 0.5;

/** Default maximum Aurora Capacity Units (ACUs) for a `provisioned` cluster. */
export const DEFAULT_MAX_CAPACITY = 2;

/**
 * Default automated-backup retention (days) for a `provisioned` cluster, which
 * is also its point-in-time-recovery window. Matches the SecureCDK baseline.
 */
export const DEFAULT_BACKUP_RETENTION_DAYS = 15;

/** Number of availability zones for a standalone Aurora VPC. */
export const VPC_MAX_AZS = 2;

/** Default Aurora PostgreSQL engine version for a `provisioned` cluster. */
export const DEFAULT_POSTGRES_VERSION = '16.13';

/** Migration Lambda timeout, in minutes. Covers large migration sets and cluster warm-up. */
export const MIGRATION_LAMBDA_TIMEOUT_MINUTES = 10;

/** Default connection pool size for the pooled (pg) engines. */
export const DEFAULT_POOL_SIZE = 5;

/** Default max retry attempts for OCC conflicts when `retryOnConflict` is enabled. */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * Back-off schedule (ms) for the automatic retry of a single auto-commit
 * `query()` / `execute()` that fails with a serialization conflict.
 */
export const AUTOCOMMIT_CONFLICT_BACKOFF_MS: readonly number[] = [50, 100, 200];

/** Maximum rows mutated per transaction on a `distributed` (Aurora DSQL) cluster. */
export const TRANSACTION_ROW_LIMIT = 3000;

/** Reserved cluster id for a `Database` that owns its cluster. */
export const DEFAULT_CLUSTER_ID = 'default';

/** Reserved cluster id for a `Database` on `DatabaseCluster.fromExisting()`. */
export const EXTERNAL_CLUSTER_ID = 'external';

/** Schema a `Database` that owns its cluster uses. */
export const DEFAULT_SCHEMA = 'public';

/** CloudFormation stack-metadata key carrying the {@link Bindings} record. */
export const BINDINGS_METADATA_KEY = 'aws-blocks:bindings';

/** Name of the per-block binding marker written by the dev server. */
export const BINDING_MARKER_FILE = 'binding.json';

/** Default root (relative to the project root) of per-block migration directories. */
export const DEFAULT_MIGRATIONS_ROOT = './aws-blocks/migrations';

/** Identity-column sequence cache Aurora DSQL requires. */
export const DSQL_IDENTITY_CACHE = 65536;

/** Prefix of the custom database role the migration Lambda creates for the app on a DSQL cluster. */
export const DB_ROLE_PREFIX = 'blocks_app_';

/** Max PostgreSQL identifier length. */
export const PG_NAME_MAX = 63;

/**
 * Sanitize an id into a valid PostgreSQL role name. Short ids stay readable;
 * a name that would exceed 63 chars falls back to a sha256 prefix.
 */
export const sanitizeDbRoleName = (id: string): string => {
	const sanitized = `${DB_ROLE_PREFIX}${id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
	if (sanitized.length <= PG_NAME_MAX) return sanitized;
	const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
	return `${DB_ROLE_PREFIX}${hash}`;
};

/**
 * Sanitize a block id into a PostgreSQL schema name: lowercase, `[a-z0-9_]`,
 * never starting with a digit or `pg_`, at most 63 chars (hash suffix past that).
 */
export const sanitizeSchemaName = (id: string): string => {
	let name = id.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
	if (/^[0-9]/.test(name)) name = `_${name}`;
	if (name.startsWith('pg_')) name = `blocks_${name}`;
	if (name.length <= PG_NAME_MAX) return name;
	const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
	return `${name.slice(0, PG_NAME_MAX - 9)}_${hash}`;
};

/** Quote a PostgreSQL identifier. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Sanitize a full id into a config-key segment (`[A-Za-z0-9_]`). */
export const toEnvName = (fullId: string): string => fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');
