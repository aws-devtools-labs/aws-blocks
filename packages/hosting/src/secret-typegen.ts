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

import { existsSync, watch as fsWatch } from 'node:fs';
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
	/**
	 * Inferred value type per key for keys declared with a `{ schema }` — the schema's
	 * TypeScript output type, resolved via a `Program`/TypeChecker (e.g. `{ beta: boolean }`).
	 * Keys absent here have no schema and default to `string`. Keyed by kind.
	 */
	readonly valueTypes: { secret: Record<string, string>; config: Record<string, string> };
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
	/**
	 * Module specifiers a `secret()` / `config()` call may be imported *from* to be
	 * detected. Detection resolves each call's import binding against this list, so
	 * an alias is caught and a local/unrelated same-named function is ignored.
	 * @default {@link DEFAULT_MARKER_MODULES}
	 */
	readonly markerModules?: string[];
}

/** The function names we recognize as value declarations. */
const VALUE_FNS: Record<string, ValueKind> = { secret: 'secret', config: 'config' };

/**
 * Module specifiers a `secret()` / `config()` call may be imported *from* to count
 * as a real marker. Detection resolves the call's **import binding** against this
 * list — not the identifier text — so an aliased import (`secret as sec`) is caught,
 * a local `function secret()` or an unrelated `config()` (e.g. `dotenv`) is ignored,
 * and a namespace import (`import * as blocks … blocks.secret(…)`) works. This is a
 * distinct list from {@link DEFAULT_TYPEGEN_MODULES} (which is where the getters are
 * imported *to*, and what the generated `.d.ts` augments). It must include the paths
 * apps actually declare through — notably `@aws-blocks/blocks/cdk` and
 * `@aws-blocks/core/cdk`, which re-export the markers — or detection silently misses
 * the primary path.
 */
export const DEFAULT_MARKER_MODULES = [
	'@aws-blocks/hosting',
	'@aws-blocks/hosting/secret',
	'@aws-blocks/blocks/cdk',
	'@aws-blocks/blocks',
	'@aws-blocks/core/cdk',
	'@aws-blocks/core',
];

/** Per-file resolution of which local names bind to `secret`/`config` from an allowed module. */
interface MarkerBindings {
	/** Local name → kind, e.g. `sec` → `'secret'` for `import { secret as sec }`. */
	readonly named: Map<string, ValueKind>;
	/** Namespace-import locals from an allowed module, e.g. `blocks` for `import * as blocks`. */
	readonly namespaces: Set<string>;
}

/** Build the import-binding map for one source file, restricted to allowed marker modules. */
function buildMarkerBindings(
	ts: typeof import('typescript'),
	sourceFile: TS.SourceFile,
	allowed: Set<string>,
): MarkerBindings {
	const named = new Map<string, ValueKind>();
	const namespaces = new Set<string>();
	for (const stmt of sourceFile.statements) {
		if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
		if (!allowed.has(stmt.moduleSpecifier.text)) continue;
		const bindings = stmt.importClause?.namedBindings;
		if (!bindings) continue;
		if (ts.isNamespaceImport(bindings)) {
			namespaces.add(bindings.name.text);
		} else if (ts.isNamedImports(bindings)) {
			for (const el of bindings.elements) {
				const importedName = (el.propertyName ?? el.name).text; // real export name (handles `as`)
				const kind = VALUE_FNS[importedName];
				if (kind) named.set(el.name.text, kind);
			}
		}
	}
	return { named, namespaces };
}

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

/** Resolve a call's callee to a marker kind via its import binding (not its text). */
function makeKindOfCall(ts: typeof import('typescript'), bindings: MarkerBindings) {
	return (call: TS.CallExpression): ValueKind | undefined => {
		const callee = call.expression;
		if (ts.isIdentifier(callee)) return bindings.named.get(callee.text);
		// `import * as blocks` → `blocks.secret(…)`
		if (
			ts.isPropertyAccessExpression(callee) &&
			ts.isIdentifier(callee.expression) &&
			bindings.namespaces.has(callee.expression.text)
		) {
			return VALUE_FNS[callee.name.text];
		}
		return undefined;
	};
}

/** The `schema:` property value node in a `secret('K', { schema })` options object, if present. */
function schemaArgOf(ts: typeof import('typescript'), call: TS.CallExpression): TS.Expression | undefined {
	const opts = call.arguments[1];
	if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
	for (const prop of opts.properties) {
		if (ts.isPropertyAssignment(prop) && !ts.isComputedPropertyName(prop.name) && prop.name.getText() === 'schema') {
			return prop.initializer;
		}
	}
	return undefined;
}

