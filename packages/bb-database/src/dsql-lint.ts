// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The DSQL compatibility checker: AWS's `dsql-lint`, the linter the Aurora DSQL
 * team maintains (https://github.com/awslabs/aurora-dsql-tools). It parses the
 * SQL, so a keyword inside a string literal is never a false positive, and its
 * rule set tracks DSQL releases. `@aws/dsql-lint` ships a native binary per
 * platform as optional dependencies; this module locates it, runs it on a
 * statement or a file's worth of SQL, and caches the result per text, because
 * the local mock checks every statement a handler issues.
 *
 * The binary is never needed on AWS: the migration Lambda runs plans that were
 * validated at synth, and the app runtime does no validation.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { configError } from './errors.js';

const require = createRequire(import.meta.url);

/** Mirrors the platform table in `@aws/dsql-lint`'s own `bin/dsql-lint` wrapper. */
const PLATFORM_PACKAGES: Record<string, string> = {
	'darwin-arm64': '@aws/dsql-lint-darwin-arm64',
	'darwin-x64': '@aws/dsql-lint-darwin-x64',
	'linux-arm64': '@aws/dsql-lint-linux-arm64',
	'linux-x64': '@aws/dsql-lint-linux-x64',
	'win32-x64': '@aws/dsql-lint-win32-x64',
};

/** One finding from `dsql-lint --format json`. */
export interface LintDiagnostic {
	/** The rule id, e.g. `truncate`, `foreign_key_not_valid`, `parse_error`. */
	rule: string;
	message: string;
	suggestion: string;
	/** 1-based line in the linted text. */
	line?: number;
	statementPreview?: string;
}

interface LintOutput {
	schema_version: number;
	files: {
		diagnostics: { rule: string; message: string; suggestion: string; line?: number; statement_preview?: string }[];
		error: string | null;
	}[];
}

const CACHE_LIMIT = 2000;
const cache = new Map<string, LintDiagnostic[]>();
let binaryPath: string | undefined;

/** Path to the `dsql-lint` binary for this platform; `DSQL_LINT_PATH` overrides the lookup. */
export function dsqlLintBinary(): string {
	if (binaryPath) return binaryPath;
	const override = process.env.DSQL_LINT_PATH;
	if (override) {
		if (!existsSync(override)) throw configError(`DSQL_LINT_PATH points to '${override}', which does not exist.`);
		binaryPath = override;
		return override;
	}
	const key = `${process.platform}-${process.arch}`;
	const packageName = PLATFORM_PACKAGES[key];
	if (!packageName) {
		throw configError(
			`dsql-lint has no binary for ${key} (supported: ${Object.keys(PLATFORM_PACKAGES).join(', ')}). ` +
				'Set DSQL_LINT_PATH to a dsql-lint build for this platform.',
		);
	}
	let packageDir: string;
	try {
		packageDir = dirname(require.resolve(`${packageName}/package.json`));
	} catch {
		throw configError(
			`The dsql-lint binary package '${packageName}' is not installed. It is an optional dependency of ` +
				'@aws/dsql-lint; run `npm install @aws/dsql-lint --include=optional`, or set DSQL_LINT_PATH.',
		);
	}
	binaryPath = join(packageDir, 'bin', process.platform === 'win32' ? 'dsql-lint.exe' : 'dsql-lint');
	return binaryPath;
}

/** Whether the binary can be found (does not run it). */
export function isDsqlLintAvailable(): boolean {
	try {
		dsqlLintBinary();
		return true;
	} catch {
		return false;
	}
}

/**
 * Lint SQL (one statement or a whole file) for Aurora DSQL compatibility.
 * Returns dsql-lint's diagnostics, empty when the SQL is accepted. A text that
 * does not parse comes back as one `parse_error` diagnostic.
 */
export function lintSql(sql: string): LintDiagnostic[] {
	const cached = cache.get(sql);
	if (cached) return cached;
	const result = spawnSync(dsqlLintBinary(), ['--format', 'json', '-'], { encoding: 'utf-8', input: sql });
	if (result.error) throw configError(`dsql-lint could not be run: ${result.error.message}`);
	// Exit 0: clean. Exit 1: findings. Anything else is a usage or runtime failure.
	if (result.status !== 0 && result.status !== 1) {
		throw configError(`dsql-lint exited with status ${result.status}: ${result.stderr.trim()}`);
	}
	let output: LintOutput;
	try {
		output = JSON.parse(result.stdout) as LintOutput;
	} catch {
		throw configError(`dsql-lint returned unreadable output: ${result.stdout.slice(0, 200)}`);
	}
	const file = output.files?.[0];
	if (output.schema_version !== 1 || !file) {
		throw configError(
			`dsql-lint output schema ${output.schema_version} is not supported by this version of bb-database.`,
		);
	}
	const diagnostics: LintDiagnostic[] = file.error
		? [{ rule: 'dsql_lint_error', message: file.error, suggestion: '' }]
		: file.diagnostics.map((d) => ({
				rule: d.rule,
				message: d.message,
				suggestion: d.suggestion,
				line: d.line,
				statementPreview: d.statement_preview,
			}));
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(sql, diagnostics);
	return diagnostics;
}

/** Render a diagnostic for an error message. */
export function formatDiagnostic(d: LintDiagnostic): string {
	return `${d.rule}: ${d.message}${d.suggestion ? ` ${d.suggestion}` : ''}`;
}
