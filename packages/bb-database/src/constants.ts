// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { sanitizeConfigKey } from '@aws-blocks/core/bb-utils';

export const MIGRATION_LAMBDA_TIMEOUT_MINUTES = 10;

export const MIGRATION_TOTAL_TIMEOUT_MINUTES = 120;

export const MIGRATION_POLL_INTERVAL_SECONDS = 30;

export const DEFAULT_POOL_SIZE = 5;

export const DEFAULT_MAX_RETRIES = 3;

export const AUTOCOMMIT_CONFLICT_BACKOFF_MS: readonly number[] = [50, 100, 200];

export const TRANSACTION_ROW_LIMIT = 3000;

export const TRANSACTION_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

export const DEFAULT_CLUSTER_ID = 'default';

export const DEFAULT_SCHEMA = 'public';

export const DEFAULT_MIGRATIONS_ROOT = './aws-blocks/migrations';

const DB_ROLE_PREFIX = 'blocks_app_';

const PG_NAME_MAX = 63;

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
	if (name.length <= PG_NAME_MAX) return name;
	const hash = createHash('sha256').update(id).digest('hex').slice(0, 8);
	return `${name.slice(0, PG_NAME_MAX - 9)}_${hash}`;
};

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// `public` is a DSQL system entity: it needs no search_path, no CREATE SCHEMA and no schema-level grant.
export const searchPathFor = (schema: string): string | undefined => (schema === DEFAULT_SCHEMA ? undefined : schema);

// The config bucket key the CDK layer writes and the Lambda runtime reads; both sides derive it here.
export const clusterConfigKey = (clusterFullId: string, suffix: 'ENDPOINT' | 'REGION'): string =>
	`BLOCKS_${sanitizeConfigKey(clusterFullId)}_${suffix}`;
