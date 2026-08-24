// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Type-safe key generation for `getSecret` / `getConfig`.
 *
 * Scans an app's source for `secret('LITERAL')` / `config('LITERAL')` calls and
 * generates a `.d.ts` that augments {@link HostingSecretRegistry} /
 * {@link HostingConfigRegistry} (declaration merging). Once that file is in the
 * app's compilation, `getSecret` / `getConfig` narrow from open `string` to the
 * exact declared keys — editor autocomplete, and a typo is a compile error — with
 * **no code change** at the call site. The declared `secret()`/`config()` calls
 * are the single source of truth; the generated file never drifts because it is
 * derived from them (regenerate on `predev` / in CI with `--check`).
 *
 * **Static scan (no execution).** Keys are read from the source text via the
 * TypeScript compiler API — the app is never imported, so this needs no AWS
 * credentials and is safe to run on every file save. Two known limits (by design):
 *
 * - It cannot tell a *runtime* `environment` key (readable via `getSecret`) from a
 *   *synth-only* `domain` / `connectionArn` key, so the latter may appear in
 *   autocomplete even though reading it at runtime throws. Harmless, but noted.
 * - It only sees **string-literal** keys. `secret(MY_CONST)` is reported as a
 *   warning and skipped (there is nothing static to emit).
 *
 * This module is dependency-light: it uses `fast-glob` to enumerate files and
 * dynamically imports the app's own `typescript` to parse them (present in every
 * TypeScript app). It pulls in **no CDK and no AWS SDK**.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import type * as TS from 'typescript';
import type { ValueKind } from './secret.js';

/**
 * Module specifiers the generated `.d.ts` augments. **Both are required:** TypeScript
 * module augmentation narrows a function only for the *exact* specifier the caller
 * imports from — augmenting the barrel does not reach the `/secret` subpath, and vice
 * versa. Apps read via either (`@aws-blocks/hosting` or the CDK-free
 * `@aws-blocks/hosting/secret`), so we augment both; declaring the same members under
 * two module scopes is not a duplicate-identifier error.
 */
export const DEFAULT_TYPEGEN_MODULES = ['@aws-blocks/hosting', '@aws-blocks/hosting/secret'];

/** The primary module specifier the generated `.d.ts` augments. */
export const DEFAULT_TYPEGEN_MODULE = DEFAULT_TYPEGEN_MODULES[0];

/** Default globs scanned for `secret()` / `config()` calls, relative to `cwd`. */
export const DEFAULT_TYPEGEN_INCLUDE = ['aws-blocks/**/*.{ts,tsx,mts,cts}', 'src/**/*.{ts,tsx,mts,cts}'];

/** Default output path (relative to `cwd`) for the generated augmentation. */
export const DEFAULT_TYPEGEN_OUT = '.blocks/hosting-values.d.ts';

/** A `secret()` / `config()` call whose key is not a string literal — skipped, reported. */
export interface DynamicCallSite {
	/** Absolute path of the file containing the call. */
	readonly file: string;
	/** 1-based line number of the call. */
	readonly line: number;
	/** Which function was called. */
	readonly fn: ValueKind;
}

/** Result of {@link scanValueKeys}. */
export interface ScanResult {
	/** Sorted, de-duplicated keys from `secret('...')` calls. */
	readonly secretKeys: string[];
	/** Sorted, de-duplicated keys from `config('...')` calls. */
	readonly configKeys: string[];
	/** Non-literal `secret()` / `config()` calls that could not be captured statically. */
	readonly dynamicCallSites: DynamicCallSite[];
	/** Absolute paths of the files that were scanned. */
	readonly scannedFiles: string[];
}

/** Options for {@link scanValueKeys} / {@link generateHostingValuesDts}. */
export interface TypegenOptions {
	/**
	 * Working directory that `include` / `out` are resolved against.
	 * @default process.cwd()
	 */
	readonly cwd?: string;
	/**
	 * Globs to scan (relative to `cwd`, unless absolute).
	 * @default {@link DEFAULT_TYPEGEN_INCLUDE}
	 */
	readonly include?: string[];
	/**
	 * Module specifiers the generated augmentation targets. Both the barrel and the
	 * `/secret` subpath are augmented by default so `getSecret`/`getConfig` narrow
	 * regardless of which one the app imports from (see {@link DEFAULT_TYPEGEN_MODULES}).
	 * @default {@link DEFAULT_TYPEGEN_MODULES}
	 */
	readonly moduleSpecifiers?: string[];
}

