// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DSQL (bb-distributed-data) parity runner for dsql.cases.ts.

import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { DistributedDatabase } from '@aws-blocks/bb-distributed-data';
import type { ProbeRunner } from '../core/types.js';
import { countLimit, idBatches } from '../kinds/index.js';
import { param } from '../server/helpers.js';

// Seed and clean up in batches well under the 3,000-row limit being probed, so
// only the statement under test can trip it.
const SEED_BATCH = 1000;

/** Uses the stack's DistributedDatabase and its `dsql_items` table (`id TEXT PRIMARY KEY, name TEXT, value INTEGER`). */
export function dsqlProbe(dsql: DistributedDatabase): ProbeRunner {
	return (c) => {
		const path = param(c.params, 'path', 'string');
		// A hex-and-dash prefix carries no LIKE wildcard (`_` / `%`), so the pattern matches only this case's rows.
		const prefix = `parity-${randomUUID().slice(0, 8)}-`;
		const update = sql`UPDATE dsql_items SET value = value + 1 WHERE id LIKE ${`${prefix}%`}`;
		const updateReturning = sql`UPDATE dsql_items SET value = value + 1 WHERE id LIKE ${`${prefix}%`} RETURNING id`;
		return countLimit(c, {
			setup: async (rows) => {
				const batches = idBatches(prefix, rows, SEED_BATCH);
				for (const ids of batches) {
					await dsql.execute(
						sql`INSERT INTO dsql_items (id, name, value) SELECT x, 'parity', 0 FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) AS x`,
					);
				}
				return batches;
			},
			act: async () => {
				switch (path) {
					case 'execute':
						return await dsql.execute(update);
					case 'query':
						return { rowCount: (await dsql.query<{ id: string }>(updateReturning)).length };
					case 'transaction':
						return await dsql.transaction((tx) => tx.execute(update));
					case 'transaction-query':
						return { rowCount: (await dsql.transaction((tx) => tx.query<{ id: string }>(updateReturning))).length };
					default:
						throw new Error(`unknown dsql mutation path ${path}`);
				}
			},
			// Delete by the ids actually generated, even when seeding stopped part-way.
			cleanup: async (_batches, rows) => {
				for (const ids of idBatches(prefix, rows, SEED_BATCH)) {
					await dsql.execute(
						sql`DELETE FROM dsql_items WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`,
					);
				}
			},
		});
	};
}
