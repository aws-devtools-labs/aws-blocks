#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * bb-database CLI.
 *
 *   migrate --explain [dir]
 *       Print the plan the rewriter would run, without running it, and list
 *       every foreign key whose referential action the migration defines.
 *
 *   predeploy [--project-root <dir>]
 *       Dry run of the production pre-deploy hooks `npm run deploy` runs,
 *       including this block's deploy guard. Prints their notes; exits
 *       non-zero on a stop. Nothing is deployed.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPredeployHooks } from '@aws-blocks/core/scripts';
import { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
import { loadMigrationFiles } from './migrations/runner.js';

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

/** Extract `--flag value` (or `--flag=value`); returns the value and strips it from args. */
function takeFlag(args: string[], flag: string): string | undefined {
	const eq = args.find((a) => a.startsWith(`${flag}=`));
	if (eq) {
		args.splice(args.indexOf(eq), 1);
		return eq.slice(flag.length + 1);
	}
	const i = args.indexOf(flag);
	if (i !== -1) {
		const val = args[i + 1];
		const isValue = val !== undefined && !val.startsWith('--');
		args.splice(i, isValue ? 2 : 1);
		return isValue ? val : '';
	}
	return undefined;
}

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

async function predeploy(args: string[]): Promise<void> {
	const projectRoot = resolve(takeFlag(args, '--project-root') ?? process.cwd());
	// Notes print as the hooks run; a stop throws and main() reports it.
	const { ran } = await runPredeployHooks({ stage: 'production', projectRoot });
	console.log(
		ran.length
			? `[bb-database] Pre-deploy hooks passed: ${ran.join(', ')}`
			: '[bb-database] No pre-deploy hooks declared.',
	);
}

async function main(): Promise<void> {
	const args = rawArgs.slice(1);
	switch (command) {
		case 'migrate':
			return migrate(args);
		case 'predeploy':
			return predeploy(args);
		default:
			console.log('Usage: bb-database <migrate|predeploy> [options]\n');
			console.log('  migrate --explain [dir]');
			console.log('  predeploy [--project-root <dir>]');
			process.exit(command ? 1 : 0);
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
