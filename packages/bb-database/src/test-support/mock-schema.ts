// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { DEFAULT_SCHEMA, quoteIdent } from '../constants.js';
import { DsqlRulesEngine } from '../dialect/rules-engine.js';
import { internalAccess } from '../runtime/internal.js';

/**
 * Drops and recreates `schema` on the local cluster behind `db`, through the block's own engine. Tests that
 * share one PGlite call it between tests; the next block on the schema runs its migrations into an empty one.
 */
export async function resetMockSchema(db: object, schema: string = DEFAULT_SCHEMA): Promise<void> {
	const engine = await internalAccess(db, 'resetMockSchema').engine();
	assert.ok(engine instanceof DsqlRulesEngine, 'a local Database runs on the DsqlRulesEngine');
	await engine.withDdl(async () => {
		await engine.execute(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
		await engine.execute(`CREATE SCHEMA ${quoteIdent(schema)}`);
	});
}
