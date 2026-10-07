// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Aurora DSQL engine — `pg.Pool` with IAM token authentication.
 */
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import pg from 'pg';
import { DEFAULT_POOL_SIZE, quoteIdent } from '../constants.js';
import { isStaleSchemaCache, translatePgError } from '../errors.js';

export interface DsqlEngineConfig {
	endpoint: string;
	region: string;
	getAuthToken: () => Promise<string>;
	poolSize?: number;
	/** PostgreSQL role name to connect as (mapped from IAM via `AWS IAM GRANT`). */
	role: string;
	/** The schema every connection's `search_path` points at. Omit for `public`. */
	searchPath?: string;
}

/** Retries a statement once when DSQL reports a stale schema cache (`OC001`); the fix is a catalog refresh. */
async function withStaleCacheRetry<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (!isStaleSchemaCache(e)) throw e;
		return fn();
	}
}

export class DsqlEngine implements DatabaseEngine {
	private readonly pool: pg.Pool;

	constructor(config: DsqlEngineConfig) {
		// DSQL clusters have a fixed connection contract: port 5432, database 'postgres', TLS required.
		this.pool = new pg.Pool({
			host: config.endpoint,
			port: 5432,
			user: config.role,
			database: 'postgres',
			ssl: true,
			max: config.poolSize ?? DEFAULT_POOL_SIZE,
			password: config.getAuthToken,
		});
		if (config.searchPath) {
			const searchPath = config.searchPath;
			this.pool.on('connect', (client) => {
				client.query(`SET search_path TO ${quoteIdent(searchPath)}`).catch((e) => {
					console.error('[bb-database] failed to set search_path on a new DSQL connection', e);
				});
			});
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return await withStaleCacheRetry(async () => (await this.pool.query(sql, params)).rows);
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		try {
			return await withStaleCacheRetry(async () => ({
				rowCount: (await this.pool.query(sql, params)).rowCount ?? 0,
			}));
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		}
	}

	async beginTransaction(): Promise<TransactionHandle> {
		try {
			const client = await this.pool.connect();
			await client.query('BEGIN');
			return client;
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		}
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const client = handle as pg.PoolClient;
		try {
			await client.query('COMMIT');
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		} finally {
			client.release();
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		const client = handle as pg.PoolClient;
		try {
			await client.query('ROLLBACK');
		} catch (e) {
			console.error('[DsqlEngine] rollback failed', { code: (e as pg.DatabaseError).code });
		} finally {
			client.release();
		}
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return await withStaleCacheRetry(async () => (await (handle as pg.PoolClient).query(sql, params)).rows);
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		}
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		try {
			return await withStaleCacheRetry(async () => ({
				rowCount: (await (handle as pg.PoolClient).query(sql, params)).rowCount ?? 0,
			}));
		} catch (e) {
			translatePgError(e, 'DsqlEngine');
		}
	}

	async destroy(): Promise<void> {
		await this.pool.end();
	}
}
