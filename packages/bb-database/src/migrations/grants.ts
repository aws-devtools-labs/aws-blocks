// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine } from '../common/engine.js';
import { DEFAULT_SCHEMA, quoteIdent } from '../constants.js';

export interface SchemaGrants {
	tables: number;
	views: number;
	matviews: number;
	sequences: number;
}

/**
 * What the app role may do in a block's schema: DML on its tables, `SELECT` on its views, `USAGE` on its
 * sequences, and nothing on the migration ledger. Idempotent. The migration Lambda runs it on every deploy and
 * the local cluster on every engine build, so tables a new migration adds get their grants.
 */
export async function grantSchemaAccess(
	engine: DatabaseEngine,
	role: string,
	schemaName: string,
): Promise<SchemaGrants> {
	// `public` is a DSQL system entity: a schema-level grant on it is rejected, and custom roles can use it without
	// one. PostgreSQL grants PUBLIC usage on it, so the skip holds for Aurora too.
	if (schemaName !== DEFAULT_SCHEMA)
		await engine.execute(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO ${quoteIdent(role)}`);
	const tables = await engine.query<{ tablename: string }>(
		`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT IN ('_migrations', '_migration_progress')`,
		[schemaName],
	);
	if (tables.length > 0) {
		const list = tables.map((t) => `${quoteIdent(schemaName)}.${quoteIdent(t.tablename)}`).join(', ');
		await engine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${list} TO ${quoteIdent(role)}`);
	}
	const views = await engine.query<{ viewname: string }>('SELECT viewname FROM pg_views WHERE schemaname = $1', [
		schemaName,
	]);
	if (views.length > 0) {
		const list = views.map((v) => `${quoteIdent(schemaName)}.${quoteIdent(v.viewname)}`).join(', ');
		await engine.execute(`GRANT SELECT ON ${list} TO ${quoteIdent(role)}`);
	}
	const matviews = await engine.query<{ matviewname: string }>(
		'SELECT matviewname FROM pg_matviews WHERE schemaname = $1',
		[schemaName],
	);
	if (matviews.length > 0) {
		const list = matviews.map((v) => `${quoteIdent(schemaName)}.${quoteIdent(v.matviewname)}`).join(', ');
		await engine.execute(`GRANT SELECT ON ${list} TO ${quoteIdent(role)}`);
	}
	const sequences = await engine.query<{ sequencename: string }>(
		'SELECT sequencename FROM pg_sequences WHERE schemaname = $1',
		[schemaName],
	);
	if (sequences.length > 0) {
		const list = sequences.map((s) => `${quoteIdent(schemaName)}.${quoteIdent(s.sequencename)}`).join(', ');
		await engine.execute(`GRANT USAGE, SELECT ON ${list} TO ${quoteIdent(role)}`);
	}
	return { tables: tables.length, views: views.length, matviews: matviews.length, sequences: sequences.length };
}
