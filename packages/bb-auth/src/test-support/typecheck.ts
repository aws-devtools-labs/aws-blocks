// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typecheck snippets of customer code against the real, built packages: the
 * files are written under this package's `dist/`, so `@aws-blocks/*` resolve
 * through the workspace `node_modules` exactly as an app's would.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `packages/bb-auth`. */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The repo root. */
export const REPO_ROOT = join(PACKAGE_DIR, '..', '..');

/** A scratch directory inside `dist/`, so package resolution works. Remove it with {@link removeScratch}. */
export function scratchDir(label: string): string {
	const base = join(PACKAGE_DIR, 'dist', '.typecheck-scratch');
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, `${label}-`));
}

export function removeScratch(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/** Write `files` (relative path → text) under `dir`. */
export function writeFiles(dir: string, files: Record<string, string>): string[] {
	return Object.entries(files).map(([rel, text]) => {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
		return abs;
	});
}

/**
 * Typecheck `rootFiles` the way an AWS Blocks app is compiled (strict, ESM,
 * bundler resolution, default conditions → the mock entry's types). Returns
 * the formatted diagnostics; empty means it compiles.
 */
export function typecheck(rootFiles: readonly string[], paths: Record<string, string[]> = {}): string[] {
	const options: ts.CompilerOptions = {
		strict: true,
		noEmit: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		lib: ['lib.es2022.d.ts', 'lib.esnext.array.d.ts', 'lib.dom.d.ts'],
		types: ['node'],
		skipLibCheck: true,
		esModuleInterop: true,
		...(Object.keys(paths).length > 0 ? { paths } : {}),
	};
	const program = ts.createProgram(rootFiles, options);
	return ts.getPreEmitDiagnostics(program).map((d) => {
		const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
		if (!d.file || d.start === undefined) return msg;
		const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
		return `${d.file.fileName.slice(PACKAGE_DIR.length + 1)}:${line + 1}:${character + 1} ${msg}`;
	});
}
