// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { PGliteEngine } from './engines/pglite-engine.js';
import { LazyEngine } from './engines/lazy-engine.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { RLSEnabledDatabase } from './database.js';
import { runMigrations, loadMigrationsFromDir, trackEager, logRecovery } from '@aws-blocks/data-common';
import { createCrudHandlers } from './crud/index.js';
import type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions } from './types.js';
import type { Transaction, SqlQuery } from '@aws-blocks/data-common';
import type { TableSchema, CrudOptions, CrudMethods, TableTypeMeta } from './crud/types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

/**
 * SQL database for local development, backed by PGlite (WASM PostgreSQL)
 * or a direct connection string (for fromExisting databases like Supabase).
 * Data persists in `.bb-data/{fullId}/` across dev server restarts.
 *
 * @example
 * import { sql } from '@aws-blocks/bb-data';
 * const db = new Database(scope, 'main');
 *
 * await db.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)`);
 * const users = await db.query<{ id: string; name: string }>(sql`SELECT * FROM users`);
 */
export class Database extends Scope {
  private base!: RLSEnabledDatabase;
  private migrationsRun: Promise<void> | null = null;
  /**
   * Restart the eager migration run. Set only when the Database was constructed
   * with `migrationsPath`. Invoked by {@link ensureMigrations} to re-run
   * migrations after a transient PGlite init trap cleared the cached promise.
   */
  private startMigrations?: () => Promise<void>;
  private schema?: TableSchema;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, options?: DatabaseOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });

    if (options?.connection && isConnectionString(options.connection)) {
      // External database via connection string — connect directly.
      // Local dev defaults to NOT verifying the certificate (self-signed local
      // databases are common); a caller-supplied `ssl` (e.g. the `db pull`-generated
      // wiring pinning the provider CA) overrides this.
      const engine = new PgClientEngine({
        connectionString: options.connection.connectionString,
        ssl: mockExternalSsl(options.connection.ssl),
      });
      this.base = new RLSEnabledDatabase(engine);
    } else if (options?.connection && 'connectionString' in options.connection && typeof options.connection.connectionString !== 'string') {
      // External database via AppSetting — in local dev, AppSetting
      // reads from .env.local so we resolve it during initialization.
      const ssl = mockExternalSsl(options.connection.ssl);
      const connectionString = options.connection.connectionString;
      const initPromise = connectionString.get().then(connStr => {
        this.base = new RLSEnabledDatabase(new PgClientEngine({
          connectionString: connStr,
          ssl,
        }));
      });
      // Same eager-rejection hazard as the migrationsPath branch below: AppSetting.get()
      // rejects (ParameterNotFound / ValidationFailed) for a missing or invalid .env.local
      // value, which would otherwise be an unhandled rejection killing `npm run dev`. This is
      // not a PGlite path, so no trap-retry (onTrap) — just the keep-alive logging guard.
      this.migrationsRun = trackEager(initPromise, this.log, 'Database connection setup failed');
    } else {
      // Local PGlite for development
      if (options?.extensions && options.extensions.length > 0) {
        // Extensions are resolved by dynamic import (async), which the sync
        // constructor cannot await. Install ONE stable engine — a LazyEngine
        // that builds the extension-loaded PGliteEngine on first use and
        // memoizes it — so `this.base` is never reassigned. Every data path
        // (query/execute/transaction/withRLS and the crud() handlers, which
        // capture `this.base` synchronously) therefore shares the same engine
        // and sees the extensions once they resolve. The factory import()s the
        // extension packages lazily, so a Database that declares extensions but
        // is never queried never loads them.
        const extensions = options.extensions;
        const dataDir = `.bb-data/${this.fullId}`;
        const lazyEngine = new LazyEngine(() => PGliteEngine.create(dataDir, extensions));
        this.base = new RLSEnabledDatabase(lazyEngine);
      } else {
        const engine = new PGliteEngine(`.bb-data/${this.fullId}`);
        this.base = new RLSEnabledDatabase(engine);
      }
    }

    if (options?.schema) {
      this.schema = options.schema;
    }

    if (options?.migrationsPath && options?.connection) {
      throw new Error(
        'migrationsPath cannot be used with fromExisting(). External database ' +
        'migrations are applied from ./migrations during `npm run sandbox` / `npm run deploy` ' +
        '(see MIGRATION_GUIDE.md). Remove migrationsPath from this Database.'
      );
    }

    if (options?.migrationsPath) {
      const path = options.migrationsPath;
      // Migrations start eagerly, before any query awaits them. Two things matter:
      //  1. A rejection on this eager promise with no handler is an UNHANDLED
      //     rejection that terminates the whole dev server process (notably a
      //     PGlite `_pg_initdb` WASM trap under CI memory pressure). trackEager
      //     attaches a logging handler so the process survives; the same
      //     rejection still reaches every caller via ensureMigrations() below.
      //  2. The failure must NOT be cached forever. The engine below deliberately
      //     recovers (`PGliteEngine.ensureReady()` discards the dead WASM instance
      //     so a later query can retry once memory eases), so caching the rejected
      //     promise would wedge this Database permanently against a layer built to
      //     heal. On an init trap, onTrap clears `migrationsRun` so the next query
      //     re-runs migrations (runMigrations is idempotent — it skips files
      //     already recorded in `_migrations`).
      // A migration re-run only happens after a prior trap cleared the cache
      // (onTrap below), so a run that resolves while `trapped` is set is a HEAL:
      // log the recovery marker, the causal companion to the unavailable
      // sentinel, so the bench scorer knows the data layer was up by test time.
      // `this.base` is stable (never reassigned); when it wraps a LazyEngine the
      // extensions resolve on the first engine call `runMigrations` makes, so
      // migrations run against the extension-loaded engine.
      let trapped = false;
      const startMigrations = () => {
        const retry = trapped;
        const run = loadMigrationsFromDir(path)
          .then(m => runMigrations(this.base.getEngine(), m))
          .then(() => {
            if (retry) {
              trapped = false;
              // A logging failure must never reject the heal run (which would
              // leave the data layer wrongly wedged), so swallow any logger error.
              try {
                logRecovery(this.log, 'Migrations re-ran');
              } catch {}
            }
          });
        this.migrationsRun = trackEager(run, this.log, 'Migrations failed', () => {
          trapped = true;
          this.migrationsRun = null;
        });
        return run;
      };
      this.startMigrations = startMigrations;
      startMigrations();
    }
    registerSdkIdentifiers(this.fullId, { clusterArn: `mock-cluster-${this.fullId}`, secretArn: `mock-secret-${this.fullId}` });
  }

  /** Ensure migrations have completed before any query. */
  private async ensureMigrations(): Promise<void> {
    // A prior init trap may have cleared the cached promise (see the migrationsPath
    // branch): re-run migrations once so a query after a transient WASM-memory trap
    // can succeed, rather than caching the failure for the life of the process.
    if (!this.migrationsRun && this.startMigrations) this.startMigrations();
    if (this.migrationsRun) await this.migrationsRun;
  }

  query<T>(query: SqlQuery): Promise<T[]> {
    return this.ensureMigrations().then(() => this.base.query<T>(query));
  }

  queryOne<T>(query: SqlQuery): Promise<T | null> {
    return this.ensureMigrations().then(() => this.base.queryOne<T>(query));
  }

  execute(query: SqlQuery): Promise<{ rowCount: number }> {
    return this.ensureMigrations().then(() => this.base.execute(query));
  }

  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.ensureMigrations().then(() => this.base.transaction<T>(fn));
  }

  /** Return an RLS-scoped database instance. */
  async withRLS(context: { userId: string; role?: string; claims?: Record<string, unknown> }) {
    await this.ensureMigrations();
    return this.base.withRLS(context);
  }

  /**
   * Generate typed CRUD handlers for the given tables.
   * Returns an object with list/get/create/update/delete methods.
   */
  crud<M extends Record<string, TableTypeMeta>>(
    options: CrudOptions<M>,
  ): CrudMethods<M, (typeof options)['tables'][number]> {
    if (!this.schema) {
      throw new Error('crud() requires schema metadata. Pass `schema: tableMeta` to the Database constructor.');
    }
    return createCrudHandlers(this.base, this.schema, options, () => this.ensureMigrations()) as any;
  }

  /** @internal Get the underlying DatabaseEngine. Used by createKyselyAdapter(). */
  async getEngine() {
    await this.ensureMigrations();
    return this.base.getEngine();
  }
}

