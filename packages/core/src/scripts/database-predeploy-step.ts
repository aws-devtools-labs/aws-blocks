// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-`cdk deploy` step for apps that use `@aws-blocks/bb-database`: the deploy
 * guard (production only — a `Database` keeps its cluster for life) and the
 * host-side migrations for blocks on `DatabaseCluster.fromExisting()`.
 *
 * `core` must not depend on `bb-database` (the dependency runs the other way),
 * so this invokes the `bb-database` CLI as a subprocess — the same pattern
 * `applyExternalMigrations` uses for `bb-data`. It is a no-op when the package
 * is not installed in the project, so apps without a `Database` pay nothing.
 */
import { createRequire } from 'node:module';
import { runSync } from './run-command.js';

const BB_DATABASE_PACKAGE = '@aws-blocks/bb-database';

/** Whether the project depends on `@aws-blocks/bb-database` (resolvable from its root). */
export function hasDatabasePackage(projectRoot: string): boolean {
	try {
		createRequire(`${projectRoot}/package.json`).resolve(`${BB_DATABASE_PACKAGE}/package.json`);
		return true;
	} catch {
		return false;
	}
}

export interface DatabasePredeployOptions {
	stage: 'sandbox' | 'production';
	projectRoot: string;
	/** The `cdk --app` command when the deploy passes one explicitly (sandbox). */
	app?: string;
}

/** Build the argv for the `bb-database predeploy` subprocess (pure, for tests). */
export function buildPredeployArgs(options: DatabasePredeployOptions): string[] {
	const args = [
		'--no-install',
		'bb-database',
		'predeploy',
		'--stage',
		options.stage,
		'--project-root',
		options.projectRoot,
	];
	if (options.app) args.push('--app', options.app);
	return args;
}

/**
 * Run the predeploy step. Returns true when it ran, false when the project has
 * no `bb-database` dependency. A guard stop exits the subprocess non-zero, which
 * surfaces here as a thrown error and aborts the deploy.
 */
export function runDatabasePredeploy(options: DatabasePredeployOptions): boolean {
	if (!hasDatabasePackage(options.projectRoot)) return false;
	runSync('npx', buildPredeployArgs(options), { stdio: 'inherit', cwd: options.projectRoot });
	return true;
}
