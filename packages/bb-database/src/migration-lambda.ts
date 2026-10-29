// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom-resource handlers, one resource per `Database` block: create the
 * block's schema, apply its migrations (read from the S3 asset in the resource
 * properties), and grant the app role DML on the schema.
 *
 * Two handlers share this bundle. `handler` (the provider's `onEvent`) runs the
 * plan until it finishes or reaches a DSQL job that is still running (an index
 * build or a constraint validation). `isComplete` is then polled by the
 * provider, up to its total timeout, and resumes the plan each time; so a long
 * index build is bounded by the provider's two hours, not by one invocation.
 */
import type { DatabaseEngine } from '@aws-blocks/data-common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { quoteIdent } from './constants.js';
import { DsqlEngine } from './engines/dsql-engine.js';
import { DatabaseErrors, pgErrorCode } from './errors.js';
import { buildMigrationPlan } from './migrations/plan.js';
import { ensureMigrationTables, runMigrationPlan } from './migrations/runner.js';

const MAX_RETRIES = 8;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/**
 * True when the cluster is not accepting statements yet (just created, endpoint
 * not reachable), as opposed to a bad statement.
 */
function isRetryableMigrationError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const raw = e.cause instanceof Error ? e.cause : undefined;
	const matches = (err: Error): boolean =>
		err.name === DatabaseErrors.ConnectionFailed ||
		pgErrorCode(err)?.startsWith('08') === true ||
		err.message.includes('Connection terminated') ||
		err.message.includes('ECONNREFUSED') ||
		err.message.includes('ENOTFOUND');
	return matches(e) || (raw !== undefined && matches(raw));
}

/** Exponential backoff while the cluster is unreachable. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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
 * Provision the app's DML-only role on a `dsql` cluster and grant it the
 * block's schema. Idempotent; runs on every deploy so new tables get grants.
 * @internal
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
	// `public` is a DSQL system entity: a schema-level grant on it is rejected, and custom roles can use it without one.
	if (schemaName !== 'public')
		await engine.execute(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(dbRoleName)}`);
	const tables = await engine.query<{ tablename: string }>(
		`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT IN ('_migrations', '_migration_progress')`,
		[schemaName],
	);
	if (tables.length > 0) {
		const list = tables.map((t) => `${quoteIdent(schemaName)}.${quoteIdent(t.tablename)}`).join(', ');
		await engine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${list} TO ${quoteIdent(dbRoleName)}`);
	}
	const views = await engine.query<{ viewname: string }>('SELECT viewname FROM pg_views WHERE schemaname = $1', [
		schemaName,
	]);
	if (views.length > 0) {
		const list = views.map((v) => `${quoteIdent(schemaName)}.${quoteIdent(v.viewname)}`).join(', ');
		await engine.execute(`GRANT SELECT ON ${list} TO ${quoteIdent(dbRoleName)}`);
	}
	const sequences = await engine.query<{ sequencename: string }>(
		'SELECT sequencename FROM pg_sequences WHERE schemaname = $1',
		[schemaName],
	);
	if (sequences.length > 0) {
		const list = sequences.map((s) => `${quoteIdent(schemaName)}.${quoteIdent(s.sequencename)}`).join(', ');
		await engine.execute(`GRANT USAGE, SELECT ON ${list} TO ${quoteIdent(dbRoleName)}`);
	}
	console.log(
		`[bb-database] Role '${dbRoleName}' granted DML on ${tables.length} table(s), ${views.length} view(s), ${sequences.length} sequence(s) in schema '${schemaName}'`,
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

/** The provider's `isComplete` event: the `onEvent` event plus what `onEvent` returned. */
type IsCompleteEvent = CloudFormationCustomResourceEvent & {
	PhysicalResourceId?: string;
	Data?: { migrationsComplete?: string };
};

/** Read a block's migration files from its S3 asset. */
async function loadMigrationsAsset(bucket: string, key: string): Promise<Record<string, string>> {
	const result = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const body = await result.Body?.transformToString();
	return body ? (JSON.parse(body) as Record<string, string>) : {};
}

function buildEngine(schemaName: string): DatabaseEngine {
	const endpoint = process.env.DSQL_ENDPOINT;
	const region = process.env.DSQL_REGION;
	if (!endpoint || !region) throw new Error(`Missing env: DSQL_ENDPOINT=${endpoint}, DSQL_REGION=${region}`);
	const signer = new DsqlSigner({ hostname: endpoint, region });
	return new DsqlEngine({
		endpoint,
		role: 'admin',
		getAuthToken: () => signer.getDbConnectAdminAuthToken(),
		searchPath: schemaName !== 'public' ? schemaName : undefined,
		poolSize: 1,
	});
}

/**
 * One pass over the block's plan: apply what is pending, stop at a running DSQL
 * job, and when everything is applied grant the app role. Returns whether the
 * block is fully migrated.
 */
async function migrateBlock(props: MigrationProperties): Promise<boolean> {
	const schemaName = props.schemaName || 'public';
	const engine = buildEngine(schemaName);
	try {
		if (props.migrationsBucket && props.migrationsKey) {
			// Validated at synth; the dsql-lint binary is not deployed with the Lambda.
			const plan = buildMigrationPlan(await loadMigrationsAsset(props.migrationsBucket, props.migrationsKey), {
				validate: false,
			});
			const result = await withRetry(() => runMigrationPlan(engine, plan, { schemaName }));
			console.log('[bb-database] Applied:', result.applied.length ? result.applied : '(none pending)');
			if (result.waitingOn) {
				console.log(
					`[bb-database] ${result.waitingOn.file} is waiting for DSQL job ${result.waitingOn.jobId}; the provider polls until it finishes`,
				);
				return false;
			}
		} else {
			await withRetry(() => ensureMigrationTables(engine, schemaName));
			console.log('[bb-database] This block has no migrations; schema ensured');
		}
		if (!props.dbRole || !props.appRoleArn) throw new Error('dbRole and appRoleArn are required on a DSQL cluster');
		await withRetry(() => provisionAppRole(engine, props.dbRole as string, props.appRoleArn as string, schemaName));
		return true;
	} finally {
		await engine.destroy().catch((e) => console.error('[bb-database] engine cleanup failed', e));
	}
}

/** The provider's `onEvent` handler. */
export const handler = async (
	event: CloudFormationCustomResourceEvent,
): Promise<{ PhysicalResourceId: string; Data?: { migrationsComplete: string } }> => {
	const props = (event.ResourceProperties ?? {}) as MigrationProperties;
	console.log('[bb-database] Migration event:', JSON.stringify({ RequestType: event.RequestType, ...props }));

	const physicalId = `bb-database-migrations-${props.blockFullId ?? 'unknown'}`;
	// Deleting a block retains its schema under the cluster's removal policy.
	if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId || physicalId };

	const complete = await migrateBlock(props);
	return { PhysicalResourceId: physicalId, Data: { migrationsComplete: String(complete) } };
};

/** The provider's `isComplete` handler: resumes the plan until no DSQL job is left running. */
export const isComplete = async (event: IsCompleteEvent): Promise<{ IsComplete: boolean }> => {
	if (event.RequestType === 'Delete' || event.Data?.migrationsComplete === 'true') return { IsComplete: true };
	const props = (event.ResourceProperties ?? {}) as MigrationProperties;
	return { IsComplete: await migrateBlock(props) };
};
