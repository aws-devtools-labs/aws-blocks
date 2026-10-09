// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `npx @aws-blocks/bb-auth migrate [paths…] [--dry-run]`
 *
 * Moves an app from `AuthBasic` / `AuthCognito` / `AuthOIDC` to `Auth`:
 * rewrites imports, class names, options, renamed methods and error names, and
 * leaves `// TODO(aws-blocks-auth-migrate): …` comments wherever a person must
 * decide. It never changes a block's `id` argument. See `MIGRATION.md`.
 *
 * TypeScript is loaded lazily from the project being migrated (falling back to
 * a copy next to this package), so `@aws-blocks/bb-auth` itself carries no
 * TypeScript dependency.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type OldBlock, SUMMARY_WARNINGS, TODO_TAG } from './rules.js';
import { unifiedDiff } from './text.js';
import {
	analyzeFile,
	type FileResult,
	moduleKey,
	type ProjectInfo,
	type SummaryWarning,
	type TypeScript,
	transformFile,
} from './transform.js';

const USAGE = `Usage: npx @aws-blocks/bb-auth migrate [paths…] [--dry-run]

Migrates AuthBasic / AuthCognito / AuthOIDC code to the Auth Building Block.

  paths       Files or directories to migrate (default: the current directory).
              node_modules, dist, build, cdk.out and dot-directories are skipped.
  --dry-run   Print a unified diff of what would change; write nothing.
  --help      Show this help.

The block id argument (new Auth(scope, '<id>')) is never changed: changing it
would replace the Cognito user pool and delete every user in it.

Read MIGRATION.md in @aws-blocks/bb-auth before you deploy.`;

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'cdk.out', 'coverage', 'out']);

/** Options for {@link runMigrate}. */
export interface MigrateOptions {
	/** Files or directories, relative to `cwd`. Default `['.']`. */
	paths?: readonly string[];
	dryRun?: boolean;
	/** Working directory. Default `process.cwd()`. */
	cwd?: string;
	/** The `typescript` module to use. Default: loaded lazily (see {@link loadTypeScript}). */
	ts?: TypeScript;
	/** Where output goes. Default `console.log`. */
	log?: (line: string) => void;
}

/** What {@link runMigrate} did. */
export interface MigrateSummary {
	scanned: number;
	/** Every file written (or, with `dryRun`, that would be), including those in {@link MigrateSummary.attention}. */
	changed: string[];
	/**
	 * Files the codemod could not finish (e.g. an import whose name list would
	 * have ended up empty). Reported as "needs attention", never as rewritten.
	 */
	attention: { file: string; reasons: string[] }[];
	failed: { file: string; error: string }[];
	todos: number;
}

/**
 * Load TypeScript: the migrated project's own copy first, then one resolvable
 * from this package. Never a static import, so the package has no TypeScript
 * dependency at runtime.
 */
export async function loadTypeScript(cwd: string): Promise<TypeScript> {
	const bases = [join(cwd, 'package.json'), import.meta.url];
	for (const base of bases) {
		let resolved: string;
		try {
			resolved = createRequire(base).resolve('typescript');
		} catch {
			continue;
		}
		const mod: { default?: TypeScript } & Partial<TypeScript> = await import(pathToFileURL(resolved).href);
		const ts = mod.default ?? mod;
		if (typeof ts.createSourceFile === 'function') return ts as TypeScript;
	}
	throw new Error(
		'bb-auth migrate needs the `typescript` package. Run it from your project (which has TypeScript installed), ' +
			'or: npx -p typescript -p @aws-blocks/bb-auth bb-auth migrate',
	);
}

/** Collect source files under `paths`. */
export function collectFiles(cwd: string, paths: readonly string[]): string[] {
	const out: string[] = [];
	const walk = (abs: string, explicit: boolean): void => {
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(abs);
		} catch {
			return;
		}
		if (st.isDirectory()) {
			const name = abs.split(/[\\/]/).pop() ?? '';
			if (!explicit && (SKIP_DIRS.has(name) || name.startsWith('.'))) return;
			for (const entry of readdirSync(abs).sort()) walk(join(abs, entry), false);
		} else if (st.isFile() && SOURCE_EXT.test(abs) && !abs.endsWith('.d.ts')) {
			out.push(abs);
		}
	};
	for (const p of paths) walk(resolve(cwd, p), true);
	return [...new Set(out)];
}

