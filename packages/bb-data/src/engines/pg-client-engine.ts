// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import pg from 'pg';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { translatePgError } from './pg-error-translator.js';
import { DatabaseErrors } from '../errors.js';
import type { ExternalSslOptions } from '../types.js';

/**
 * Configuration for connecting to a PostgreSQL-compatible database.
 */
export interface PgClientEngineConfig {
  /** PostgreSQL connection URI (e.g. postgresql://user:pass@host:5432/db). */
  connectionString: string;
  /**
   * SSL configuration. Defaults to `{ rejectUnauthorized: true }` (verify the
   * server certificate). A TLS 1.2 floor (`minVersion: 'TLSv1.2'`) is applied
   * unless a caller overrides it here.
   *
   * Reuses the public {@link ExternalSslOptions} discriminated union so the
   * misleading `{ ca, rejectUnauthorized: false }` combination is a compile error
   * for direct engine callers too (not only `fromExisting`): a pinned `ca` is
   * honored only when the certificate is actually verified, and node `pg`
   * silently ignores `ca` when `rejectUnauthorized: false`.
   */
  ssl?: ExternalSslOptions & { minVersion?: 'TLSv1.2' | 'TLSv1.3' };
  /** Maximum number of clients in the pool. @default 5 */
  poolSize?: number;
  /** Milliseconds to wait for a connection before erroring. Unset = wait indefinitely. */
  connectionTimeoutMillis?: number;
}

/**
 * Guard against an unprovisioned secret reaching the pool. The connection string
 * is written to SSM by `ensureSecrets()` during `npm run sandbox` / `npm run deploy`;
 * if that step found no connection string (e.g. it's missing from `.env.local` /
 * `.env.production`), the AppSetting secret Custom Resource leaves a random
 * base64url placeholder in SSM. Connecting with it surfaces as an opaque pg
 * parse/auth error — fail loud and actionable instead.
 */
function assertPostgresUrl(connectionString: string): void {
  if (!/^postgres(ql)?:\/\//i.test((connectionString ?? '').trim())) {
    const err = new Error(
      'Database connection string is not a valid postgres:// URL — the connection ' +
      'secret was not provisioned to SSM (the deployed value is a placeholder). ' +
      'Ensure your connection string is set in .env.local (sandbox) or .env.production ' +
      '(deploy), then re-run `npm run sandbox` / `npm run deploy`. See MIGRATION_GUIDE.md.',
    );
    err.name = DatabaseErrors.ConnectionFailed;
    throw err;
  }
}

/**
 * Remove `sslmode` from the connection URL so the engine's programmatic `ssl`
 * config is authoritative. node `pg` honors `sslmode` in the URL and **ignores a
 * programmatic `ssl.ca`** when it is present — so a caller pinning a CA (the
 * documented `fromExisting({ ssl: { ca } })` escape hatch) would have it silently
 * dropped, verifying against the system trust store instead (which a provider's
 * private CA, e.g. Supabase's, is not in). The engine always passes an `ssl`
 * object, so `sslmode` in the URL is never the right control surface here.
 *
 * Best-effort: an unparseable URL (e.g. an unencoded password) is left unchanged.
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

/**
 * Build the post-handshake TLS confirmation message for a successful connection.
 *
 * Pure (no I/O) so it can be unit-tested. Called from the pool's `connect` event,
 * where the TLS handshake has already succeeded — so when verification is enabled
 * (`rejectUnauthorized !== false`) the server certificate has been validated.
 *
 * The host (no credentials) is included for context; an unparseable connection
 * string (e.g. an unencoded password) simply omits it.
 */
export function tlsConnectionMessage(
  ssl: ExternalSslOptions | undefined,
  connectionString: string,
): { level: 'log' | 'warn'; message: string } {
  let host = '';
  try { host = new URL(connectionString).host; } catch { /* unparseable — omit host */ }
  const where = host ? ` to ${host}` : '';
  if (ssl?.rejectUnauthorized === false) {
    return {
      level: 'warn',
      message: `[bb-data] DB TLS: connected${where} — server certificate NOT verified (encrypted only, no protection against an active man-in-the-middle).`,
    };
  }
  const against = ssl?.ca ? 'the pinned CA' : "Node's built-in trust store";
  return {
    level: 'log',
    message: `[bb-data] DB TLS: connected${where} — server certificate verified against ${against}. ✓`,
  };
}

/**
 * DatabaseEngine implementation using the `pg` library.
 * Connects to any PostgreSQL-compatible database (Supabase, Neon, DSQL, etc.)
 * via a connection pool.
 */
export class PgClientEngine implements DatabaseEngine {
  private pool: pg.Pool;

  constructor(config: PgClientEngineConfig) {
    assertPostgresUrl(config.connectionString);
    // Make the programmatic `ssl` config authoritative regardless of any
    // `sslmode` in the URL (see stripSslmode). Centralizing here means every
    // path — deployed runtime, local mock, CLI, migrations, introspection — gets
    // it, including a hand-written `fromExisting({ connectionString, ssl: { ca } })`.
    const connectionString = stripSslmode(config.connectionString);
    // Enforce a TLS 1.2 floor on every connection regardless of caller. Node 18+
    // already negotiates TLS 1.2+ by default, but pinning `minVersion` makes the
    // floor explicit and independent of the runtime's default — and it applies to
    // the unverified opt-out path too (TLS version is orthogonal to cert
    // verification). A caller-supplied `minVersion` still wins.
    const baseSsl = config.ssl ?? { rejectUnauthorized: true };
    this.pool = new pg.Pool({
      connectionString,
      max: config.poolSize ?? 5,
      ssl: { minVersion: 'TLSv1.2', ...baseSsl },
      ...(config.connectionTimeoutMillis !== undefined && {
        connectionTimeoutMillis: config.connectionTimeoutMillis,
      }),
    });

    // Positive, truthful TLS confirmation on the FIRST successful connection.
    // The TLS handshake is lazy (it happens when the pool opens its first
    // connection, i.e. on the first query), so a config-time "verifying…" log only
    // states intent. Reaching the pool's `connect` event means the socket — and
    // thus the TLS handshake — succeeded; with `rejectUnauthorized !== false` that
    // means the server certificate validated. Log it once so success is visible
    // instead of left for the caller to infer.
    let tlsConfirmed = false;
    this.pool.on('connect', () => {
      if (tlsConfirmed) return;
      tlsConfirmed = true;
      const { level, message } = tlsConnectionMessage(baseSsl, config.connectionString);
      console[level](message);
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows;
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const result = await this.pool.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
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
      const client = handle as pg.PoolClient;
      const result = await client.query(sql, params);
      return result.rows;
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const client = handle as pg.PoolClient;
      const result = await client.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async destroy(): Promise<void> {
    await this.pool.end();
  }
}
