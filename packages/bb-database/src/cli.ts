#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * bb-database CLI.
 *
 *   migrate --explain [dir] [--target distributed|provisioned|external]
 *       Print the plan the rewriter would run, without running it, and list
 *       every foreign key whose referential action the migration defines.
 *
 *   migrate [dir] --url <connection string> [--schema <name>] [--stage <name>]
 *       Apply a block's migrations to an external PostgreSQL (host-side). The
 *       connection string may also come from BLOCKS_MIGRATE_URL so it never
 *       appears in the process list.
 *
 *   predeploy --stage sandbox|production --project-root <dir> [--app <cdk app>]
 *       The pre-`cdk deploy` step the AWS Blocks deploy scripts invoke:
 *       synthesizes the app, runs the deploy guard (production only), and
 *       applies host-side migrations for blocks on fromExisting() clusters.
 *
 *   guard --stack <name> --template <path>
 *       Run the deploy guard against one synthesized template.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { guardDeploy } from './deploy-guard.js';
import { PgClientEngine } from './engines/pg-client-engine.js';
import { externalMigrationsFromTemplate } from './infra/bindings-metadata.js';
import { buildMigrationPlan, formatMigrationPlan } from './migrations/plan.js';
import { appliedMigrations, ensureMigrationTables, loadMigrationFiles, runMigrationPlan } from './migrations/runner.js';
import type { ClusterKind, ExternalSslOptions } from './types.js';

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

/** TLS for a host-side connection: pin `DATABASE_CA_CERT` when present, otherwise encrypted-but-unverified (refused in CI). */
function hostSideSsl(): ExternalSslOptions {
	const source = process.env.DATABASE_CA_CERT;
	if (source?.trim()) {
		const ca = source.includes('-----BEGIN CERTIFICATE-----') ? source : readFileSync(source, 'utf8');
		return { ca, rejectUnauthorized: true };
	}
	const ci = process.env.CI;
	if (ci && ci !== 'false' && ci !== '0') {
		fail(
			'No CA certificate (DATABASE_CA_CERT unset) in a non-interactive run; refusing an unverified connection for migrations.',
		);
	}
	console.warn(
		'[bb-database] DB TLS: server certificate NOT verified. Set DATABASE_CA_CERT to your provider CA to verify it.',
	);
	return { rejectUnauthorized: false };
}

/** Rewrite a pooled connection string to the 5432 session port (DDL and transactions need a stable session). */
export function toSessionPortUrl(connectionString: string): string {
	const url = new URL(connectionString);
	url.port = '5432';
	url.searchParams.delete('prepared_statements');
	url.searchParams.delete('sslmode');
	return url.toString();
}

/** Resolve the connection string for host-side migrations from the environment, if any. */
export function findMigrateUrl(): string | undefined {
	if (process.env.BLOCKS_MIGRATE_URL) return process.env.BLOCKS_MIGRATE_URL;
	for (const [name, value] of Object.entries(process.env)) {
		if (/_(DB_URL|CONNECTION_STRING)$/.test(name) && value) return value;
	}
	return undefined;
}

async function applyExternal(connectionString: string, dir: string, schemaName: string, label: string): Promise<void> {
	const engine = new PgClientEngine({
		connectionString: toSessionPortUrl(connectionString),
		ssl: hostSideSsl(),
		poolSize: 1,
		connectionTimeoutMillis: 10_000,
		searchPath: schemaName !== 'public' ? schemaName : undefined,
	});
	try {
		const files = existsSync(dir) ? loadMigrationFiles(dir) : {};
		const plan = buildMigrationPlan(files, 'external');
		const applied = await runMigrationPlan(engine, plan, { schemaName });
		console.log(
			`[bb-database] ${label}: schema '${schemaName}', applied ${applied.length}${applied.length ? `: ${applied.join(', ')}` : ' (nothing pending)'}`,
		);
	} finally {
		await engine.destroy();
	}
}

async function migrate(args: string[]): Promise<void> {
	const explain = args.includes('--explain');
	if (explain) args.splice(args.indexOf('--explain'), 1);
	const target = (takeFlag(args, '--target') ?? 'distributed') as ClusterKind;
	const url = takeFlag(args, '--url') ?? process.env.BLOCKS_MIGRATE_URL;
	const schema = takeFlag(args, '--schema') ?? 'public';
	takeFlag(args, '--stage');
	const dir = resolve(args[0] ?? './aws-blocks/migrations');
	if (!existsSync(dir)) fail(`Migrations directory not found: ${dir}`);
	const files = loadMigrationFiles(dir);

	if (explain) {
		const plan = buildMigrationPlan(files, target);
		let pending: Set<string> | undefined;
		if (url) {
			const engine = new PgClientEngine({
				connectionString: toSessionPortUrl(url),
				ssl: hostSideSsl(),
				poolSize: 1,
				searchPath: schema !== 'public' ? schema : undefined,
			});
			try {
				await ensureMigrationTables(engine, schema);
				const applied = await appliedMigrations(engine);
				pending = new Set(plan.files.map((f) => f.file).filter((f) => !applied.has(f)));
			} finally {
				await engine.destroy();
			}
		}
		console.log(formatMigrationPlan(plan, { pending }));
		const fks = plan.files.flatMap((f) => f.foreignKeys.map((fk) => `${f.file}: ${fk}`));
		if (fks.length > 0)
			console.log(`\nForeign keys whose referential action these migrations define:\n  ${fks.join('\n  ')}`);
		return;
	}

	if (!url)
		fail(
			'migrate needs --url <connection string> (or BLOCKS_MIGRATE_URL). Local PGlite databases migrate themselves on `npm run dev`.',
		);
	await applyExternal(url as string, dir, schema, dir);
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
	const migrateUrl = findMigrateUrl();

	// The sandbox stage skips the guard; without an external connection string
	// there is nothing to do, so skip the synth as well.
	if (stage === 'sandbox' && !migrateUrl) return;

	const { stacks, cleanup } = synthesize(projectRoot, stage, app);
	try {
		for (const stack of stacks) {
			if (stage === 'production') {
				const result = await guardDeploy({ stackName: stack.stackName, template: stack.template });
				for (const note of result.notes) console.log(`[bb-database] ${note}`);
				if (result.stops.length > 0) fail(result.stops.join('\n\n'));
			}
			const externals = externalMigrationsFromTemplate(stack.template);
			if (externals.length > 0 && migrateUrl) {
				for (const entry of externals) {
					await applyExternal(
						migrateUrl,
						resolve(projectRoot, entry.migrationsPath),
						entry.schemaName,
						entry.fullId,
					);
				}
			} else if (externals.length > 0) {
				console.warn(
					'[bb-database] Blocks on fromExisting() clusters have migrations, but no connection string was found in the environment; skipping.',
				);
			}
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
			console.log(
				'  migrate --explain [dir] [--target distributed|provisioned|external] [--url <conn> --schema <name>]',
			);
			console.log('  migrate [dir] --url <conn> [--schema <name>]');
			console.log('  predeploy --stage sandbox|production --project-root <dir> [--app <cdk app>]');
			console.log('  guard --stack <name> --template <path>');
			process.exit(command ? 1 : 0);
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
