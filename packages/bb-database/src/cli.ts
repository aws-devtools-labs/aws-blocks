#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * bb-database CLI.
 *
 *   migrate --explain [dir]
 *       Print the plan the rewriter would run, without running it, and list
 *       every foreign key whose referential action the migration defines.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
import { loadMigrationFiles } from './migrations/runner.js';

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

/** Extract `--flag value` (or `--flag=value`); returns the value and strips it from args. */
function fail(message: string): never {
	console.error(`\n❌ ${message}`);
	process.exit(1);
}

async function migrate(args: string[]): Promise<void> {
	const explain = args.includes('--explain');
	if (explain) args.splice(args.indexOf('--explain'), 1);
	if (!explain) {
		fail(
			'migrate runs only with --explain. Locally a block applies its migrations on first use; on AWS the migration Lambda applies them at deploy.',
		);
	}
	const dir = resolve(args[0] ?? './aws-blocks/migrations');
	if (!existsSync(dir)) fail(`Migrations directory not found: ${dir}`);
	const plan = buildMigrationPlan(loadMigrationFiles(dir));
	console.log(formatMigrationPlan(plan));
	const fks = plan.files.flatMap((f) => f.foreignKeys.map((fk) => `${f.file}: ${fk}`));
	if (fks.length > 0)
		console.log(`\nForeign keys whose referential action these migrations define:\n  ${fks.join('\n  ')}`);
}

async function main(): Promise<void> {
	const args = rawArgs.slice(1);
	switch (command) {
		case 'migrate':
			return migrate(args);
		default:
			console.log('Usage: bb-database <migrate> [options]\n');
			console.log('  migrate --explain [dir]');
			process.exit(command ? 1 : 0);
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