function isConnectionString(
  ref: ExternalDatabaseRef,
): ref is { connectionString: string; ssl?: ExternalSslOptions } {
  return 'connectionString' in ref && typeof ref.connectionString === 'string';
}

/**
 * Resolve the local-dev TLS policy for an external connection.
 *
 * Local dev intentionally defaults to NOT verifying the certificate (self-signed
 * local databases are common), whereas the deployed runtime verifies by default.
 * That asymmetry means a hand-written `fromExisting({ connectionString })` with no
 * `ssl` connects fine locally but can fail on deploy against a private-CA provider
 * (e.g. Supabase) — and only after deploying. Warn when `ssl` is omitted so the
 * gap surfaces during local development rather than in production.
 */
function mockExternalSsl(ssl: ExternalSslOptions | undefined): ExternalSslOptions {
  if (ssl) return ssl;
  if (!warnedMockSslOmitted) {
    warnedMockSslOmitted = true;
    console.warn(
      '[bb-data] DB TLS (local dev): this external connection has no `ssl` set — connecting WITHOUT ' +
      'certificate verification locally, but the deployed runtime verifies by default. Pin your ' +
      'provider CA via `ssl: { ca }` (or set `ssl: { rejectUnauthorized: false }` explicitly) so local ' +
      'and deploy behave the same. See MIGRATION_GUIDE.md.',
    );
  }
  return { rejectUnauthorized: false };
}
/** Warn at most once per process that an external connection omitted `ssl`. */
let warnedMockSslOmitted = false;

export { fromExisting } from './from-existing.js';
export { RLSEnabledDatabase } from './database.js';
export { DatabaseErrors } from './errors.js';
export { createKyselyAdapter, sql } from '@aws-blocks/data-common';
export { PgClientEngine } from './engines/pg-client-engine.js';
export type { PgClientEngineConfig } from './engines/pg-client-engine.js';
export type { SqlQuery } from '@aws-blocks/data-common';
export type { RLSContext } from './rls.js';
export type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions, SubnetSelection } from './types.js';
export type { Transaction } from '@aws-blocks/data-common';
export type { TableSchema, TableMetaEntry, CrudOptions, CrudMethods, QueryOpts, TableTypeMeta, CrudAuthResult } from './crud/types.js';
