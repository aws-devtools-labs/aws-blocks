// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { DEFAULT_SCHEMA, quoteIdent } from '../constants.js';
import { RulesEngine } from '../dialect/rules-engine.js';
import { internalAccess } from '../runtime/internal.js';

/**
 * Drops and recreates `schema` on the local cluster behind `db`, through the block's own engine. Tests that
 * share one PGlite call it between tests; the next block on the schema runs its migrations into an empty one.
 */
export async function resetMockSchema(db: object, schema: string = DEFAULT_SCHEMA): Promise<void> {
	const engine = await internalAccess(db, 'resetMockSchema').engine();
	assert.ok(engine instanceof RulesEngine, 'a local Database runs on the RulesEngine');
	await engine.asAdmin(async () => {
		await engine.execute(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
		await engine.execute(`CREATE SCHEMA ${quoteIdent(schema)}`);
		// initdb's grant on `public` went with the drop; a block's own schema gets its grant when the block is built.
		if (schema === DEFAULT_SCHEMA) await engine.execute(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO PUBLIC`);
	});
}

/** Runs `sql` in `db`'s schema as the cluster admin: the migration ledger is closed to the app role. */
export async function queryAsAdmin<T>(db: object, sql: string): Promise<T[]> {
	const engine = await internalAccess(db, 'queryAsAdmin').engine();
	assert.ok(engine instanceof RulesEngine, 'a local Database runs on the RulesEngine');
	return engine.asAdmin(() => engine.query<T>(sql));
}
