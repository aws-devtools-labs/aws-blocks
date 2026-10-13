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
 *       The pre-`cdk deploy` step the AWS Blocks deploy script invokes:
 *       synthesizes the app and runs the deploy guard. The sandbox stage
 *       returns at once: a sandbox stack and its clusters are destroyed anyway.
 *
 *   guard --stack <name> --template <path>
 *       Run the deploy guard against one synthesized template.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { guardDeploy } from './deploy-guard.js';
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

interface SynthesizedStack {
	stackName: string;
	template: Record<string, unknown>;
}

/** Synthesize the app into a temp directory and return every stack's template. */
function synthesize(
	projectRoot: string,
	stage: string,
	app: string | undefined,
): { stacks: SynthesizedStack[]; cleanup: () => void } {
	const out = mkdtempSync(join(tmpdir(), 'bb-database-synth-'));
	const args = ['cdk', 'synth', '--quiet', '--output', out, '--context', `projectRoot=${projectRoot}`];
	if (stage === 'sandbox') args.push('--context', 'sandboxMode=true');
	if (app) args.push('--app', app);
	const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
		cwd: projectRoot,
		stdio: ['ignore', 'ignore', 'inherit'],
		env: { ...process.env, NODE_OPTIONS: '--conditions=cdk' },
	});
	if (result.status !== 0) {
		rmSync(out, { recursive: true, force: true });
		fail(`cdk synth failed (exit ${result.status}); the deploy guard could not run.`);
	}
	const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8')) as {
		artifacts?: Record<string, { type: string; properties?: { templateFile?: string; stackName?: string } }>;
	};
	const stacks: SynthesizedStack[] = [];
	for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
		if (artifact.type !== 'aws:cloudformation:stack' || !artifact.properties?.templateFile) continue;
		stacks.push({
			stackName: artifact.properties.stackName ?? id,
			template: JSON.parse(readFileSync(join(out, artifact.properties.templateFile), 'utf-8')),
		});
	}
	return { stacks, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

async function predeploy(args: string[]): Promise<void> {
	const stage = takeFlag(args, '--stage') ?? 'production';
	const projectRoot = resolve(takeFlag(args, '--project-root') ?? process.cwd());
	const app = takeFlag(args, '--app');

	// The sandbox stage skips the guard: a sandbox stack and its clusters are destroyed anyway.
	if (stage !== 'production') return;

	const { stacks, cleanup } = synthesize(projectRoot, stage, app);
	try {
		for (const stack of stacks) {
			const result = await guardDeploy({ stackName: stack.stackName, template: stack.template });
			for (const note of result.notes) console.log(`[bb-database] ${note}`);
			if (result.stops.length > 0) fail(result.stops.join('\n\n'));
		}
	} finally {
		cleanup();
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
