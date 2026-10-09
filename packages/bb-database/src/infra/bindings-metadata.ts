// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Writes the binding record into CloudFormation stack metadata so the deploy
 * guard can diff it against the deployed template.
 */
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { emptyBindings } from '../bindings.js';
import { BINDINGS_METADATA_KEY } from '../constants.js';
import type { Bindings, ClusterType, DatabaseBinding } from '../types.js';

/** Stack-metadata key listing blocks whose migrations run host-side before deploy. */
export const EXTERNAL_MIGRATIONS_METADATA_KEY = 'aws-blocks:database-external-migrations';

/** One host-side migration job recorded for the predeploy step. */
export interface ExternalMigrationEntry {
	fullId: string;
	schemaName: string;
	/** Relative to the project root. */
	migrationsPath: string;
}

function bindingsOf(stack: cdk.Stack): Bindings {
	stack.templateOptions.metadata ??= {};
	const metadata = stack.templateOptions.metadata;
	let bindings = metadata[BINDINGS_METADATA_KEY] as Bindings | undefined;
	if (!bindings) {
		bindings = emptyBindings();
		metadata[BINDINGS_METADATA_KEY] = bindings;
	}
	return bindings;
}

/** Record a `Database` block's binding. */
export function recordDatabaseBinding(scope: Construct, fullId: string, binding: DatabaseBinding): void {
	bindingsOf(cdk.Stack.of(scope)).databases[fullId] = binding;
}

/** Record a `DatabaseCluster`. */
export function recordClusterBinding(scope: Construct, fullId: string, type: ClusterType): void {
	bindingsOf(cdk.Stack.of(scope)).clusters[fullId] = { type };
}

/** Record a block whose migrations the predeploy step applies host-side. */
export function recordExternalMigration(scope: Construct, entry: ExternalMigrationEntry): void {
	const stack = cdk.Stack.of(scope);
	stack.templateOptions.metadata ??= {};
	const metadata = stack.templateOptions.metadata;
	metadata[EXTERNAL_MIGRATIONS_METADATA_KEY] ??= [];
	const list = metadata[EXTERNAL_MIGRATIONS_METADATA_KEY] as ExternalMigrationEntry[];
	list.push(entry);
}

/** Read the binding record out of a synthesized or deployed template body. */
export function bindingsFromTemplate(template: unknown): Bindings | undefined {
	if (typeof template !== 'object' || template === null) return undefined;
	const metadata = (template as { Metadata?: Record<string, unknown> }).Metadata;
	const bindings = metadata?.[BINDINGS_METADATA_KEY] as Bindings | undefined;
	return bindings && typeof bindings === 'object' ? bindings : undefined;
}

/** Read the external-migration list out of a synthesized template body. */
export function externalMigrationsFromTemplate(template: unknown): ExternalMigrationEntry[] {
	if (typeof template !== 'object' || template === null) return [];
	const metadata = (template as { Metadata?: Record<string, unknown> }).Metadata;
	const list = metadata?.[EXTERNAL_MIGRATIONS_METADATA_KEY];
	return Array.isArray(list) ? (list as ExternalMigrationEntry[]) : [];
}
