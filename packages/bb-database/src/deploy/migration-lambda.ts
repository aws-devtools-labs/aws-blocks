// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import type { DatabaseEngine } from '../common/engine.js';
import {
	AURORA_MASTER_USER,
	CLUSTER_ENV,
	DEFAULT_SCHEMA,
	isClusterType,
	quoteIdent,
	searchPathFor,
} from '../constants.js';
import { dataApiEngine } from '../engines/handle.js';
import { iamAuthToken, PgEngine } from '../engines/pg-engine.js';
import {
	causeChain,
	DatabaseErrors,
	isConnectionLost,
	isConnectionRefused,
	isConnectTimeout,
	isRefusedForNow,
	isSerializationConflict,
	sqlStateOf,
} from '../errors.js';
import { parseConnectionString } from '../external/connection.js';
import { externalEngine } from '../external/engine.js';
import { decodeStoredValue, readSsmConnectionString } from '../external/ssm-store.js';
import { grantSchemaAccess } from '../migrations/grants.js';
import { buildMigrationPlan, connectionRole } from '../migrations/plan.js';
import { ensureMigrationTables, runMigrationPlan } from '../migrations/runner.js';
import type { ClusterType, DataApiOptions } from '../types.js';

const MAX_RETRIES = 8;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/** @internal A lost connection, a cluster still starting, or a serialization conflict; the run resumes from its progress rows. */
export function isRetryableMigrationError(e: unknown): boolean {
	const matches = (err: Error): boolean =>
		err.name === DatabaseErrors.ConnectionFailed ||
		isSerializationConflict(err) ||
		isConnectionLost(err) ||
		isConnectTimeout(err);
	// The runner wraps the engine's error, which wraps the driver's: walk the chain. A connection the server
	// refused for good (trust, address, login) gets the same answer on every attempt, so it is reported at once.
	// A refusal that passes (a full or starting server, a lookup that timed out) is tried again.
	const chain = causeChain(e);
	const refusedForGood = chain.some((err) => isConnectionRefused(err) && !isRefusedForNow(err));
	return !refusedForGood && chain.some((err) => matches(err) || isRefusedForNow(err));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			return await fn();
		} catch (e) {
			if (!isRetryableMigrationError(e) || attempt === MAX_RETRIES) throw e;
			const delay = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
			console.log(
				`[bb-database] Retrying migration run after ${e instanceof Error ? e.name : 'unknown'}: attempt ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`,
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
 * @internal Idempotent and run on every deploy. The role is mapped to IAM the way each engine spells it: DSQL's
 * `AWS IAM GRANT` names the execution role's ARN; Aurora's `rds_iam` membership lets the role log in with any
 * token for its name, and the `rds-db:connect` grant on the execution role (cluster-infra.ts) decides who gets
 * one.
 *
 * The first half of what the app role gets, run before the migration plan ({@link migrateCluster}): the role
 * exists while the migrations run, so a file can grant to it (`GRANT authenticated TO ${app_role}`, for
 * `asRole()`) on the first deploy as on every later one.
 */
export async function ensureAppRole(
	engine: DatabaseEngine,
	kind: ClusterType,
	dbRoleName: string,
	appRoleArn: string,
): Promise<void> {
	const existing = await engine.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = $1', [
		dbRoleName,
	]);
	if (existing.length === 0) {
		try {
			await engine.execute(`CREATE ROLE ${quoteIdent(dbRoleName)} WITH LOGIN`);
		} catch (e) {
			// Another block's resource may have created it between the check and the create.
			if (sqlStateOf(e) !== '42710') throw e;
		}
	}
	if (kind === 'dsql')
		await engine.execute(`AWS IAM GRANT ${quoteIdent(dbRoleName)} TO '${escapeString(appRoleArn)}'`);
	else await engine.execute(`GRANT rds_iam TO ${quoteIdent(dbRoleName)}`);
}

/**
 * @internal The second half, run after the migration plan has finished: the grants on the schema's objects,
 * which the migrations create. Idempotent and run on every deploy, so tables a new migration adds get their
 * grants.
 */
