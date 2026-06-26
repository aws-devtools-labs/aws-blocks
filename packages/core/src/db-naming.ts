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
 * Two call sites compute the name with this function: the pre-deploy writer
 * (`ensure-secrets`) and the `db pull` generated wiring at synth (which records
 * the resolved name so the deployed Lambda can read it). They produce the same
 * name because the deploy command gives both the same inputs (`projectRoot` and
 * `sandbox`), and the name is derived from committed config — never from the
 * connection string. The runtime Lambda does not call this function; it reads
 * the name recorded at synth. So written name, recorded name, and read name
 * agree as long as the two call sites receive the same inputs.
 */
import { getStackName } from './scripts/stack-id.js';

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
 * SSM SecureString parameter name that stores this app's external database
 * connection string for a deployment.
 *
 * Stack-scoped via {@link getStackName}: `/<stackName>-db-url`
 * (e.g. `/my-app-k7x2mf-prod-db-url`). The discriminator is the app's own stack
 * identity from committed config — never the connection string or a database
 * ref — so it is computed identically on the pre-deploy write side and the
 * synth side, and is unique per app.
 */
export function dbConnectionParameterName(
  projectRoot: string | undefined,
  opts: { sandbox: boolean },
): string {
  return `/${getStackName(projectRoot, opts)}-db-url`;
}
