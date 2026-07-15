// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CloudFormation custom resource handler that runs DSQL migrations on deploy.
 *
 * Migrations are bundled as `.sql` files in the Lambda deployment package
 * (at MIGRATIONS_DIR). The CFN resource property `migrationsHash` triggers
 * re-invocation when migration files change.
 *
 * After running migrations, this handler also provisions a least-privilege
 * database role for the app Lambda and maps it to the app's IAM role ARN.
 *
 * Connects to DSQL via pg + IAM token auth (DsqlSigner) as admin.
 */

import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { existsSync } from 'node:fs';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { DsqlEngine } from './engines/dsql-engine.js';
import { runMigrations, loadMigrationsFromDir } from './migrations.js';
import { ensureCounterTable } from './counter.js';
import { LAMBDA_MIGRATIONS_DIR } from './constants.js';

// Set by the CDK construct's environment config. Default is the Lambda deployment root
// where CDK's afterBundling hook copies the .sql files.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || LAMBDA_MIGRATIONS_DIR;
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 2000;
const MAX_DELAY_MS = 15000;

/**
 * Retry with exponential backoff for transient connection errors.
 * DSQL clusters may take a moment to accept connections after creation.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const isTransient = e?.code?.startsWith?.('08') || // connection exception class
        e?.message?.includes?.('Connection terminated') ||
        e?.message?.includes?.('ECONNREFUSED');
      if (!isTransient || attempt === MAX_RETRIES) throw e;
      const delay = Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      console.log(`[bb-distributed-data] Connection not ready, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}

/**
 * Provision a custom database role for the app Lambda with DML-only permissions.
 *
 * 1. CREATE ROLE (idempotent via pg_roles check)
 * 2. AWS IAM GRANT — maps the DB role to the app Lambda's IAM role ARN
 * 3. GRANT DML on user-created tables in public schema
 *
 * This runs on every deploy (idempotent) to ensure the role mapping stays in sync
 * if the app Lambda's IAM role is recreated, and to re-grant DML on any new tables.
 *
 * DSQL Limitations:
 * - ALTER DEFAULT PRIVILEGES is not supported
 * - GRANT ... ON ALL TABLES IN SCHEMA public is not supported (public is a system entity)
 * - We grant on individually enumerated user tables instead
 */
async function provisionAppRole(engine: DsqlEngine, dbRoleName: string, appRoleArn: string): Promise<void> {
  console.log(`[bb-distributed-data] Provisioning DB role '${dbRoleName}' for ${appRoleArn}`);

  // Create the role if it doesn't exist. DSQL doesn't support IF NOT EXISTS on CREATE ROLE,
  // so we check pg_roles first.
  const existing = await engine.query<{ rolname: string }>(
    `SELECT rolname FROM pg_roles WHERE rolname = $1`, [dbRoleName]
  );
  if (existing.length === 0) {
    await engine.execute(`CREATE ROLE ${quoteIdent(dbRoleName)} WITH LOGIN`);
    console.log(`[bb-distributed-data] Created role '${dbRoleName}'`);
  }

  // Map the DB role to the app Lambda's IAM ARN (idempotent — DSQL ignores duplicate grants)
  await engine.execute(`AWS IAM GRANT ${quoteIdent(dbRoleName)} TO '${escapeString(appRoleArn)}'`);

  // Grant DML on user-created tables in public schema (excluding _migrations).
  // DSQL does not support "ON ALL TABLES IN SCHEMA public" because public is a system entity.
  // Instead, enumerate user tables and grant in a single batched statement.
  const userTables = await engine.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'admin' AND tablename != '_migrations'`
  );

  if (userTables.length > 0) {
    const tableList = userTables.map(t => `public.${quoteIdent(t.tablename)}`).join(', ');
    await engine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tableList} TO ${quoteIdent(dbRoleName)}`);
    console.log(`[bb-distributed-data] Granted DML on ${userTables.length} table(s) to role '${dbRoleName}'`);
  }

  console.log(`[bb-distributed-data] Role '${dbRoleName}' provisioned successfully`);
}

/** Quote a PostgreSQL identifier to prevent injection. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Escape a string literal value (for use inside single quotes). */
function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}

export const handler = async (event: CloudFormationCustomResourceEvent): Promise<{ PhysicalResourceId: string }> => {
  console.log('[bb-distributed-data] Migration event:', JSON.stringify({
    RequestType: event.RequestType,
    migrationsHash: event.ResourceProperties?.migrationsHash,
  }));

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId || 'dsql-migrations' };
  }

  const endpoint = process.env.DSQL_ENDPOINT!;
  const region = process.env.DSQL_REGION!;
  const appRoleArn = process.env.APP_ROLE_ARN;
  const dbRoleName = process.env.DB_ROLE_NAME;

  if (!endpoint || !region) {
    throw new Error(`Missing env: DSQL_ENDPOINT=${endpoint}, DSQL_REGION=${region}`);
  }

  if (!appRoleArn || !dbRoleName) {
    throw new Error(`Missing env: APP_ROLE_ARN and DB_ROLE_NAME are required for role provisioning`);
  }

  const signer = new DsqlSigner({ hostname: endpoint, region });
  const engine = new DsqlEngine({
    endpoint,
    region,
    role: 'admin',
    getAuthToken: () => signer.getDbConnectAdminAuthToken(),
  });

  try {
    // 1. Run user-defined migrations if the directory was bundled
    if (existsSync(MIGRATIONS_DIR)) {
      const migrations = await loadMigrationsFromDir(MIGRATIONS_DIR);
      const applied = await withRetry(() => runMigrations(engine, migrations));
      console.log('[bb-distributed-data] Applied:', applied.length ? applied : '(none pending)');
    } else {
      console.log('[bb-distributed-data] No migrations directory bundled, skipping migrations');
    }

    // 1.5 Ensure the framework-managed atomic counter table exists (admin-owned).
    //     provisionAppRole below grants the app role DML on it (it is != _migrations).
    await withRetry(() => ensureCounterTable(engine));

    // 2. Provision the app Lambda's custom DB role (least-privilege DML access)
    await withRetry(() => provisionAppRole(engine, dbRoleName, appRoleArn));

    return {
      PhysicalResourceId: `dsql-migrations-${event.ResourceProperties?.migrationsHash || 'unknown'}`,
    };
  } finally {
    await engine.destroy().catch((e) => {
      console.error('[bb-distributed-data] Failed to destroy engine during cleanup', e);
    });
  }
};
