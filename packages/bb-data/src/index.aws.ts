// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, registerSdkIdentifiers, getSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DataApiEngine } from './engines/data-api-engine.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { RLSEnabledDatabase } from './database.js';
import { createCrudHandlers } from './crud/index.js';
import { ENV_NAME_SANITIZE_PATTERN, ENV_VAR_PREFIX } from './constants.js';
import { BB_NAME, BB_VERSION } from './version.js';
import type { DatabaseOptions, ExternalDatabaseRef } from './types.js';
import type { Transaction, SqlQuery } from '@aws-blocks/data-common';
import type { TableSchema, CrudOptions, CrudMethods, TableTypeMeta } from './crud/types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

/**
 * SQL database for AWS Lambda runtime, backed by Aurora Serverless v2 via RDS Data API.
 *
 * Connection details are read from environment variables injected by the CDK layer:
 * - `BLOCKS_{id}_CLUSTER_ARN` — Aurora cluster ARN
 * - `BLOCKS_{id}_SECRET_ARN` — Secrets Manager secret ARN
 * - `BLOCKS_{id}_DATABASE` — Database name
 *
 * For external databases (Supabase, Neon) via `fromExisting({ connectionString })`:
 * - Connection string is resolved via AppSetting at runtime (SSM SecureString)
 *
 * Where `{id}` is derived from `this.fullId` with non-alphanumeric characters replaced by `_`.
 */
export class Database extends Scope {
  private _base: RLSEnabledDatabase | null = null;
  private _basePromise: Promise<RLSEnabledDatabase> | null = null;
  private options?: DatabaseOptions;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, options?: DatabaseOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
    this.options = options;
    const envName = this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');
    const clusterArn = process.env[`${ENV_VAR_PREFIX}_${envName}_CLUSTER_ARN`] ?? '';
    const secretArn = process.env[`${ENV_VAR_PREFIX}_${envName}_SECRET_ARN`] ?? '';
    const databaseName = process.env[`${ENV_VAR_PREFIX}_${envName}_DATABASE`] || envName;
    registerSdkIdentifiers(this.fullId, { clusterArn, secretArn, databaseName });
  }

  /** @internal Resolve the underlying RLSEnabledDatabase (async due to SSM SecureString fetch). */
  private async resolveBase(): Promise<RLSEnabledDatabase> {
    if (this._base) return this._base;
    if (this._basePromise) return this._basePromise;

    this._basePromise = this._initBase();
    this._base = await this._basePromise;
    this._basePromise = null;
    return this._base;
  }

  private async _initBase(): Promise<RLSEnabledDatabase> {
    const envName = this.fullId.replace(ENV_NAME_SANITIZE_PATTERN, '_');
    const conn = this.options?.connection;

    if (conn && 'connectionString' in conn) {
      const connStr = typeof conn.connectionString === 'string'
        ? conn.connectionString
        : await conn.connectionString.get();
      // Verify the server's TLS certificate by default (PgClientEngine defaults to
      // rejectUnauthorized: true when ssl is undefined). The `db pull`-generated
      // wiring supplies an ssl config that pins the provider CA; callers using
      // fromExisting() directly can pass `ssl` to pin a CA or opt out. Previously
      // this hardcoded rejectUnauthorized:false, leaving the deployed Lambda's
      // connection to external DBs (Supabase/Neon/etc.) unauthenticated (MITM-exposed).
      return new RLSEnabledDatabase(new PgClientEngine({ connectionString: connStr, ssl: conn.ssl }));
    }
    return new RLSEnabledDatabase(this.createDataApiEngine(envName, conn));
  }

  /**
   * Aurora Data API — credentials stay in Secrets Manager, resolved per-request by the
   * Data API service itself. No secret fetch needed here.
   */
  private createDataApiEngine(
    envName: string,
    conn: Extract<ExternalDatabaseRef, { host: string }> | undefined,
  ): DataApiEngine {
    const { clusterArn, secretArn } = getSdkIdentifiers(this);
    const resourceArn = conn?.host || clusterArn;
    const resolvedSecretArn = conn?.secretArn || secretArn;
    const database = conn?.database || this.options?.databaseName || process.env[`${ENV_VAR_PREFIX}_${envName}_DATABASE`] || envName;

    if (!resourceArn || !resolvedSecretArn) {
      throw new Error(
        `Missing environment variables: ${ENV_VAR_PREFIX}_${envName}_CLUSTER_ARN and/or ${ENV_VAR_PREFIX}_${envName}_SECRET_ARN. ` +
        `These are injected by the CDK layer — ensure the Database is provisioned.`
      );
    }

    return new DataApiEngine({ resourceArn, secretArn: resolvedSecretArn, database, customUserAgent: this.buildUserAgentChain() });
  }

  async query<T>(query: SqlQuery): Promise<T[]> {
    const base = await this.resolveBase();
    return base.query<T>(query);
  }

  async queryOne<T>(query: SqlQuery): Promise<T | null> {
    const base = await this.resolveBase();
    return base.queryOne<T>(query);
  }

  async execute(query: SqlQuery): Promise<{ rowCount: number }> {
    const base = await this.resolveBase();
    return base.execute(query);
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const base = await this.resolveBase();
    return base.transaction<T>(fn);
  }

  /** Return an RLS-scoped database instance. */
  async withRLS(context: { userId: string; role?: string; claims?: Record<string, unknown> }) {
    const base = await this.resolveBase();
    return base.withRLS(context);
  }

  /**
   * Generate typed CRUD handlers for the given tables.
   */
  crud<M extends Record<string, TableTypeMeta>>(
    options: CrudOptions<M>,
  ): CrudMethods<M, (typeof options)['tables'][number]> {
    if (!this.options?.schema) {
      throw new Error('crud() requires schema metadata. Pass `schema: tableMeta` to the Database constructor.');
    }
    return createAsyncCrudProxy(() => this.resolveBase(), this.options.schema, options) as any;
  }

  /** @internal Get the underlying DatabaseEngine. Used by createKyselyAdapter(). */
  async getEngine() {
    const base = await this.resolveBase();
    return base.getEngine();
  }
}

