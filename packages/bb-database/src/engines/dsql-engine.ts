// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import pg from 'pg';
import { DEFAULT_POOL_SIZE, quoteIdent } from '../constants.js';
import { isStaleSchemaCache, translatePgError } from '../errors.js';

interface DsqlEngineConfig {
	endpoint: string;
	getAuthToken: () => Promise<string>;
	poolSize?: number;
	role: string;
	searchPath?: string;
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

const translated = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((e) => translatePgError(e, 'DsqlEngine'));

// DSQL reports a stale schema cache as SQLSTATE OC001; one retry refreshes the catalog.
const statement = (client: Queryable, sql: string, params?: unknown[]): Promise<pg.QueryResult> =>
	translated(() =>
		client.query(sql, params).catch((e) => (isStaleSchemaCache(e) ? client.query(sql, params) : Promise.reject(e))),
	);

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
			types: dsqlTypeParsers,
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
		return (await statement(this.pool, sql, params)).rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return { rowCount: (await statement(this.pool, sql, params)).rowCount ?? 0 };
	}

	beginTransaction(): Promise<TransactionHandle> {
		return translated(async () => {
			const client = await this.pool.connect();
			await client.query('BEGIN');
			return client;
		});
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const client = handle as pg.PoolClient;
		try {
			await translated(() => client.query('COMMIT'));
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
		return (await statement(handle as pg.PoolClient, sql, params)).rows;
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		return { rowCount: (await statement(handle as pg.PoolClient, sql, params)).rowCount ?? 0 };
	}

	async destroy(): Promise<void> {
		await this.pool.end();
	}
}
