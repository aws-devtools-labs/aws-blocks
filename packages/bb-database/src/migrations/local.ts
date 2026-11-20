// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_SCHEMA, LOCAL_APP_ROLE, quoteIdent } from '../constants.js';
import type { RulesEngine } from '../dialect/rules-engine.js';
import type { SchemaEngine } from '../engines/pglite-cluster.js';
import type { ClusterKind, ClusterType } from '../types.js';
import { grantSchemaAccess } from './grants.js';
import { buildMigrationPlan, lintMigrationFiles } from './plan.js';
import { loadMigrationFiles, runMigrationPlan } from './runner.js';

interface LocalSchemaOptions {
	kind: ClusterType;
	/** The kind whose file check applies, when it is not `kind`. */
	fileKind?: ClusterKind;
	schemaName: string;
	migrationsPath: string | undefined;
	log: (message: string) => void;
}

/**
 * What a local block does before its first statement, as the cluster admin: apply its migration files (or
 * create its schema when it has none), then give the local app role the grants the deployed app role gets.
 * Returns the files it applied. Used by the local entry and by `npm run db -- types --block`.
 */
export function prepareLocalSchema(
	engine: RulesEngine,
	inner: SchemaEngine,
	options: LocalSchemaOptions,
): Promise<string[]> {
	const { kind, schemaName, migrationsPath } = options;
	return engine.asAdmin(async () => {
		let applied: string[] = [];
		if (migrationsPath) {
			const files = loadMigrationFiles(migrationsPath);
			lintMigrationFiles(files, options.fileKind ?? kind);
			// The block's statements run as the local app role on every kind of local cluster.
			const plan = buildMigrationPlan(files, kind, quoteIdent(LOCAL_APP_ROLE));
			({ applied } = await runMigrationPlan(engine, plan, { schemaName, log: options.log }).finally(() =>
				// A file may have changed the session's search_path or role.
				inner.cluster.forgetSession(),
			));
		} else if (schemaName !== DEFAULT_SCHEMA) {
			await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
		}
		// What the migration Lambda grants the deployed app role; the block's statements run as this one.
		await grantSchemaAccess(engine, LOCAL_APP_ROLE, schemaName);
		return applied;
	});
}