/**
 * Creates a proxy that defers crud handler creation until the first method call.
 */
function createAsyncCrudProxy(resolveBase: () => Promise<RLSEnabledDatabase>, schema: TableSchema, options: CrudOptions<any>): any {
  let handlers: any = null;
  let initPromise: Promise<any> | null = null;

  const methodNames: string[] = [];
  const excludeSet = new Set(options.exclude ?? []);
  for (const table of options.tables) {
    const meta = schema[table];
    if (!meta) continue;
    const singular = meta.singular[0].toUpperCase() + meta.singular.slice(1);
    const plural = meta.plural[0].toUpperCase() + meta.plural.slice(1);
    for (const name of [`list${plural}`, `get${singular}`, `create${singular}`, `update${singular}`, `delete${singular}`]) {
      if (!excludeSet.has(name)) methodNames.push(name);
    }
  }

  async function ensureHandlers() {
    if (handlers) return handlers;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const base = await resolveBase();
      handlers = createCrudHandlers(base, schema, options);
      return handlers;
    })();
    handlers = await initPromise;
    initPromise = null;
    return handlers;
  }

  const target: Record<string, any> = {};
  for (const name of methodNames) {
    target[name] = async (...args: any[]) => {
      const h = await ensureHandlers();
      return h[name](...args);
    };
  }
  return target;
}

export { fromExisting } from './from-existing.js';
export { RLSEnabledDatabase } from './database.js';
export { DatabaseErrors } from './errors.js';
export { createKyselyAdapter, sql } from '@aws-blocks/data-common';
export { PgClientEngine } from './engines/pg-client-engine.js';
export type { PgClientEngineConfig } from './engines/pg-client-engine.js';
export type { SqlQuery } from '@aws-blocks/data-common';
export type { RLSContext } from './rls.js';
export type { DatabaseOptions, ExternalDatabaseRef, ExternalSslOptions } from './types.js';
export type { Transaction } from '@aws-blocks/data-common';
export type { TableSchema, TableMetaEntry, CrudOptions, CrudMethods, QueryOpts, TableTypeMeta, CrudAuthResult } from './crud/types.js';
