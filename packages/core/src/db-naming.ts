// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the SSM parameter name that stores an external
 * database connection string, and for the project ref derived from a Postgres
 * connection string.
 *
 * The connection-string parameter name is **stack-scoped** (embeds the
 * deployment's stack name), so two CDK Blocks apps in the same account + region +
 * stage get distinct names and cannot overwrite each other's credentials.
 *
 * One call site computes the name: the sandbox cleanup (`deleteSandboxSecrets`
 * in `scripts/ensure-secrets.ts`). It passes the result of
 * `getStackName({ sandbox: true, projectRoot })` into this function. The
 * `Database` block derives the same string for the default connection name
 * (`/<stackName>-<name>` with the name `db-url`), and `npm run db -- connect
 * --stage` writes it. The runtime Lambda does not call this function.
 */

/**
 * Extract a stable identifier from a Postgres connection string.
 *
 * Maps the Supabase pooler form (`postgres.{ref}@`) and the direct form
 * (`db.{ref}.supabase.co`) to the same `{ref}`, so a project's connection string
 * yields one identifier regardless of which form the customer pastes. Falls back
 * to a sanitized hostname for non-Supabase hosts.
 */
export function extractDbRef(connectionString: string): string {
  // Supabase pooler: postgres.{ref}:pass@... or postgres.{ref}@...
  const pooler = connectionString.match(/postgres\.([a-z0-9]+)[:@]/i);
  if (pooler) return pooler[1];

  // Supabase direct: @db.{ref}.supabase.co
  const direct = connectionString.match(/@db\.([a-z0-9]+)\.supabase\.co/i);
  if (direct) return direct[1];

  // Generic host fallback
  const host = connectionString.match(/@([^:/?]+)/);
  if (host) return host[1].replace(/\./g, '-');

  throw new Error('Cannot extract database identifier from connection string.');
}

/** The connection name that `DatabaseCluster.fromExisting()` and `npm run db` use when none is given. */
export const DEFAULT_DB_CONNECTION_NAME = 'db-url';

/**
 * SSM SecureString parameter name for a deployment's external database
 * connection string.
 *
 * Pure string transform: `/<stackName>-db-url`. The caller is responsible for
 * computing the stack name via `getStackName({ sandbox, projectRoot })`.
 *
 * `name` is the connection's short name; a `Database` on an existing database
 * derives its parameter with the same function, so the name that
 * `npm run db -- connect --stage` writes and the name the sandbox cleanup
 * deletes cannot differ.
 */
export function dbConnectionParameterName(stackName: string, name: string = DEFAULT_DB_CONNECTION_NAME): string {
  return `/${stackName}-${name}`;
}
