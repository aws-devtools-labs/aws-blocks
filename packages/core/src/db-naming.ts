// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Single source of truth for the SSM parameter name that stores an external
 * database connection string, and for the project ref derived from a Postgres
 * connection string.
 *
 * The connection-string parameter name is **stack-scoped** (embeds the
 * deployment's stack name), so two Blocks apps in the same account + region +
 * stage get distinct names and cannot overwrite each other's credentials.
 *
 * Two call sites compute the name: the pre-deploy writer (`ensure-secrets`) and
 * the `db pull` generated wiring at synth. Both pass the result of
 * `getStackName({ sandbox, projectRoot })` into this function, so they produce
 * the same name by construction. The runtime Lambda does not call this function;
 * it reads the name recorded at synth.
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

/**
 * SSM SecureString parameter name for a deployment's external database
 * connection string.
 *
 * Pure string transform: `/<stackName>-db-url`. The caller is responsible for
 * computing the stack name via `getStackName({ sandbox, projectRoot })`.
 */
export function dbConnectionParameterName(stackName: string): string {
  return `/${stackName}-db-url`;
}
