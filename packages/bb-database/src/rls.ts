// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';

/**
 * Context for scoping database queries with Row Level Security.
 * Passed to `Database.withRLS()` to create an RLS-enforced instance.
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
	await engine.executeInTransaction(handle, `SET LOCAL ROLE ${role}`, []);
	await engine.executeInTransaction(handle, `SELECT set_config('request.jwt.claims', $1, true)`, [claims]);
}
