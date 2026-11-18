// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { Signer as RdsSigner } from '@aws-sdk/rds-signer';
import pg from 'pg';
import type { TransactionHandle } from '../common/engine.js';
import {
	CLAIMS_SETTING,
	DEFAULT_POOL_SIZE,
	EXTERNAL_CONNECT_TIMEOUT_MS,
	EXTERNAL_IDLE_TIMEOUT_MS,
	NO_CLAIMS,
	PG_DEFAULT_DATABASE,
	PG_PORT,
	quoteIdent,
} from '../constants.js';
import {
	asError,
	isConnectionLost,
	isSocketReset,
	isStaleSchemaCache,
	pgErrorCode,
	translated,
	translatePgError,
} from '../errors.js';
import type { ConnectionFields } from '../external/connection.js';
import type { ClusterType } from '../types.js';
import {
	type CountedRows,
	EngineTransaction,
	firstStatement,
	isSettled,
	openTransaction,
	type RowCountingEngine,
	setTransactionStatement,
	type TransactionModes,
} from './handle.js';

/** How a connection identifies itself: the cluster, the database role, and whether it is the cluster admin. */
export interface IamAuthOptions {
	kind: ClusterType;
	endpoint: string;
	region: string;
	role: string;
	/** DSQL's `admin` role takes a different token; Aurora's master user takes the same kind of token as any role. */
	admin?: boolean;
}

/**
 * The password callback of a pool: a short-lived IAM token for `role`, signed by one signer for the engine's
 * lifetime so the SDK's credential cache survives from one connection to the next.
 */
export function iamAuthToken(options: IamAuthOptions): () => Promise<string> {
	const { kind, endpoint, region, role, admin } = options;
	if (kind === 'dsql') {
		const signer = new DsqlSigner({ hostname: endpoint, region });
		return admin ? () => signer.getDbConnectAdminAuthToken() : () => signer.getDbConnectAuthToken();
	}
	const signer = new RdsSigner({ hostname: endpoint, port: PG_PORT, region, username: role });
	return () => signer.getAuthToken();
}

/**
 * A `pg` pool on a deployed cluster. Both kinds have the same connection contract: port 5432, the `postgres`
 * database, TLS against the public Amazon roots (DSQL and the express configuration's internet access gateway
 * both present Amazon Trust Services certificates), and an IAM token as the password, fetched per connection.
 */
export interface ClusterPgEngineConfig {
	kind: ClusterType;
	endpoint: string;
	getAuthToken: () => Promise<string>;
	poolSize?: number;
	role: string;
	searchPath?: string;
	/** @internal A stand-in for the pg pool; tests use it. */
	pool?: PgPool;
}

/**
 * A `pg` pool on an existing PostgreSQL database (`DatabaseCluster.fromExisting()`). The driver gets the fields
 * of the connection string one by one and never the string: pg merges a string over the programmatic config, so
 * a parameter in it could replace or switch off the TLS settings below. The server certificate is verified on
 * every connection, against `ca` when given and against Node's trust store otherwise.
 */
export interface ExternalPgEngineConfig {
	kind: 'external';
	connection: ConnectionFields;
	/** PEM text of the certificate authority that signed the server certificate. */
	ca?: string;
	poolSize?: number;
	searchPath?: string;
	/** @internal A stand-in for the pg pool; tests use it. */
	pool?: PgPool;
}

export type PgEngineConfig = ClusterPgEngineConfig | ExternalPgEngineConfig;

const INT8_OID = 20;

/**
 * @internal pg returns `bigint` as a string; PGlite returns a number (or a BigInt past the safe range). Without
 * this, every identity column, `count(*)` and `sum()` would be a number locally and a string on the cluster.
 */
export function parseInt8(text: string): number | bigint {
	const big = BigInt(text);
	const num = Number(big);
	return Number.isSafeInteger(num) ? num : big;
}

/** @internal */
export const pgTypeParsers: pg.CustomTypesConfig = {
	getTypeParser: (oid: number, format?: 'text' | 'binary') =>
		oid === INT8_OID && format !== 'binary' ? parseInt8 : pg.types.getTypeParser(oid, format),
};

interface Queryable {
	query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
}

/** @internal The part of `pg.PoolClient` the engine uses. */
export interface PgPoolClient extends Queryable {
	release(err?: Error): void;
	on?(event: 'error', listener: (e: Error) => void): unknown;
	removeListener?(event: 'error', listener: (e: Error) => void): unknown;
}

