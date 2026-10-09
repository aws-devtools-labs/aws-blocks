// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import pg from 'pg';
import { DEFAULT_POOL_SIZE, quoteIdent } from '../constants.js';
import { DatabaseErrors, translatePgError } from '../errors.js';
import type { ExternalSslOptions } from '../types.js';

/** Configuration for connecting to a PostgreSQL-compatible database over the wire protocol. */
export interface PgClientEngineConfig {
	/** PostgreSQL connection URI (e.g. postgresql://user:pass@host:5432/db). */
	connectionString: string;
	/**
	 * SSL configuration. Defaults to `{ rejectUnauthorized: true }` (verify the
	 * server certificate). A TLS 1.2 floor is applied unless overridden here.
	 */
	ssl?: ExternalSslOptions & { minVersion?: 'TLSv1.2' | 'TLSv1.3' };
	/** Maximum number of clients in the pool. @default 5 */
	poolSize?: number;
	/** Milliseconds to wait for a connection before erroring. Unset = wait indefinitely. */
	connectionTimeoutMillis?: number;
	/**
	 * The schema every connection's `search_path` points at. Set once per pooled
	 * connection as it opens, so the block's unqualified table names resolve in
	 * its own schema. Omit for `public`.
	 */
	searchPath?: string;
}

/**
 * Guard against an unprovisioned secret reaching the pool: a placeholder left in
 * SSM surfaces as an opaque pg parse/auth error otherwise.
 */
function assertPostgresUrl(connectionString: string): void {
	if (!/^postgres(ql)?:\/\//i.test((connectionString ?? '').trim())) {
		const err = new Error(
			'Database connection string is not a valid postgres:// URL, so the connection secret was not provisioned. ' +
				'Set it in .env.local (sandbox) or .env.production (deploy), then re-run the deploy.',
		);
		err.name = DatabaseErrors.ConnectionFailed;
		throw brandBlocksError(err);
	}
}

/**
 * Remove `sslmode` from the URL so the programmatic `ssl` config is authoritative:
 * node `pg` ignores a programmatic `ssl.ca` when `sslmode` is present.
 */
function stripSslmode(connectionString: string): string {
	try {
		const u = new URL(connectionString);
		if (!u.searchParams.has('sslmode')) return connectionString;
		u.searchParams.delete('sslmode');
		return u.toString();
	} catch {
		return connectionString;
	}
}

/** Post-handshake TLS confirmation line (pure, for tests). */
export function tlsConnectionMessage(
	ssl: ExternalSslOptions | undefined,
	connectionString: string,
): { level: 'log' | 'warn'; message: string } {
	let host = '';
	try {
		host = new URL(connectionString).host;
	} catch {}
	const where = host ? ` to ${host}` : '';
	if (ssl?.rejectUnauthorized === false) {
		return {
			level: 'warn',
			message: `[bb-database] DB TLS: connected${where}. Server certificate NOT verified (encrypted only).`,
		};
	}
	const against = ssl && 'ca' in ssl && ssl.ca ? 'the pinned CA' : "Node's built-in trust store";
	return {
		level: 'log',
		message: `[bb-database] DB TLS: connected${where}. Server certificate verified against ${against}.`,
	};
}

/**
 * DatabaseEngine over the `pg` library. Connects to any PostgreSQL-compatible
 * database (Supabase, Neon, RDS, a laptop) through a connection pool.
 */
export class PgClientEngine implements DatabaseEngine {
	private readonly pool: pg.Pool;

	constructor(config: PgClientEngineConfig) {
		assertPostgresUrl(config.connectionString);
		const connectionString = stripSslmode(config.connectionString);
		const baseSsl = config.ssl ?? { rejectUnauthorized: true };
		this.pool = new pg.Pool({
			connectionString,
			max: config.poolSize ?? DEFAULT_POOL_SIZE,
			ssl: { minVersion: 'TLSv1.2', ...baseSsl },
			...(config.connectionTimeoutMillis !== undefined && {
				connectionTimeoutMillis: config.connectionTimeoutMillis,
			}),
		});

		let tlsConfirmed = false;
		this.pool.on('connect', (client) => {
			if (config.searchPath) {
				// Queued before any caller's statement: a pg client runs queries in order.
				client.query(`SET search_path TO ${quoteIdent(config.searchPath)}`).catch((e) => {
					console.error('[bb-database] failed to set search_path on a new connection', e);
				});
			}
			if (tlsConfirmed) return;
			tlsConfirmed = true;
			const { level, message } = tlsConnectionMessage(baseSsl, config.connectionString);
			console[level](message);
		});
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return (await this.pool.query(sql, params)).rows;
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		try {
			return { rowCount: (await this.pool.query(sql, params)).rowCount ?? 0 };
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		}
	}

	async beginTransaction(): Promise<TransactionHandle> {
		try {
			const client = await this.pool.connect();
			await client.query('BEGIN');
			return client;
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		}
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const client = handle as pg.PoolClient;
		try {
			await client.query('COMMIT');
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		} finally {
			client.release();
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		const client = handle as pg.PoolClient;
		try {
			await client.query('ROLLBACK');
		} finally {
			client.release();
		}
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return (await (handle as pg.PoolClient).query(sql, params)).rows;
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		}
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		try {
			return { rowCount: (await (handle as pg.PoolClient).query(sql, params)).rowCount ?? 0 };
		} catch (e) {
			translatePgError(e, 'PgClientEngine');
		}
	}

	async destroy(): Promise<void> {
		await this.pool.end();
	}
}
