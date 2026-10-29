// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { configError } from './errors.js';

const require = createRequire(import.meta.url);

const PLATFORM_PACKAGES: Record<string, string> = {
	'darwin-arm64': '@aws/dsql-lint-darwin-arm64',
	'darwin-x64': '@aws/dsql-lint-darwin-x64',
	'linux-arm64': '@aws/dsql-lint-linux-arm64',
	'linux-x64': '@aws/dsql-lint-linux-x64',
	'win32-x64': '@aws/dsql-lint-win32-x64',
};

export interface LintDiagnostic {
	rule: string;
	message: string;
	suggestion: string;
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

/** @internal */
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

/** @internal */
export function isDsqlLintAvailable(): boolean {
	try {
		dsqlLintBinary();
		return true;
	} catch {
		return false;
	}
}

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

export function formatDiagnostic(d: LintDiagnostic): string {
	return `${d.rule}: ${d.message}${d.suggestion ? ` ${d.suggestion}` : ''}`;
}