/** The function names we recognize as value declarations. */
const VALUE_FNS: Record<string, ValueKind> = { secret: 'secret', config: 'config' };

/** Dynamically import the app's TypeScript compiler (present in every TS app). */
async function loadTypeScript(): Promise<typeof import('typescript')> {
	try {
		return await import('typescript');
	} catch {
		throw new Error(
			'[hosting] typegen requires the "typescript" package to parse your source. ' +
				'Install it as a dev dependency (`npm i -D typescript`) and re-run.',
		);
	}
}

/** Walk a source file collecting `secret('K')` / `config('K')` keys and non-literal call sites. */
function collectFromSourceFile(
	ts: typeof import('typescript'),
	sourceFile: TS.SourceFile,
	filePath: string,
	secretKeys: Set<string>,
	configKeys: Set<string>,
	dynamicCallSites: DynamicCallSite[],
): void {
	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const fn = VALUE_FNS[node.expression.text];
			if (fn) {
				const arg = node.arguments[0];
				if (arg && ts.isStringLiteralLike(arg)) {
					(fn === 'secret' ? secretKeys : configKeys).add(arg.text);
				} else if (arg) {
					const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
					dynamicCallSites.push({ file: filePath, line: line + 1, fn });
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
}

/**
 * Statically scan the app for `secret()` / `config()` string-literal keys.
 *
 * @param options - See {@link TypegenOptions}.
 * @returns The de-duplicated, sorted keys per kind, plus any non-literal call sites.
 */
export async function scanValueKeys(options: TypegenOptions = {}): Promise<ScanResult> {
	const cwd = options.cwd ?? process.cwd();
	const include = options.include ?? DEFAULT_TYPEGEN_INCLUDE;

	const files = await fg(include, {
		cwd,
		absolute: true,
		ignore: ['**/node_modules/**', '**/dist/**', '**/.blocks/**', '**/*.d.ts'],
	});

	const ts = await loadTypeScript();
	const secretKeys = new Set<string>();
	const configKeys = new Set<string>();
	const dynamicCallSites: DynamicCallSite[] = [];

	for (const file of files) {
		const text = await readFile(file, 'utf-8');
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
		collectFromSourceFile(ts, sourceFile, file, secretKeys, configKeys, dynamicCallSites);
	}

	return {
		secretKeys: [...secretKeys].sort(),
		configKeys: [...configKeys].sort(),
		dynamicCallSites,
		scannedFiles: files.sort(),
	};
}

/** Render the `interface` body for one registry (empty stays `{}`). */
function renderRegistry(name: string, keys: string[]): string {
	if (keys.length === 0) return `\tinterface ${name} {}`;
	const members = keys.map((k) => `\t\t${JSON.stringify(k)}: string;`).join('\n');
	return `\tinterface ${name} {\n${members}\n\t}`;
}

/**
 * Render the `.d.ts` that augments the hosting value registries. Deterministic
 * (keys are sorted) so `--check` is stable and diffs stay minimal. Emits one
 * `declare module` block per specifier (the barrel and the `/secret` subpath by
 * default) — augmentation narrows only for the exact import specifier used.
 *
 * @param scan - Keys from {@link scanValueKeys}.
 * @param moduleSpecifiers - Modules to augment (default {@link DEFAULT_TYPEGEN_MODULES}).
 * @returns The file contents, tab-indented to match the repo style.
 */
export function renderHostingValuesDts(
	scan: Pick<ScanResult, 'secretKeys' | 'configKeys'>,
	moduleSpecifiers: string[] = DEFAULT_TYPEGEN_MODULES,
): string {
	const blocks = moduleSpecifiers
		.map(
			(spec) => `declare module ${JSON.stringify(spec)} {
${renderRegistry('HostingSecretRegistry', scan.secretKeys)}

${renderRegistry('HostingConfigRegistry', scan.configKeys)}
}`,
		)
		.join('\n\n');

	return `// AUTO-GENERATED by @aws-blocks/hosting typegen — DO NOT EDIT.
// Regenerate with \`npm run typegen\`. It narrows getSecret()/getConfig() to your
// declared secret()/config() keys. Deleting it is safe — the keys fall back to \`string\`.

export {};

${blocks}
`;
}

/** Result of {@link generateHostingValuesDts}. */
export interface TypegenResult extends ScanResult {
	/** Absolute path the augmentation was (or would be) written to. */
	readonly outFile: string;
	/** The rendered `.d.ts` contents. */
	readonly content: string;
	/**
	 * `true` when the on-disk file already matches {@link content}. Only meaningful
	 * after a call with `write: true` or `check: true`; otherwise reflects the
	 * pre-existing file (missing file → `false`).
	 */
	readonly upToDate: boolean;
}

/** Options for {@link generateHostingValuesDts}. */
export interface GenerateOptions extends TypegenOptions {
	/**
	 * Output path (relative to `cwd`, unless absolute).
	 * @default {@link DEFAULT_TYPEGEN_OUT}
	 */
	readonly out?: string;
	/**
	 * Write the file to disk. When `false`, the result is computed but nothing is
	 * written (used by `--check`).
	 * @default true
	 */
	readonly write?: boolean;
}

/**
 * Scan, render, and (by default) write the hosting-values `.d.ts`.
 *
 * @param options - See {@link GenerateOptions}.
 * @returns The scan result plus the rendered content, output path, and whether the
 *   on-disk file already matched (for `--check`).
 */
export async function generateHostingValuesDts(options: GenerateOptions = {}): Promise<TypegenResult> {
	const cwd = options.cwd ?? process.cwd();
	const outRel = options.out ?? DEFAULT_TYPEGEN_OUT;
	const outFile = isAbsolute(outRel) ? outRel : resolve(cwd, outRel);

	const scan = await scanValueKeys(options);
	const content = renderHostingValuesDts(scan, options.moduleSpecifiers);

	let existing: string | null = null;
	try {
		existing = await readFile(outFile, 'utf-8');
	} catch {
		existing = null;
	}
	const upToDate = existing === content;

	if (options.write !== false && !upToDate) {
		const { mkdir } = await import('node:fs/promises');
		const { dirname } = await import('node:path');
		await mkdir(dirname(outFile), { recursive: true });
		await writeFile(outFile, content, 'utf-8');
	}

	return { ...scan, outFile, content, upToDate };
}

/** Options for {@link runTypegenCli} beyond argv (injected for testing). */
export interface TypegenCliDeps {
	/** Where CLI messages go. Defaults to the real console. */
	readonly log?: (msg: string) => void;
	readonly error?: (msg: string) => void;
}

/**
 * CLI entry for `hosting-typegen`. Flags: `--check` (verify freshness, non-zero exit
 * if stale — for CI), `--out <path>`, `--include <glob>` (repeatable), `--module <spec>`,
 * `--cwd <dir>`.
 *
 * @returns The process exit code (0 = success / up-to-date; 1 = stale under `--check`).
 */
export async function runTypegenCli(argv: string[], deps: TypegenCliDeps = {}): Promise<number> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const err = deps.error ?? ((m: string) => console.error(m));

	let check = false;
	let out: string | undefined;
	let cwd: string | undefined;
	const include: string[] = [];
	const moduleSpecifiers: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--check') check = true;
		else if (a === '--out') out = argv[++i];
		else if (a === '--module') moduleSpecifiers.push(argv[++i]);
		else if (a === '--cwd') cwd = argv[++i];
		else if (a === '--include') include.push(argv[++i]);
		else if (a === '--help' || a === '-h') {
			log(
				'Usage: hosting-typegen [--check] [--out <path>] [--include <glob>]... [--module <spec>]... [--cwd <dir>]',
			);
			return 0;
		} else {
			err(`hosting-typegen: unknown argument ${JSON.stringify(a)}`);
			return 1;
		}
	}

	const result = await generateHostingValuesDts({
		cwd,
		out,
		moduleSpecifiers: moduleSpecifiers.length ? moduleSpecifiers : undefined,
		include: include.length ? include : undefined,
		write: !check,
	});

	const rel = (p: string) => relative(cwd ?? process.cwd(), p) || p;
	for (const site of result.dynamicCallSites) {
		err(
			`hosting-typegen: ${rel(site.file)}:${site.line} — ${site.fn}() called with a non-literal key; ` +
				'skipped (only string-literal keys can be made type-safe).',
		);
	}

	const summary = `${result.secretKeys.length} secret + ${result.configKeys.length} config key(s)`;

	if (check) {
		if (result.upToDate) {
			log(`hosting-typegen: ${rel(result.outFile)} is up to date (${summary}).`);
			return 0;
		}
		err(`hosting-typegen: ${rel(result.outFile)} is out of date. Run \`npm run typegen\` and commit the result.`);
		return 1;
	}

	log(`hosting-typegen: wrote ${rel(result.outFile)} (${summary}).`);
	return 0;
}
