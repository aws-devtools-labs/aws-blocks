// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors, reTagged } from './errors.js';

/**
 * Context for scoping database queries with Row Level Security.
 * Passed to `DatabaseBase.withRLS()` to create an RLS-enforced instance.
 */
export interface RLSContext {
  /** The user's unique ID. Becomes `sub` in the JWT claims sent to Postgres. */
  userId: string;
  /** Postgres role to SET LOCAL. Must be 'authenticated' or 'anon'. @default 'authenticated' */
  role?: string;
  /** Additional claims merged into request.jwt.claims. Overrides sub and role if specified. */
  claims?: Record<string, unknown>;
}

const ALLOWED_ROLES = new Set(['authenticated', 'anon']);

/**
 * Sets Supabase-compatible RLS session variables on a transaction handle.
 * Called at the start of a transaction to scope all subsequent queries to a user.
 */
export async function setRLSContext(engine: DatabaseEngine, handle: TransactionHandle, ctx: RLSContext): Promise<void> {
  const role = ctx.role ?? 'authenticated';
  if (!ALLOWED_ROLES.has(role)) {
    throw new Error(`Invalid RLS role: '${role}'. Allowed: ${[...ALLOWED_ROLES].join(', ')}`);
  }

  const claims = JSON.stringify({
    sub: ctx.userId,
    role,
    ...ctx.claims,
  });

  // Safe: role is validated against ALLOWED_ROLES allowlist above.
  // Postgres doesn't support parameterized ($1) SET ROLE statements.
  try {
    await engine.executeInTransaction(handle, `SET LOCAL ROLE ${role}`, []);
  } catch (e) {
    // A refused role switch is a setup problem, not something the caller asked
    // for: the database user isn't a member of the role, so every withRLS() call
    // fails. Report it as a 500 QueryFailed, not the caller-facing 403
    // PermissionDenied the engine maps 42501 to, and say how to fix it.
    if (!isBlocksError(e, DatabaseErrors.PermissionDenied)) throw e;
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    console.error(
      `[Database] withRLS() could not switch to the '${role}' role. Grant it to the database user in a migration: ` +
        `GRANT ${role} TO CURRENT_USER;`,
    );
    throw reTagged(DatabaseErrors.QueryFailed, cause instanceof Error ? cause : new Error(String(cause)));
  }
  await engine.executeInTransaction(
    handle,
    `SELECT set_config('request.jwt.claims', $1, true)`,
    [claims],
  );
}