export async function grantAppRole(engine: DatabaseEngine, dbRoleName: string, schemaName: string): Promise<void> {
	const granted = await grantSchemaAccess(engine, dbRoleName, schemaName);
	console.log(
		`[bb-database] Role '${dbRoleName}' granted DML on ${granted.tables} table(s), ${granted.views} view(s), ${granted.matviews} materialized view(s), ${granted.sequences} sequence(s) in schema '${schemaName}'`,
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
	/** An existing database: the SSM SecureString that holds the connection string. The name, never the value. */
	connectionParameter?: string;
	/** An existing database: the Secrets Manager secret that holds the connection string. */
	connectionSecretArn?: string;
	/**
	 * A database that is reached through the RDS Data API: the cluster, the secret and the database name. They
	 * name the database and are not credentials.
	 */
	dataApi?: DataApiOptions;
}

type IsCompleteEvent = CloudFormationCustomResourceEvent & {
	PhysicalResourceId?: string;
	Data?: { migrationsComplete?: string };
};

async function loadMigrationsAsset(bucket: string, key: string): Promise<Record<string, string>> {
	const result = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
	const body = await result.Body?.transformToString();
	return body ? (JSON.parse(body) as Record<string, string>) : {};
}

interface ClusterEnv {
	kind: ClusterType;
	endpoint: string;
	region: string;
}

function readClusterEnv(): ClusterEnv {
	const kind = process.env[CLUSTER_ENV.kind];
	const endpoint = process.env[CLUSTER_ENV.endpoint];
	const region = process.env[CLUSTER_ENV.region];
	if (!isClusterType(kind) || !endpoint || !region) {
		throw new Error(
			`Missing env: ${CLUSTER_ENV.kind}=${kind}, ${CLUSTER_ENV.endpoint}=${endpoint}, ${CLUSTER_ENV.region}=${region}`,
		);
	}
	return { kind, endpoint, region };
}

// The cluster admin: DSQL's `admin` through its admin token, Aurora's master user through an RDS IAM token (the
// express configuration creates the master user with IAM authentication and no password).
function buildEngine(cluster: ClusterEnv, schemaName: string): DatabaseEngine {
	const { kind, endpoint, region } = cluster;
	const role = kind === 'dsql' ? 'admin' : AURORA_MASTER_USER;
	return new PgEngine({
		kind,
		endpoint,
		role,
		getAuthToken: iamAuthToken({ kind, endpoint, region, role, admin: true }),
		searchPath: searchPathFor(schemaName),
		poolSize: 1,
	});
}

// The connection string of an existing database, read where `npm run db -- connect --stage` (or the app) put it.
// It is held in memory for this invocation and never logged. The SDK clients are loaded here: a migration
// function of a cluster the block provisions never reads one.
async function readConnectionString(props: MigrationProperties): Promise<{ value: string | null; label: string }> {
	if (props.connectionParameter) return readSsmConnectionString(props.connectionParameter);
	if (props.connectionSecretArn) {
		const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
		const result = await new SecretsManagerClient({}).send(
			new GetSecretValueCommand({ SecretId: props.connectionSecretArn }),
		);
		return { value: decodeStoredValue(result.SecretString), label: 'The secret that holds the connection string' };
	}
	throw new Error('connectionParameter or connectionSecretArn is required for an existing database');
}

interface ExternalAsset {
	files: Record<string, string>;
	ca?: string;
}

// An existing database: no cluster admin and no app role to provision. The function reaches the database as the
// app does, with the stored connection string or through the Data API, and runs each pending file in one
// transaction. The role it connects as exists before the files run, so a file can grant to it from the first
// deploy: there is no ordering to get right here.
async function migrateExternal(props: MigrationProperties): Promise<boolean> {
	if (!props.migrationsBucket || !props.migrationsKey)
		throw new Error('migrationsBucket and migrationsKey are required');
	const schemaName = props.schemaName || DEFAULT_SCHEMA;
	const [object, stored] = await Promise.all([
		new S3Client({}).send(new GetObjectCommand({ Bucket: props.migrationsBucket, Key: props.migrationsKey })),
		props.dataApi ?? readConnectionString(props),
	]);
	const asset = JSON.parse((await object.Body?.transformToString()) ?? '{"files":{}}') as ExternalAsset;
	const engine =
		'clusterArn' in stored
			? await dataApiEngine(stored)
			: externalEngine(parseConnectionString(stored.value, stored.label), {
					ca: asset.ca,
					schemaName,
					poolSize: 1,
				});
	try {
		// `${app_role}` is the role of the connection string, which the app connects as too.
		const result = await withRetry(async () =>
			runMigrationPlan(engine, buildMigrationPlan(asset.files, 'external', await connectionRole(engine)), {
				schemaName,
				boundToInvocation: true,
			}),
		);
		console.log('[bb-database] Applied:', result.applied.length ? result.applied : '(none pending)');
		return true;
	} finally {
		await engine.destroy().catch((e) => console.error('[bb-database] engine cleanup failed', e));
	}
}

/**
 * @internal What one invocation does on a cluster the block provisions, with the admin engine it is given.
 * The app role is created and mapped to IAM before the plan runs, so a migration can grant to it, and gets its
 * grants on the schema's objects after the plan has finished, when the tables exist. Both halves are
 * idempotent: an invocation that resumes a file after a failure, or that polls a DSQL job (`false`: the plan
 * is waiting), runs the first half again and finds the role in place.
 */
export async function migrateCluster(
	engine: DatabaseEngine,
	kind: ClusterType,
	files: Record<string, string> | undefined,
	role: { dbRole: string; appRoleArn: string },
	schemaName: string,
): Promise<boolean> {
	await withRetry(() => ensureAppRole(engine, kind, role.dbRole, role.appRoleArn));
	if (files) {
		// A dsql file was linted at synth; the dsql-lint binary is not deployed with the Lambda.
		const plan = buildMigrationPlan(files, kind, quoteIdent(role.dbRole));
		const result = await withRetry(() => runMigrationPlan(engine, plan, { schemaName, boundToInvocation: true }));
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
	await withRetry(() => grantAppRole(engine, role.dbRole, schemaName));
	return true;
}

async function migrateBlock(props: MigrationProperties): Promise<boolean> {
	if (process.env[CLUSTER_ENV.kind] === 'external') return migrateExternal(props);
	const schemaName = props.schemaName || DEFAULT_SCHEMA;
	const cluster = readClusterEnv();
	const { dbRole, appRoleArn } = props;
	if (!dbRole || !appRoleArn) throw new Error('dbRole and appRoleArn are required');
	const engine = buildEngine(cluster, schemaName);
	try {
		const files =
			props.migrationsBucket && props.migrationsKey
				? await loadMigrationsAsset(props.migrationsBucket, props.migrationsKey)
				: undefined;
		return await migrateCluster(engine, cluster.kind, files, { dbRole, appRoleArn }, schemaName);
	} finally {
		await engine.destroy().catch((e) => console.error('[bb-database] engine cleanup failed', e));
	}
}

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

export const isComplete = async (event: IsCompleteEvent): Promise<{ IsComplete: boolean }> => {
	if (event.RequestType === 'Delete' || event.Data?.migrationsComplete === 'true') return { IsComplete: true };
	const props = (event.ResourceProperties ?? {}) as MigrationProperties;
	return { IsComplete: await migrateBlock(props) };
};
