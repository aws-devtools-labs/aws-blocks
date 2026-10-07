// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom-resource handler, one invocation per `Database` block: creates the
 * block's schema, applies its migrations (read from the S3 asset in the
 * resource properties), and on `distributed` grants the app role DML on it.
 */
import type { DatabaseEngine } from '@aws-blocks/data-common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { quoteIdent } from './constants.js';
import { DataApiEngine } from './engines/data-api-engine.js';
import { DsqlEngine } from './engines/dsql-engine.js';
import { DatabaseErrors, pgErrorCode, TRANSIENT_DATA_API_ERROR_NAMES } from './errors.js';
import { buildMigrationPlan } from './migrations/plan.js';
import { ensureMigrationTables, runMigrationPlan } from './migrations/runner.js';
import type { ClusterKind } from './types.js';

const MAX_RETRIES = 8;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/**
 * True when the cluster is not accepting statements yet (just created, resuming
 * from scale-to-zero, endpoint not reachable), as opposed to a bad statement.
 */
export function isRetryableMigrationError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const raw = e.cause instanceof Error ? e.cause : undefined;
	const matches = (err: Error): boolean =>
		err.name === DatabaseErrors.ConnectionFailed ||
		TRANSIENT_DATA_API_ERROR_NAMES.has(err.name) ||
		err.name === 'BadRequestException' ||
		pgErrorCode(err)?.startsWith('08') === true ||
		err.message.includes('Communications link failure') ||
		err.message.includes('Connection terminated') ||
		err.message.includes('ECONNREFUSED') ||
		err.message.includes('ENOTFOUND');
	return matches(e) || (raw !== undefined && matches(raw));
}

/** Exponential backoff while the cluster is unreachable. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (!isRetryableMigrationError(e) || attempt === MAX_RETRIES) throw e;
			const delay = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
			console.log(
				`[bb-database] Cluster not ready (${e instanceof Error ? e.name : 'unknown'}), retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
			);
			await new Promise((r) => setTimeout(r, delay));
		}
	}
	throw new Error('unreachable');
}

function escapeString(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * Provision the app's DML-only role on a `distributed` cluster and grant it the
 * block's schema. Idempotent; runs on every deploy so new tables get grants.
 */
export async function provisionAppRole(
	engine: DatabaseEngine,
	dbRoleName: string,
	appRoleArn: string,
	schemaName: string,
): Promise<void> {
	const existing = await engine.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = $1', [
		dbRoleName,
	]);
	if (existing.length === 0) {
		try {
			await engine.execute(`CREATE ROLE ${quoteIdent(dbRoleName)} WITH LOGIN`);
		} catch (e) {
			// Another block's resource may have created it between the check and the create.
			if (pgErrorCode(e instanceof Error && e.cause instanceof Error ? e.cause : e) !== '42710') throw e;
		}
	}
	await engine.execute(`AWS IAM GRANT ${quoteIdent(dbRoleName)} TO '${escapeString(appRoleArn)}'`);
	await engine.execute(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(dbRoleName)}`);
	const tables = await engine.query<{ tablename: string }>(
		`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT IN ('_migrations', '_migration_progress')`,
		[schemaName],
	);
	if (tables.length > 0) {
		const list = tables.map((t) => `${quoteIdent(schemaName)}.${quoteIdent(t.tablename)}`).join(', ');
		await engine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${list} TO ${quoteIdent(dbRoleName)}`);
	}
	console.log(
		`[bb-database] Role '${dbRoleName}' granted DML on ${tables.length} table(s) in schema '${schemaName}'`,
	);
}

interface MigrationProperties {
	schemaName?: string;
	blockFullId?: string;
	dbRole?: string;
	appRoleArn?: string;
	migrationsHash?: string;
	migrationsBucket?: string;
	migrationsKey?: string;
}

/** Read a block's migration files from its S3 asset. */
async function loadMigrationsAsset(bucket: string, key: string): Promise<Record<string, string>> {
	const result = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const body = await result.Body?.transformToString();
	return body ? (JSON.parse(body) as Record<string, string>) : {};
}

function buildEngine(kind: ClusterKind, schemaName: string): DatabaseEngine {
	if (kind === 'distributed') {
		const endpoint = process.env.DSQL_ENDPOINT;
		const region = process.env.DSQL_REGION;
		if (!endpoint || !region) throw new Error(`Missing env: DSQL_ENDPOINT=${endpoint}, DSQL_REGION=${region}`);
		const signer = new DsqlSigner({ hostname: endpoint, region });
		return new DsqlEngine({
			endpoint,
			region,
			role: 'admin',
			getAuthToken: () => signer.getDbConnectAdminAuthToken(),
			searchPath: schemaName !== 'public' ? schemaName : undefined,
			poolSize: 1,
		});
	}
	const resourceArn = process.env.CLUSTER_ARN;
	const secretArn = process.env.SECRET_ARN;
	const database = process.env.DATABASE_NAME;
	if (!resourceArn || !secretArn || !database) throw new Error('Missing env: CLUSTER_ARN, SECRET_ARN, DATABASE_NAME');
	return new DataApiEngine({ resourceArn, secretArn, database, schema: schemaName });
}

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> => {
	const props = (event.ResourceProperties ?? {}) as MigrationProperties;
	console.log('[bb-database] Migration event:', JSON.stringify({ RequestType: event.RequestType, ...props }));

	const physicalId = `bb-database-migrations-${props.blockFullId ?? 'unknown'}`;
	// Deleting a block retains its schema under the cluster's removal policy.
	if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId || physicalId };

	const kind = (process.env.CLUSTER_KIND ?? 'distributed') as ClusterKind;
	const schemaName = props.schemaName || 'public';
	const engine = buildEngine(kind, schemaName);
	try {
		if (props.migrationsBucket && props.migrationsKey) {
			const plan = buildMigrationPlan(
				await loadMigrationsAsset(props.migrationsBucket, props.migrationsKey),
				kind,
			);
			const applied = await withRetry(() => runMigrationPlan(engine, plan, { schemaName }));
			console.log('[bb-database] Applied:', applied.length ? applied : '(none pending)');
		} else {
			await withRetry(() => ensureMigrationTables(engine, schemaName));
			console.log('[bb-database] This block has no migrations; schema ensured');
		}
		if (kind === 'distributed') {
			if (!props.dbRole || !props.appRoleArn)
				throw new Error('dbRole and appRoleArn are required on a distributed cluster');
			await withRetry(() =>
				provisionAppRole(engine, props.dbRole as string, props.appRoleArn as string, schemaName),
			);
		}
		return { PhysicalResourceId: physicalId };
	} finally {
		await engine.destroy().catch((e) => console.error('[bb-database] engine cleanup failed', e));
	}
};
