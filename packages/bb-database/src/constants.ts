// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { escapeRegExp, sanitizeConfigKey } from '@aws-blocks/core/bb-utils';
import type { ClusterType } from './types.js';

export const MIGRATION_LAMBDA_TIMEOUT_MINUTES = 10;
/** How long one aurora migration transaction may run: the invocation's time less a minute for the report. */
export const AURORA_MIGRATION_TRANSACTION_TIMEOUT_MS = (MIGRATION_LAMBDA_TIMEOUT_MINUTES - 1) * 60 * 1000;

// CloudFormation stops waiting for a custom resource after its ServiceTimeout, at most 3600 s. The provider
// polls for less than that, so a long DSQL job fails the deploy with a message instead of a hung stack.
export const MIGRATION_SERVICE_TIMEOUT_SECONDS = 3600;

// Five minutes of headroom: the provider's last isComplete poll and its failure report must finish before
// CloudFormation gives the resource up.
export const MIGRATION_TOTAL_TIMEOUT_MINUTES = MIGRATION_SERVICE_TIMEOUT_SECONDS / 60 - 5;

export const MIGRATION_POLL_INTERVAL_SECONDS = 30;

export const DEFAULT_POOL_SIZE = 5;

/** The cluster kinds a `DatabaseCluster` accepts; the `cluster` option is checked by this, not by `instanceof`. */
export const isClusterType = (value: unknown): value is ClusterType => value === 'dsql' || value === 'aurora';

/** Aurora Serverless v2 capacity, in ACUs: 0.5 steps up to 256; 0 pauses the cluster after five idle minutes. */
export const DEFAULT_AURORA_MIN_CAPACITY = 0;

export const DEFAULT_AURORA_MAX_CAPACITY = 2;

export const AURORA_MAX_ACU = 256;

/** Aurora backup retention in days when `pointInTimeRecovery` is on without a window; the service allows 1 to 35. */
export const AURORA_BACKUP_DAYS_DEFAULT = 15;

export const AURORA_BACKUP_DAYS_MAX = 35;

/** The environment both migration Lambdas get from the CDK layer (`deploy/cluster-infra.ts`) and read at run time. */
export const CLUSTER_ENV = { kind: 'CLUSTER_KIND', endpoint: 'CLUSTER_ENDPOINT', region: 'CLUSTER_REGION' } as const;

/** The admin of an express cluster; IAM authentication, no password. */
export const AURORA_MASTER_USER = 'postgres';

/** DSQL and Aurora PostgreSQL both listen on 5432 and both default to the `postgres` database. */
export const PG_PORT = 5432;

export const PG_DEFAULT_DATABASE = 'postgres';

export const DEFAULT_MAX_RETRIES = 3;

export const AUTOCOMMIT_CONFLICT_BACKOFF_MS: readonly number[] = [50, 100, 200];

export const TRANSACTION_ROW_LIMIT = 3000;

export const TRANSACTION_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

export const DEFAULT_CLUSTER_ID = 'default';

export const DEFAULT_SCHEMA = 'public';

export const DEFAULT_MIGRATIONS_ROOT = './aws-blocks/migrations';

const DB_ROLE_PREFIX = 'blocks_app_';

// PostgreSQL identifiers and RDS cluster identifiers share the 63-character limit.
const PG_NAME_MAX = 63;

// Keeps `name` within `max` by cutting it and appending a hash of `id`, so two long ids never collide.
const hashSuffixed = (name: string, id: string, separator: string, max = PG_NAME_MAX): string => {
	if (name.length <= max) return name;
	const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
	return `${name.slice(0, max - hash.length - 1).replace(new RegExp(`${escapeRegExp(separator)}$`), '')}${separator}${hash}`;
};

// The express configuration names the writer instance `<cluster>-instance-1`, and an instance identifier is
// limited to 63 characters too, so the cluster identifier leaves room for the suffix.
const AURORA_INSTANCE_SUFFIX = '-instance-1';

/**
 * A DBClusterIdentifier for `fullId`: lower-case letters, digits and hyphens, starting with a letter, no run of
 * hyphens and no trailing one, short enough for the writer instance's name to fit as well.
 */
export const auroraClusterIdentifier = (fullId: string): string => {
	let name = fullId
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (!/^[a-z]/.test(name)) name = `db-${name}`;
	return hashSuffixed(name, fullId, '-', PG_NAME_MAX - AURORA_INSTANCE_SUFFIX.length);
};

export const sanitizeDbRoleName = (id: string): string => {
	const sanitized = `${DB_ROLE_PREFIX}${id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
	if (sanitized.length <= PG_NAME_MAX) return sanitized;
	const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
	return `${DB_ROLE_PREFIX}${hash}`;
};

export const sanitizeSchemaName = (id: string): string => {
	let name = id.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
	if (/^[0-9]/.test(name)) name = `_${name}`;
	if (name.startsWith('pg_')) name = `blocks_${name}`;
	return hashSuffixed(name, id, '_');
};

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// `public` is a DSQL system entity: it needs no search_path, no CREATE SCHEMA and no schema-level grant.
export const searchPathFor = (schema: string): string | undefined => (schema === DEFAULT_SCHEMA ? undefined : schema);

// The config bucket key the CDK layer writes and the Lambda runtime reads; both sides derive it here.
export const clusterConfigKey = (clusterFullId: string, suffix: 'ENDPOINT' | 'REGION'): string =>
	`BLOCKS_${sanitizeConfigKey(clusterFullId)}_${suffix}`;