/** @internal The part of `pg.Pool` the engine uses. */
export interface PgPool extends Queryable {
	connect(): Promise<PgPoolClient>;
	end(): Promise<void>;
}

// How long a pooled connection may sit idle. A warm Lambda invocation is usually more than pg-pool's 10 s default
// apart, and a dropped DSQL connection costs TLS, a token and the SET again, so DSQL keeps one for five minutes.
// An Aurora cluster at minCapacity 0 cannot pause while any client connection is open, so there a connection is
// let go seconds after its last statement; the next invocation pays the reconnect, the idle cluster pays nothing.
const IDLE_TIMEOUT_MS: Record<ClusterType, number> = { dsql: 5 * 60 * 1000, aurora: 10 * 1000 };

// Under the Lambda handler's deadline (~28 s): a paused Aurora cluster resumes in about 18 s; past this the statement
// fails as ConnectionFailed (retriable) instead of running after the caller has already been answered.
const CONNECT_TIMEOUT_MS = 25 * 1000;

// An idle pooled client's error is re-emitted on the pool; unhandled, it would end the process.
function watched(pool: pg.Pool): pg.Pool {
	pool.on('error', (e) =>
		console.warn(`[${ENGINE}] idle connection closed`, { code: pgErrorCode(e), message: e.message }),
	);
	return pool;
}

/** @internal What the pool of an existing database is built with; a test reads it. */
export function externalPoolConfig(config: ExternalPgEngineConfig): pg.PoolConfig {
	const { host, port, user, password, database } = config.connection;
	const searchPath = config.searchPath;
	return {
		host,
		port,
		user,
		password,
		database,
		// Always an object or `true`: with `ssl` undefined pg reads PGSSLMODE, which can turn verification off.
		ssl: config.ca ? { ca: config.ca } : true,
		max: config.poolSize ?? DEFAULT_POOL_SIZE,
		idleTimeoutMillis: EXTERNAL_IDLE_TIMEOUT_MS,
		connectionTimeoutMillis: EXTERNAL_CONNECT_TIMEOUT_MS,
		types: pgTypeParsers,
		// A session setting: it holds on a direct connection and on a session pooler. A transaction pooler
		// does not keep it (README, "Existing database"), which is why `public` needs none.
		onConnect: searchPath ? (client) => client.query(`SET search_path TO ${quoteIdent(searchPath)}`) : undefined,
	};
}

function createExternalPool(config: ExternalPgEngineConfig): PgPool {
	return watched(new pg.Pool(externalPoolConfig(config)));
}

function createPool(config: PgEngineConfig): PgPool {
	if (config.kind === 'external') return createExternalPool(config);
	const searchPath = config.searchPath;
	const onConnect = [
		searchPath && `SET search_path TO ${quoteIdent(searchPath)}`,
		// The value a statement with no user sees. Without a session value, a connection that a user-scoped
		// transaction has used reports an empty string, which a policy cannot cast to jsonb (DESIGN §4.5).
		config.kind === 'aurora' && `SELECT set_config('${CLAIMS_SETTING}', '${NO_CLAIMS}', false)`,
	]
		.filter(Boolean)
		.join('; ');
	return watched(
		new pg.Pool({
			host: config.endpoint,
			port: PG_PORT,
			user: config.role,
			database: PG_DEFAULT_DATABASE,
			ssl: true,
			max: config.poolSize ?? DEFAULT_POOL_SIZE,
			idleTimeoutMillis: IDLE_TIMEOUT_MS[config.kind],
			connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
			// DSQL ends a connection after 60 minutes, so the pool retires it first; harmless on Aurora.
			maxLifetimeSeconds: 3300,
			password: config.getAuthToken,
			types: pgTypeParsers,
			// pg-pool awaits the hook: a SET that fails fails that connect, and the statement waiting on it reports it.
			onConnect: onConnect ? (client) => client.query(onConnect) : undefined,
		}),
	);
}

const ENGINE = 'PgEngine';

const translate = translated(ENGINE);

// The server answered, so the connection is intact; anything else came from the socket.
const isServerError = (e: unknown): boolean => e instanceof pg.DatabaseError;

// While a client is checked out, pg-pool no longer listens for its errors. A connection that the server or a
// pooler ends between two statements of a transaction then emits `error` on the client, and Node ends the process
// for an `error` event nobody handles. This listener holds for the life of the transaction; the next statement on
// the client fails and is reported as a lost connection.
const onClientError = (e: Error): void =>
	console.warn(`[${ENGINE}] connection closed inside a transaction`, { code: pgErrorCode(e), message: e.message });