/** Walk a source file collecting `secret('K')` / `config('K')` keys and non-literal call sites. */
function collectFromSourceFile(
	ts: typeof import('typescript'),
	sourceFile: TS.SourceFile,
	filePath: string,
	allowed: Set<string>,
	secretKeys: Set<string>,
	configKeys: Set<string>,
	schemaKeys: { secret: Set<string>; config: Set<string> },
	dynamicCallSites: DynamicCallSite[],
): void {
	const bindings = buildMarkerBindings(ts, sourceFile, allowed);
	// No marker is imported into this file → nothing here can be a marker call. Skip.
	if (bindings.named.size === 0 && bindings.namespaces.size === 0) return;
	const kindOfCall = makeKindOfCall(ts, bindings);

	const visit = (node: TS.Node): void => {
		if (ts.isCallExpression(node)) {
			const fn = kindOfCall(node);
			if (fn) {
				const arg = node.arguments[0];
				if (arg && ts.isStringLiteralLike(arg)) {
					(fn === 'secret' ? secretKeys : configKeys).add(arg.text);
					if (schemaArgOf(ts, node)) schemaKeys[fn].add(arg.text);
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

/** Infer the TypeScript output type of a Standard Schema expression via the checker. */
function inferSchemaOutput(
	ts: typeof import('typescript'),
	checker: import('typescript').TypeChecker,
	schemaExpr: TS.Expression,
): string | undefined {
	const at = schemaExpr;
	const prop = (t: import('typescript').Type, name: string): import('typescript').Type | undefined => {
		const sym = checker.getPropertyOfType(t, name);
		return sym ? checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(sym, at)) : undefined;
	};
	// StandardSchemaV1: value['~standard'].types.output
	const standard = prop(checker.getTypeAtLocation(schemaExpr), '~standard');
	const types = standard && prop(standard, 'types');
	const output = types && prop(types, 'output');
	if (!output) return undefined;
	const str = checker.typeToString(
		output,
		at,
		ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType | ts.TypeFormatFlags.InTypeAlias,
	);
	// A resolution that yields `any`/`unknown` is not useful — treat as unresolved.
	return str === 'any' || str === 'unknown' ? undefined : str;
}

/**
 * Resolve the inferred output type for every `{ schema }`-carrying marker call, using
 * a full TypeScript `Program` (needed to resolve the schema library's types). Only
 * built when at least one schema is present, so the common no-schema path stays fast.
 */
function resolveSchemaTypes(
	ts: typeof import('typescript'),
	cwd: string,
	files: string[],
	allowed: Set<string>,
): { secret: Record<string, string>; config: Record<string, string> } {
	const out = { secret: {} as Record<string, string>, config: {} as Record<string, string> };
	const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
	let options: import('typescript').CompilerOptions = { strict: true, skipLibCheck: true };
	if (configPath) {
		const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: () => {},
		} as import('typescript').ParseConfigFileHost);
		if (parsed) options = { ...parsed.options };
	}
	options.noEmit = true;
	options.skipLibCheck = true;
	const program = ts.createProgram(files, options);
	const checker = program.getTypeChecker();

	for (const file of files) {
		const sf = program.getSourceFile(file);
		if (!sf) continue;
		const bindings = buildMarkerBindings(ts, sf, allowed);
		if (bindings.named.size === 0 && bindings.namespaces.size === 0) continue;
		const kindOfCall = makeKindOfCall(ts, bindings);
		const visit = (node: TS.Node): void => {
			if (ts.isCallExpression(node)) {
				const fn = kindOfCall(node);
				const keyArg = node.arguments[0];
				if (fn && keyArg && ts.isStringLiteralLike(keyArg)) {
					const schemaExpr = schemaArgOf(ts, node);
					if (schemaExpr) {
						const inferred = inferSchemaOutput(ts, checker, schemaExpr);
						// Unresolved schema type → `unknown` (honest: value is JSON-parsed at runtime).
						out[fn][keyArg.text] = inferred ?? 'unknown';
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sf);
	}
	return out;
}

/**
 * Statically scan the app for `secret()` / `config()` string-literal keys.
 *
 * @param options - See {@link TypegenOptions}.
 * @returns The de-duplicated, sorted keys per kind, plus any non-literal call sites.
 * @internal
 */
export async function scanValueKeys(options: TypegenOptions = {}): Promise<ScanResult> {
	const cwd = options.cwd ?? process.cwd();
	const include = options.include ?? DEFAULT_TYPEGEN_INCLUDE;
	const allowed = new Set(options.markerModules ?? DEFAULT_MARKER_MODULES);

	const files = await fg(include, {
		cwd,
		absolute: true,
		ignore: ['**/node_modules/**', '**/dist/**', '**/.blocks/**', '**/*.d.ts'],
	});

	const ts = await loadTypeScript();
	const secretKeys = new Set<string>();
	const configKeys = new Set<string>();
	const schemaKeys = { secret: new Set<string>(), config: new Set<string>() };
	const dynamicCallSites: DynamicCallSite[] = [];

	for (const file of files) {
		const text = await readFile(file, 'utf-8');
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
		collectFromSourceFile(ts, sourceFile, file, allowed, secretKeys, configKeys, schemaKeys, dynamicCallSites);
	}

	// Only pay for a full Program (type resolution) when at least one schema exists.
	const valueTypes =
		schemaKeys.secret.size || schemaKeys.config.size
			? resolveSchemaTypes(ts, cwd, files, allowed)
			: { secret: {}, config: {} };

	return {
		secretKeys: [...secretKeys].sort(),
		configKeys: [...configKeys].sort(),
		valueTypes,
		dynamicCallSites,
		scannedFiles: files.sort(),
	};
}

/** Render the `interface` body for one registry (empty stays `{}`); schema'd keys get their inferred type. */
function renderRegistry(name: string, keys: string[], types: Record<string, string> = {}): string {
	if (keys.length === 0) return `\tinterface ${name} {}`;
	const members = keys.map((k) => `\t\t${JSON.stringify(k)}: ${types[k] ?? 'string'};`).join('\n');
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
 * @internal
 */
export function renderHostingValuesDts(
	scan: Pick<ScanResult, 'secretKeys' | 'configKeys'> & Partial<Pick<ScanResult, 'valueTypes'>>,
	moduleSpecifiers: string[] = DEFAULT_TYPEGEN_MODULES,
): string {
	const types = scan.valueTypes ?? { secret: {}, config: {} };
	const blocks = moduleSpecifiers
		.map(
			(spec) => `declare module ${JSON.stringify(spec)} {
${renderRegistry('HostingSecretRegistry', scan.secretKeys, types.secret)}

${renderRegistry('HostingConfigRegistry', scan.configKeys, types.config)}
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
 * @internal
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

/** The non-glob directory prefix of an include glob (`aws-blocks/**` → `aws-blocks`). */
function staticDirOf(glob: string): string {
	const dir: string[] = [];
	for (const seg of glob.split('/')) {
		if (/[*?{}[\]]/.test(seg)) break;
		dir.push(seg);
	}
	return dir.join('/') || '.';
}

/** Options for {@link watchHostingValues}. */
export interface WatchOptions extends GenerateOptions {
	/** Progress sink. Defaults to `console.log`. */
	readonly log?: (msg: string) => void;
	/** Error sink. Defaults to `console.error`. */
	readonly error?: (msg: string) => void;
	/** Debounce window (ms) before regenerating after a change. @default 150 */
	readonly debounceMs?: number;
	/** Poll interval (ms) used when recursive `fs.watch` is unavailable (Linux). @default 1000 */
	readonly pollMs?: number;
	/** Abort to tear down all watchers/timers (used by the CLI's Ctrl+C and by tests). */
	readonly signal?: AbortSignal;
	/**
	 * `unref()` the watchers/timers so they never keep the process alive on their own.
	 * Use when embedding in a longer-lived host (e.g. the Blocks dev server) so the
	 * watcher can't block the host's shutdown. Leave `false` for the standalone
	 * `--watch` CLI, whose only job is to stay alive and watch. @default false
	 */
	readonly unref?: boolean;
}

/**
 * Watch the scanned sources and regenerate the `.d.ts` whenever one changes — i.e.
 * on save. Runs an initial generation immediately, then uses recursive `fs.watch`
 * where supported (macOS/Windows) and falls back to polling (Linux). Regeneration
 * is debounced and only writes when the content actually changes (so it can never
 * self-trigger a loop).
 *
 * @param options - See {@link WatchOptions}.
 * @returns A `stop()` that tears down all watchers/timers.
 * @internal
 */
export async function watchHostingValues(options: WatchOptions = {}): Promise<() => void> {
	const log = options.log ?? ((m: string) => console.log(m));
	const err = options.error ?? ((m: string) => console.error(m));
	const cwd = options.cwd ?? process.cwd();
	const include = options.include ?? DEFAULT_TYPEGEN_INCLUDE;
	const rel = (p: string) => relative(cwd, p) || '.';

	const regenerate = async (): Promise<void> => {
		try {
			const r = await generateHostingValuesDts(options);
			if (!r.upToDate) {
				log(
					`hosting-typegen: regenerated ${rel(r.outFile)} (${r.secretKeys.length} secret + ${r.configKeys.length} config).`,
				);
			}
		} catch (e) {
			err(`hosting-typegen: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void regenerate(), options.debounceMs ?? 150);
	};

	await regenerate(); // initial

	const dirs = [...new Set(include.map((g) => resolve(cwd, staticDirOf(g))))].filter(existsSync);
	const cleanups: Array<() => void> = [];
	for (const dir of dirs) {
		try {
			const w = fsWatch(dir, { recursive: true }, schedule);
			if (options.unref) w.unref();
			cleanups.push(() => w.close());
		} catch {
			// Recursive watch unsupported here — poll instead.
			const id = setInterval(schedule, options.pollMs ?? 1000);
			if (options.unref) id.unref();
			cleanups.push(() => clearInterval(id));
		}
	}

	const stop = (): void => {
		if (timer) clearTimeout(timer);
		for (const c of cleanups) c();
	};
	options.signal?.addEventListener('abort', stop, { once: true });

	log(`hosting-typegen: watching ${dirs.map(rel).join(', ') || '(none)'} — regenerating on change. Ctrl+C to stop.`);
	return stop;
}

/** Options for {@link runTypegenCli} beyond argv (injected for testing). */
export interface TypegenCliDeps {
	/** Where CLI messages go. Defaults to the real console. */
	readonly log?: (msg: string) => void;
	readonly error?: (msg: string) => void;
	/** Abort to stop `--watch` (Ctrl+C wires this; tests use it to unblock). */
	readonly signal?: AbortSignal;
}

/**
 * CLI entry for `hosting-typegen`. Flags: `--check` (verify freshness, non-zero exit
 * if stale — for CI), `--out <path>`, `--include <glob>` (repeatable), `--module <spec>`,
 * `--cwd <dir>`.
 *
 * @returns The process exit code (0 = success / up-to-date; 1 = stale under `--check`).
 * @internal
 */
export async function runTypegenCli(argv: string[], deps: TypegenCliDeps = {}): Promise<number> {
	const log = deps.log ?? ((m: string) => console.log(m));
	const err = deps.error ?? ((m: string) => console.error(m));

	let check = false;
	let watch = false;
	let out: string | undefined;
	let cwd: string | undefined;
	const include: string[] = [];
	const moduleSpecifiers: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--check') check = true;
		else if (a === '--watch' || a === '-w') watch = true;
		else if (a === '--out') out = argv[++i];
		else if (a === '--module') moduleSpecifiers.push(argv[++i]);
		else if (a === '--cwd') cwd = argv[++i];
		else if (a === '--include') include.push(argv[++i]);
		else if (a === '--help' || a === '-h') {
			log(
				'Usage: hosting-typegen [--check | --watch] [--out <path>] [--include <glob>]... [--module <spec>]... [--cwd <dir>]',
			);
			return 0;
		} else {
			err(`hosting-typegen: unknown argument ${JSON.stringify(a)}`);
			return 1;
		}
	}

	if (check && watch) {
		err('hosting-typegen: --check and --watch are mutually exclusive.');
		return 1;
	}

	const genOptions = {
		cwd,
		out,
		moduleSpecifiers: moduleSpecifiers.length ? moduleSpecifiers : undefined,
		include: include.length ? include : undefined,
	};

	if (watch) {
		await watchHostingValues({ ...genOptions, log, error: err, signal: deps.signal });
		// Stay alive until aborted (Ctrl+C in the CLI; the injected signal in tests).
		return new Promise<number>((resolve) => {
			deps.signal?.addEventListener('abort', () => resolve(0), { once: true });
		});
	}

	const result = await generateHostingValuesDts({ ...genOptions, write: !check });

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
