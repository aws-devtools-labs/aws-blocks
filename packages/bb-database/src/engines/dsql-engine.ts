// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import pg from 'pg';
import { DEFAULT_POOL_SIZE, quoteIdent } from '../constants.js';
import { asError, isConnectionLost, isStaleSchemaCache, pgErrorCode, translated, translatePgError } from '../errors.js';
import { EngineTransaction, isSettled, openTransaction } from './handle.js';

interface DsqlEngineConfig {
	endpoint: string;
	getAuthToken: () => Promise<string>;
	poolSize?: number;
	role: string;
	searchPath?: string;
	/** @internal A stand-in for the pg pool; tests use it. */
	pool?: DsqlPool;
}

const INT8_OID = 20;

/**
 * @internal pg returns `bigint` as a string; PGlite returns a number (or a BigInt past the safe range). Without
 * this, every identity column, `count(*)` and `sum()` would be a number locally and a string on DSQL.
 */
export function parseInt8(text: string): number | bigint {
	const big = BigInt(text);
	const num = Number(big);
	return Number.isSafeInteger(num) ? num : big;
}

/** @internal */
export const dsqlTypeParsers: pg.CustomTypesConfig = {
	getTypeParser: (oid: number, format?: 'text' | 'binary') =>
		oid === INT8_OID && format !== 'binary' ? parseInt8 : pg.types.getTypeParser(oid, format),
};

interface Queryable {
	query(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
}

/** @internal The part of `pg.PoolClient` the engine uses. */
export interface DsqlPoolClient extends Queryable {
	release(err?: Error): void;
}

/** @internal The part of `pg.Pool` the engine uses. */
export interface DsqlPool extends Queryable {
	connect(): Promise<DsqlPoolClient>;
	end(): Promise<void>;
}

function createPool(config: DsqlEngineConfig): DsqlPool {
	const searchPath = config.searchPath;
	// DSQL clusters have a fixed connection contract: port 5432, database 'postgres', TLS required.
	return new pg.Pool({
		host: config.endpoint,
		port: 5432,
		user: config.role,
		database: 'postgres',
		ssl: true,
		max: config.poolSize ?? DEFAULT_POOL_SIZE,
		// A warm Lambda invocation is usually more than pg-pool's 10 s idle default apart; a dropped connection costs
		// TLS, a token and the SET again. DSQL ends a connection after 60 minutes, so the pool retires it first.
		idleTimeoutMillis: 5 * 60 * 1000,
		maxLifetimeSeconds: 3300,
		password: config.getAuthToken,
		types: dsqlTypeParsers,
		// pg-pool awaits the hook: a SET that fails fails that connect, and the statement waiting on it reports it.
		onConnect: searchPath ? (client) => client.query(`SET search_path TO ${quoteIdent(searchPath)}`) : undefined,
	});
}

const translate = translated('DsqlEngine');

// The server answered, so the connection is intact; anything else came from the socket.
const isServerError = (e: unknown): boolean => e instanceof pg.DatabaseError;

// Settling the handle returns the client to the pool exactly once.
class DsqlTransaction extends EngineTransaction {
	constructor(readonly client: DsqlPoolClient) {
		super();
	}
}

const open = (handle: TransactionHandle): DsqlTransaction => openTransaction(handle, DsqlTransaction, 'DsqlEngine');

// A statement on a handle's client: inside a transaction the server has already aborted the transaction when it
// reports an error, so nothing is retried here; a retry would fail with 25P02 (in_failed_sql_transaction) and turn a
// retriable SerializationFailure into a QueryFailed. The error surfaces as is, and the caller retries the transaction.
const statement = (client: Queryable, sql: string, params?: unknown[]): Promise<pg.QueryResult> =>
	translate(() => client.query(sql, params));

// An autocommit statement on the pool is safe to run once more: a stale schema cache (OC001, see isStaleSchemaCache) is
// refreshed by the retry, and a connection the server closed while it sat idle is replaced by the pool on the retry.
const retriedOnce = (e: unknown): boolean => isStaleSchemaCache(e) || isConnectionLost(e);

const pooledStatement = (pool: Queryable, sql: string, params?: unknown[]): Promise<pg.QueryResult> =>
	translate(() =>
		pool.query(sql, params).catch((e) => (retriedOnce(e) ? pool.query(sql, params) : Promise.reject(e))),
	);

export class DsqlEngine implements DatabaseEngine {
	private readonly pool: DsqlPool;

	constructor(config: DsqlEngineConfig) {
		this.pool = config.pool ?? createPool(config);
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return (await pooledStatement(this.pool, sql, params)).rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return { rowCount: (await pooledStatement(this.pool, sql, params)).rowCount ?? 0 };
	}

	beginTransaction(): Promise<TransactionHandle> {
		return translate(async () => {
			const client = await this.pool.connect();
			try {
				await client.query('BEGIN');
			} catch (e) {
				client.release(asError(e));
				throw e;
			}
			return new DsqlTransaction(client);
		});
	}

	// A COMMIT that fails has rolled the transaction back on the server, so the handle is settled either
	// way and the client goes back to the pool here; the rollback DatabaseCore issues next is a no-op.
	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const tx = open(handle);
		tx.settled = true;
		try {
			await tx.client.query('COMMIT');
		} catch (e) {
			tx.client.release(isServerError(e) ? undefined : asError(e));
			translatePgError(e, 'DsqlEngine');
		}
		tx.client.release();
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		if (isSettled(handle)) return;
		const tx = open(handle);
		tx.settled = true;
		try {
			await tx.client.query('ROLLBACK');
			tx.client.release();
		} catch (e) {
			// The connection's state is unknown after a failed ROLLBACK: the pool discards it.
			tx.client.release(asError(e));
			console.error('[DsqlEngine] rollback failed', { code: pgErrorCode(e) });
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

	async destroy(): Promise<void> {
		await this.pool.end();
	}
}
