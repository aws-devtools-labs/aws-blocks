// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { escapeRegExp, sanitizeConfigKey } from '@aws-cdk-blocks/core/bb-utils';
import { DEFAULT_DB_CONNECTION_NAME, dbConnectionParameterName } from '@aws-cdk-blocks/core/db-naming';
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

/** `transaction(fn, { retryOnConflict: true })`: how many times the callback is re-run when `maxRetries` is not given. */
export const DEFAULT_MAX_RETRIES = 8;

export const AUTOCOMMIT_CONFLICT_BACKOFF_MS: readonly number[] = [50, 100, 200];

// The wait before a `transaction()` conflict retry: a random time up to a ceiling that doubles from the base
// with each retry and stops at the cap. Writers that conflicted together would otherwise re-run together.
export const TRANSACTION_CONFLICT_BACKOFF_BASE_MS = 50;

export const TRANSACTION_CONFLICT_BACKOFF_CAP_MS = 2000;

/** Local mode: how long a statement waits for the one session while a Kysely transaction holds it. */
export const SESSION_TRANSACTION_WAIT_MS = 5000;

export const TRANSACTION_ROW_LIMIT = 3000;

export const TRANSACTION_SIZE_LIMIT_BYTES = 10 * 1024 * 1024;

export const DEFAULT_CLUSTER_ID = 'default';

/** `db.cluster.id` of a block on an existing database (`DatabaseCluster.fromExisting()`). */
export const EXTERNAL_CLUSTER_ID = 'external';

/** How long a pooled connection to an existing database may sit idle: a pooler counts every open client. */
export const EXTERNAL_IDLE_TIMEOUT_MS = 10 * 1000;

/** How long a connect to an existing database may take before the statement fails as `ConnectionFailed`. */
export const EXTERNAL_CONNECT_TIMEOUT_MS = 10 * 1000;

/** The id of the `AppSetting` a block on an existing database reads its connection string through. */
export const CONNECTION_SETTING_ID = 'connection';

/** The scope of that `AppSetting` in local mode, where the CLI must reach the same entry without the app's scopes. */
export const LOCAL_CONNECTION_SCOPE = 'bb-database';

/**
 * The SSM SecureString that holds the connection string of `DatabaseCluster.fromExisting({ name })`. The stack name
 * makes it one parameter per stage; the CDK layer, the Lambda runtime and the CLI all derive it here.
 */
export const connectionParameterName: (stackName: string, name: string) => string = dbConnectionParameterName;
/** The connection name the command line uses when `--name` is not given. */
export const DEFAULT_CONNECTION_NAME = DEFAULT_DB_CONNECTION_NAME;

/**
 * On an existing database, how long a migration transaction may sit idle before the server ends it. A function
 * or a laptop that stops in the middle of a file leaves its transaction open, and its locks with it, until the
 * server notices; this is the limit the server applies itself.
 */
export const EXTERNAL_MIGRATION_IDLE_TIMEOUT_MS = 60 * 1000;

/** The two bookkeeping tables of the migration runner, which are not tables of the application. */
export const LEDGER_TABLE_NAMES: readonly string[] = ['_migrations', '_migration_progress'];

/** What a connection `name` may contain: it becomes part of an SSM parameter name. */
export const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** The rule of {@link CONNECTION_NAME_PATTERN} in words, for the messages that refuse a name. */
export const CONNECTION_NAME_RULE =
	"must start with a letter or a digit and contain only letters, digits, '.', '_' and '-'";

export const DEFAULT_SCHEMA = 'public';

export const DEFAULT_MIGRATIONS_ROOT = './cdk-blocks/migrations';

const DB_ROLE_PREFIX = 'blocks_app_';

/** Local mode: the role a block's statements run as in PGlite, with the grants the deployed app role gets. */
export const LOCAL_APP_ROLE = `${DB_ROLE_PREFIX}local`;

/**
 * The placeholder a migration file writes for the role the app's statements run as. Every occurrence is
 * replaced before the file runs, with the quoted name: the app role the migration Lambda creates on a cluster
 * the block provisions (`blocks_app_{cluster}`, {@link sanitizeDbRoleName}), `"blocks_app_local"` in local
 * mode, and the connection role on an existing database. One file then grants to the app role in every place
 * it runs: `GRANT authenticated TO ${app_role} WITH INHERIT FALSE, SET TRUE;`.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder a migration file writes, not a template
export const APP_ROLE_PLACEHOLDER = '${app_role}';

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

/**
 * The setting a user-scoped database carries the user's claims in, as JSON, for the length of a transaction
 * (DESIGN §4.5). The name is PostgREST's, so a policy written for it reads the same value here.
 */
export const CLAIMS_SETTING = 'request.jwt.claims';

/** The setting's value for a statement with no user: an object with no `sub`, which a policy can still cast. */
export const NO_CLAIMS = '{}';

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// `public` is a DSQL system entity: it needs no search_path, no CREATE SCHEMA and no schema-level grant.
export const searchPathFor = (schema: string): string | undefined => (schema === DEFAULT_SCHEMA ? undefined : schema);

/** The name `Database` of `@aws-blocks/bb-data` derived from a full id, for its database and its config keys. */
export const legacyName = (fullId: string): string => fullId.replace(/[^a-zA-Z0-9]/g, '_');

// The config keys of a `LegacyDatabaseCluster`, in the form the earlier block used. The CDK layer writes them
// and the Lambda runtime reads them; both sides derive them here.
export const legacyClusterConfigKey = (
	clusterFullId: string,
	suffix: 'CLUSTER_ARN' | 'SECRET_ARN' | 'DATABASE',
): string => `BLOCKS_${legacyName(clusterFullId)}_${suffix}`;

// The config bucket key the CDK layer writes and the Lambda runtime reads; both sides derive it here.
export const clusterConfigKey = (clusterFullId: string, suffix: 'ENDPOINT' | 'REGION'): string =>
	`BLOCKS_${sanitizeConfigKey(clusterFullId)}_${suffix}`;