// Settling the handle returns the client to the pool exactly once.
class PgTransaction extends EngineTransaction {
	constructor(readonly client: PgPoolClient) {
		super();
		client.on?.('error', onClientError);
	}

	/** Returns the client to the pool; with `err` the pool discards it. */
	release(err?: Error): void {
		this.client.removeListener?.('error', onClientError);
		this.client.release(err);
	}
}

const open = (handle: TransactionHandle): PgTransaction => openTransaction(handle, PgTransaction, ENGINE);

// A statement on a handle's client: inside a transaction the server has already aborted the transaction when it
// reports an error, so nothing is retried here; a retry would fail with 25P02 (in_failed_sql_transaction) and turn a
// retriable SerializationFailure into a QueryFailed. The error surfaces as is, and the caller retries the transaction.
const statement = (client: Queryable, sql: string, params?: unknown[]): Promise<pg.QueryResult> =>
	translate(() => client.query(sql, params));

// An autocommit statement on the pool is safe to run once more: a stale schema cache (OC001, see isStaleSchemaCache) is
// refreshed by the retry, and a connection the server closed while it sat idle (or an Aurora cluster that paused and
// resumed) is replaced by the pool on the retry. A socket that was reset under the statement is not such a case:
// the server may have run the statement already.
const retriedOnce = (e: unknown): boolean => isStaleSchemaCache(e) || (isConnectionLost(e) && !isSocketReset(e));

const pooledStatement = (pool: Queryable, sql: string, params?: unknown[]): Promise<pg.QueryResult> =>
	translate(() =>
		pool.query(sql, params).catch((e) => (retriedOnce(e) ? pool.query(sql, params) : Promise.reject(e))),
	);

// pg's `rowCount` is the rows changed for these commands and the rows returned for a query.
const CHANGES_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

const counted = <T>(result: pg.QueryResult): CountedRows<T> => ({
	rows: result.rows,
	rowCount: CHANGES_ROWS.has(result.command) ? (result.rowCount ?? 0) : 0,
});

export class PgEngine implements RowCountingEngine {
	private readonly pool: PgPool;

	constructor(config: PgEngineConfig) {
		this.pool = config.pool ?? createPool(config);
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return (await pooledStatement(this.pool, sql, params)).rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return { rowCount: (await pooledStatement(this.pool, sql, params)).rowCount ?? 0 };
	}

	async queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		return counted(await pooledStatement(this.pool, sql, params));
	}

	// A BEGIN on a connection the server closed while it sat idle is tried once more, on a fresh connection,
	// as an auto-commit statement is: nothing has run yet.
	private async begin(retry = true): Promise<PgPoolClient> {
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
			return client;
		} catch (e) {
			client.release(asError(e));
			if (retry && isConnectionLost(e)) return this.begin(false);
			throw e;
		}
	}

	async beginTransaction(modes?: TransactionModes): Promise<TransactionHandle> {
		const settings = setTransactionStatement(modes);
		const tx = await translate(async () => new PgTransaction(await this.begin()));
		if (settings) await firstStatement(this, tx, settings);
		return tx;
	}

	// A COMMIT that fails has rolled the transaction back on the server, so the handle is settled either
	// way and the client goes back to the pool here; the rollback DatabaseCore issues next is a no-op.
	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const tx = open(handle);
		tx.settled = true;
		try {
			await tx.client.query('COMMIT');
		} catch (e) {
			tx.release(isServerError(e) ? undefined : asError(e));
			translatePgError(e, ENGINE);
		}
		tx.release();
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		if (isSettled(handle)) return;
		const tx = open(handle);
		tx.settled = true;
		try {
			await tx.client.query('ROLLBACK');
			tx.release();
		} catch (e) {
			// The connection's state is unknown after a failed ROLLBACK: the pool discards it.
			tx.release(asError(e));
			console.error(`[${ENGINE}] rollback failed`, { code: pgErrorCode(e) });
		}
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		return (await statement(open(handle).client, sql, params)).rows;
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		return { rowCount: (await statement(open(handle).client, sql, params)).rowCount ?? 0 };
	}

	async queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>> {
		return counted(await statement(open(handle).client, sql, params));
	}

	async destroy(): Promise<void> {
		await this.pool.end();
	}
}
