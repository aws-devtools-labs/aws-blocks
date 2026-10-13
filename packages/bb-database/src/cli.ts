#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * bb-database CLI.
 *
 *   migrate --explain [dir] [--target distributed]
 *       Print the plan the rewriter would run, without running it, and list
 *       every foreign key whose referential action the migration defines.
 *
 *   predeploy --stage sandbox|production --project-root <dir> [--app <cdk app>]
 *       Run the block's pre-deploy hook by hand: synthesize the app and run the
 *       deploy guard. `npm run deploy` runs the same hook itself, discovered
 *       from this package's `aws-blocks.predeploy` manifest field.
 *
 *   guard --stack <name> --template <path>
 *       Run the deploy guard against one synthesized template.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type DeployStage, synthesizeApp } from '@aws-blocks/core/scripts';
import { guardDeploy } from './deploy-guard.js';
import { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
import { loadMigrationFiles } from './migrations/runner.js';
import { predeploy as runPredeploy } from './predeploy.js';

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
	const target = takeFlag(args, '--target') ?? 'distributed';
	if (target !== 'distributed') fail(`--target accepts only 'distributed' in this release (got '${target}').`);
	if (!explain) {
		fail(
			'migrate runs only with --explain. Locally a block applies its migrations on first use; on AWS the migration Lambda applies them at deploy.',
		);
	}
	const dir = resolve(args[0] ?? './aws-blocks/migrations');
	if (!existsSync(dir)) fail(`Migrations directory not found: ${dir}`);
	const plan = buildMigrationPlan(loadMigrationFiles(dir), target);
	console.log(formatMigrationPlan(plan));
	const fks = plan.files.flatMap((f) => f.foreignKeys.map((fk) => `${f.file}: ${fk}`));
	if (fks.length > 0)
		console.log(`\nForeign keys whose referential action these migrations define:\n  ${fks.join('\n  ')}`);
}

async function predeploy(args: string[]): Promise<void> {
	const stage = (takeFlag(args, '--stage') ?? 'production') as DeployStage;
	const projectRoot = resolve(takeFlag(args, '--project-root') ?? process.cwd());
	const app = takeFlag(args, '--app');
	if (stage !== 'sandbox' && stage !== 'production') fail(`--stage must be sandbox or production (got '${stage}').`);

	let synthesized: ReturnType<typeof synthesizeApp> | undefined;
	try {
		const result = await runPredeploy({
			stage,
			projectRoot,
			async synth() {
				synthesized ??= synthesizeApp({ stage, projectRoot, app });
				return synthesized.stacks;
			},
		});
		for (const note of result.notes ?? []) console.log(`[bb-database] ${note}`);
		if (result.stops?.length) fail(result.stops.join('\n\n'));
	} finally {
		synthesized?.cleanup();
	}
}

async function guard(args: string[]): Promise<void> {
	const stackName = takeFlag(args, '--stack');
	const templatePath = takeFlag(args, '--template');
	if (!stackName || !templatePath) fail('guard needs --stack <name> and --template <path>');
	const template = JSON.parse(readFileSync(resolve(templatePath as string), 'utf-8'));
	const result = await guardDeploy({ stackName: stackName as string, template });
	for (const note of result.notes) console.log(`[bb-database] ${note}`);
	if (result.stops.length > 0) fail(result.stops.join('\n\n'));
	console.log('[bb-database] Deploy guard passed.');
}

async function main(): Promise<void> {
	const args = rawArgs.slice(1);
	switch (command) {
		case 'migrate':
			return migrate(args);
		case 'predeploy':
			return predeploy(args);
		case 'guard':
			return guard(args);
		default:
			console.log('Usage: bb-database <migrate|predeploy|guard> [options]\n');
			console.log('  migrate --explain [dir] [--target distributed]');
			console.log('  predeploy --stage sandbox|production --project-root <dir> [--app <cdk app>]');
			console.log('  guard --stack <name> --template <path>');
			process.exit(command ? 1 : 0);
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
