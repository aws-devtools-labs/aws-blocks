// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';

/**
 * Shared constants for the bb-distributed-data package.
 */

/**
 * Path where migration .sql files are bundled inside the Lambda deployment package.
 * Used by both the CDK construct (to set the env var + copy files) and the
 * migration Lambda handler (to read files at runtime).
 */
export const LAMBDA_MIGRATIONS_DIR = '/var/task/migrations';

/**
 * Migration Lambda timeout. Set to 5 minutes to allow for large migration sets
 * and DSQL cluster warm-up time on first connection after creation.
 */
export const MIGRATION_LAMBDA_TIMEOUT_MINUTES = 5;

/**
 * Default connection pool size for DSQL. Kept small because Lambda concurrency
 * means each instance handles few concurrent requests, and DSQL connections
 * are lightweight (no VPC, no proxy needed).
 */
export const DEFAULT_POOL_SIZE = 5;

/**
 * Default max retry attempts for OCC conflicts when retryOnConflict is enabled.
 */
export const DEFAULT_MAX_RETRIES = 3;

// Env var names must be [A-Z0-9_]. The fullId may contain hyphens/dots (e.g., "my-app.dsql").
export const ENV_SANITIZE = /[^a-zA-Z0-9]/g;

/**
 * Prefix for the custom database role created for the app Lambda.
 * The full role name is `blocks_app_{sanitized_id}`.
 * PostgreSQL role names are case-insensitive and limited to 63 chars (NAMEDATALEN - 1).
 */
export const DB_ROLE_PREFIX = 'blocks_app_';

/** Max PostgreSQL identifier length. */
const PG_NAME_MAX = 63;

/**
 * Sanitize a block ID into a valid PostgreSQL role name.
 * Short IDs stay human-readable. If the name would exceed 63 chars,
 * a sha256 hash of the original ID is used to guarantee uniqueness.
 */
export const sanitizeDbRoleName = (id: string): string => {
  const sanitized = `${DB_ROLE_PREFIX}${id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
  if (sanitized.length <= PG_NAME_MAX) return sanitized;
  // Long ID — use a hash to avoid collisions from naive truncation
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
  return `${DB_ROLE_PREFIX}${hash}`;
};

/**
 * Name of the Kinesis data stream that receives a database's CDC records.
 * The CDK layer creates it and the runtime matches incoming records by it, so
 * both derive it from `fullId` the same way. Kinesis allows 128 characters.
 */
export const cdcStreamName = (fullId: string): string => {
  const name = `${fullId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-cdc`;
  if (name.length <= 128) return name;
  const hash = createHash('sha256').update(fullId).digest('hex').slice(0, 12);
  return `${name.slice(0, 111)}-${hash}-cdc`;
};

/** Child id of the Realtime block that carries shape bells. */
export const SYNC_BELL_ID = 'sync-bell';

/** Child id of the DistributedTable that indexes bell routes (equality routing). */
export const SYNC_ROUTES_ID = 'sync-routes';

/** Child id of the AppSetting that holds the shape-token signing secret. */
export const SYNC_TOKEN_SECRET_ID = 'sync-token-secret';

/** Bell channel for a synced table (`app.todos` → `app-todos`). */
export const bellChannel = (table: string): string => table.replace('.', '-');