/** Run the codemod. Exported for tests; the bin calls it through {@link main}. */
export async function runMigrate(options: MigrateOptions = {}): Promise<MigrateSummary> {
	const cwd = options.cwd ?? process.cwd();
	const log = options.log ?? ((line: string) => console.log(line));
	const ts = options.ts ?? (await loadTypeScript(cwd));
	const files = collectFiles(cwd, options.paths && options.paths.length > 0 ? options.paths : ['.']);
	const sources = new Map<string, string>();
	for (const f of files) sources.set(f, readFileSync(f, 'utf8'));

	// Pass 1: what the project uses, and which modules export an old block instance.
	const blocks = new Set<OldBlock>();
	const instanceExports = new Map<string, Map<string, OldBlock>>();
	for (const [file, text] of sources) {
		const a = analyzeFile(ts, file, text);
		for (const b of a.blocks) blocks.add(b);
		if (a.instanceExports.size > 0) instanceExports.set(moduleKey(file), a.instanceExports);
	}
	const project: ProjectInfo = { blocks, instanceExports };

	// Pass 2: transform.
	const summary: MigrateSummary = { scanned: files.length, changed: [], attention: [], failed: [], todos: 0 };
	const results: { file: string; result: FileResult }[] = [];
	for (const [file, text] of sources) {
		const rel = relative(cwd, file) || file;
		try {
			const result = transformFile(ts, file, text, project);
			if (result.changed || result.attention.length > 0) results.push({ file, result });
			if (result.attention.length > 0) summary.attention.push({ file: rel, reasons: result.attention });
		} catch (e) {
			summary.failed.push({ file: rel, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
		}
	}
	for (const { file, result } of results) {
		if (!result.changed) continue;
		const rel = relative(cwd, file) || file;
		summary.changed.push(rel);
		summary.todos += result.todos;
		if (options.dryRun) log(unifiedDiff(rel, sources.get(file) ?? '', result.output).trimEnd());
		else writeFileSync(file, result.output);
	}

	log('');
	log(`bb-auth migrate${options.dryRun ? ' (dry run — nothing written)' : ''}`);
	const rewritten = results.filter((r) => r.result.attention.length === 0);
	const attention = results.filter((r) => r.result.attention.length > 0);
	log(
		`  scanned ${summary.scanned} file(s); ${options.dryRun ? 'would change' : 'changed'} ${rewritten.length}` +
			(attention.length > 0 ? `; ${attention.length} need(s) attention` : ''),
	);
	for (const { file, result } of rewritten) {
		const rel = relative(cwd, file) || file;
		log(`  ${rel}${result.todos > 0 ? ` (${result.todos} TODO)` : ''}`);
		for (const c of result.changes) log(`    - ${c}`);
	}
	for (const { file, result } of attention) {
		const rel = relative(cwd, file) || file;
		log(`  ⚠ ${rel}: needs attention${result.todos > 0 ? ` (${result.todos} TODO)` : ''}`);
		for (const reason of result.attention) log(`    ! ${reason}`);
		for (const c of result.changes) log(`    - ${c}`);
	}
	for (const f of summary.failed) log(`  ✗ ${f.file}: ${f.error} (left unchanged)`);
	if (results.length === 0 && summary.failed.length === 0) log('  nothing to migrate.');
	if (summary.todos > 0) log(`\n  ${summary.todos} place(s) need a decision: search for ${TODO_TAG}.`);
	const warnings = new Set<SummaryWarning>(results.flatMap(({ result }) => result.warnings));
	for (const w of warnings) {
		log('');
		for (const line of SUMMARY_WARNINGS[w]) log(`  ${line}`);
	}
	if (blocks.size > 0) {
		log('\nNext steps (MIGRATION.md):');
		log('  1. In package.json, replace @aws-blocks/bb-auth-basic / -cognito / -oidc with @aws-blocks/bb-auth');
		log('     (apps on @aws-blocks/blocks only need to update it), then npm install.');
		log('  2. Resolve every TODO, then typecheck and run your tests.');
		log('  3. Deploy this output with no other configuration change, then commit aws-blocks/baselines/ (the');
		log("     user pool's immutability baseline). Change the auth configuration only after that: from then on,");
		log('     synth refuses a change that would delete the pool.');
		if (blocks.has('basic'))
			log('  4. AuthBasic: export your users first — they must sign up again after the deploy.');
	}
	return summary;
}

/** The bin entry point. */
export async function main(argv: readonly string[]): Promise<number> {
	const args = [...argv];
	if (args[0] === 'migrate') args.shift();
	else if (args[0] !== undefined && !args[0].startsWith('-')) {
		console.error(`Unknown command: ${args[0]}\n\n${USAGE}`);
		return 2;
	}
	if (args.includes('--help') || args.includes('-h') || argv.length === 0) {
		console.log(USAGE);
		return argv.length === 0 ? 2 : 0;
	}
	const unknown = args.filter((a) => a.startsWith('-') && a !== '--dry-run');
	if (unknown.length > 0) {
		console.error(`Unknown option: ${unknown.join(', ')}\n\n${USAGE}`);
		return 2;
	}
	try {
		const summary = await runMigrate({
			paths: args.filter((a) => !a.startsWith('-')),
			dryRun: args.includes('--dry-run'),
		});
		return summary.failed.length > 0 ? 1 : 0;
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 1;
	}
}
