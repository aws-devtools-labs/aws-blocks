// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

/**
 * Regression test: conditional export entries must expose the same named exports.
 *
 * TypeScript cannot type-check custom conditions like "cdk" or "aws-runtime" —
 * it always resolves the "types" key, which for every Building Block points at the
 * mock (default) entry. This test actually loads each entry point under each
 * condition and compares its runtime named exports to the default entry's, in BOTH
 * directions:
 *
 *   - missing (in default, absent under the condition): the app module imports a
 *     name the types promise, and the ESM link step fails under that condition —
 *     `cdk synth`, the Lambda cold start, or the browser bundle breaks.
 *   - extra (absent from default, present under the condition): an export the types
 *     never describe and local dev never exercises — drift between layers.
 *
 * The contract (AGENTS.md: "every named export in `index.mock.ts` exists in
 * cdk/aws/browser") is encoded per condition in {@link BB_POLICY}; the umbrella
 * package has its own, documented policy in {@link UMBRELLA_POLICY}. Every known
 * deviation lives in ONE place, {@link KNOWN_GAPS}, so later work can shrink it — and
 * an entry that no longer matches reality fails the test, so the list cannot rot.
 *
 * The public methods of every exported BB class are compared too, read from each
 * entry's `.d.ts`. Instance and static methods are checked separately — under
 * "cdk" a runtime-only method must exist as a `synthGuard` stub, and calling it
 * must actually throw the `synthGuard` error. That checks method presence and the
 * cdk guards, not signature compatibility: CDK stubs intentionally have different
 * signatures.
 *
 * Packages are discovered automatically: every `packages/bb-*` package with a
 * conditional `exports["."]` map, plus {@link EXTRA_PACKAGES}. All three conditions
 * are checked for each, declared or not — an undeclared condition falls back to
 * `default`, but that file's own imports still resolve under the condition, so the
 * package must still load and expose the same names.
 *
 * Run: node --test dist/conditional-exports.test.js
 */

// ── Contract ────────────────────────────────────────────────────────────────

const CONDITIONS = ['aws-runtime', 'cdk', 'browser'] as const;
type Condition = (typeof CONDITIONS)[number];

/**
 * - `equal`: condition names === default names (missing and extra both fail).
 * - `superset`: condition names ⊇ default names (only missing fails; extras are intended).
 * - `skip`: the condition entry is a different surface by design; not compared.
 */
type Policy = 'equal' | 'superset' | 'skip';

/**
 * Building Blocks (and {@link EXTRA_PACKAGES}): every condition must match `default` exactly.
 *
 * - `aws-runtime` and `cdk`: the same app module (`aws-blocks/index.ts`) is evaluated under
 *   default (local dev), `cdk` (synth) and `aws-runtime` (Lambda), so a missing name crashes
 *   that stage at import, and an extra name is untyped (types resolve to the mock) and
 *   untested locally.
 * - `browser`: the browser stub keeps every name importable — class stubs whose methods are
 *   server-side, plus the error constants a frontend matches with `isBlocksError`. Browser-only
 *   client helpers belong on a subpath (e.g. `./client`) with their own types, not on the root,
 *   where the `types` key cannot describe them.
 */
const BB_POLICY: Record<Condition, Policy> = { 'aws-runtime': 'equal', cdk: 'equal', browser: 'equal' };

/**
 * `@aws-blocks/blocks`:
 * - `aws-runtime`: no dedicated entry — falls back to default, but each re-exported BB then
 *   resolves to its aws entry, so the names must still match.
 * - `cdk`: intentionally a superset — it re-exports `@aws-blocks/core/cdk` (BlocksStack,
 *   BlocksBackend, registerConfig, synthGuard, …) on top of the BB surface.
 * - `browser`: intentionally `export {}` — browser code imports `@aws-blocks/blocks/client`.
 */
const UMBRELLA_POLICY: Record<Condition, Policy> = { 'aws-runtime': 'equal', cdk: 'superset', browser: 'skip' };

/** Non-`bb-*` packages that ship runtime code consumed by BBs under every condition. */
const EXTRA_PACKAGES = ['auth-common'] as const;

type KnownGap =
	| {
			pkg: string;
			condition: Condition;
			kind: 'missing' | 'extra';
			/** Exact names; every one must still be a gap or the entry is stale. */
			symbols: readonly string[];
			reason: string;
	  }
	| {
			pkg: string;
			condition: Condition;
			/** The entry fails to load at all under the condition. */
			kind: 'unloadable';
			reason: string;
	  };

/**
 * The single allowlist of known parity gaps. Shrink it; never grow it without a reason.
 * A stale entry (the gap is gone, or the package no longer exists) fails the test.
 */
const KNOWN_GAPS: readonly KnownGap[] = [
	// ── Real gaps whose fix is not a trivially-safe re-export. ──
	{
		pkg: '@aws-blocks/bb-data',
		condition: 'browser',
		kind: 'missing',
		symbols: ['PgClientEngine', 'RLSEnabledDatabase', 'createKyselyAdapter', 'sql'],
		reason:
			"Server-only: re-exporting would pull `pg` and '@aws-blocks/data-common' (node:fs migrations, " +
			'PGlite) into browser bundles. Needs purpose-built browser stubs (`sql` is a tagged template ' +
			'with helper properties) — follow-up, not a re-export.',
	},
	{
		pkg: '@aws-blocks/bb-distributed-data',
		condition: 'browser',
		kind: 'missing',
		symbols: ['createKyselyAdapter', 'sql'],
		reason:
			"Server-only: re-exporting would pull '@aws-blocks/data-common' (node:fs migrations, PGlite) " +
			'into browser bundles. Needs purpose-built browser stubs — follow-up, not a re-export.',
	},
];

// ── Discovery ───────────────────────────────────────────────────────────────

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');
const blocksDir = join(packagesDir, 'blocks');

function discoverPackages(): string[] {
	const extra = new Set<string>(EXTRA_PACKAGES);
	const dirs = readdirSync(packagesDir, { withFileTypes: true }).filter(
		(d) => d.isDirectory() && (d.name.startsWith('bb-') || extra.has(d.name)),
	);
	const result: string[] = [];
	for (const dir of dirs) {
		let pkg: { name?: string; exports?: Record<string, unknown> };
		try {
			pkg = JSON.parse(readFileSync(join(packagesDir, dir.name, 'package.json'), 'utf-8'));
		} catch {
			continue;
		}
		const root = pkg.exports?.['.'];
		if (pkg.name && root !== null && typeof root === 'object') result.push(pkg.name);
	}
	return result.sort();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type LoadResult = { ok: true; names: Set<string> } | { ok: false; error: string };

const cache = new Map<string, LoadResult>();

/** Load `pkg` in a fresh Node process under `condition` (or none) and list its named exports. */
function loadExports(pkg: string, condition: Condition | null): LoadResult {
	const key = `${pkg}|${condition ?? 'default'}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const flags = condition ? ['--conditions', condition] : [];
	const script = `import('${pkg}').then(m => console.log(JSON.stringify(Object.keys(m))))`;
	let result: LoadResult;
	try {
		const out = execFileSync('node', [...flags, '--input-type=module', '-e', script], {
			cwd: blocksDir,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const names = new Set(JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[]);
		names.delete('default');
		result = { ok: true, names };
	} catch (e) {
		const stderr = String((e as { stderr?: unknown }).stderr ?? e);
		const line = stderr.split('\n').find((l) => /Error/.test(l)) ?? stderr.trim().split('\n')[0];
		result = { ok: false, error: line ?? 'unknown error' };
	}
	cache.set(key, result);
	return result;
}

/** Compare `pkg` under `condition` against its default entry, honoring `policy` and KNOWN_GAPS. */
function assertParity(pkg: string, condition: Condition, policy: Policy) {
	const known = KNOWN_GAPS.filter((g) => g.pkg === pkg && g.condition === condition);
	const knownUnloadable = known.some((g) => g.kind === 'unloadable');
	const allowed = (kind: 'missing' | 'extra') => new Set(known.flatMap((g) => (g.kind === kind ? g.symbols : [])));

	const base = loadExports(pkg, null);
	if (!base.ok) assert.fail(`${pkg} default entry failed to load: ${base.error}`);

	const cond = loadExports(pkg, condition);
	if (!cond.ok) {
		assert.ok(
			knownUnloadable,
			`${pkg} fails to load under --conditions=${condition}:\n  ${cond.error}\n\n` +
				'Fix the entry file, or add a KNOWN_GAPS entry with the reason.',
		);
		return;
	}
	assert.ok(
		!knownUnloadable,
		`${pkg} now loads under --conditions=${condition} — remove its 'unloadable' KNOWN_GAPS entry.`,
	);

	const missing = [...base.names].filter((n) => !cond.names.has(n));
	const extra = policy === 'equal' ? [...cond.names].filter((n) => !base.names.has(n)) : [];
	const allowedMissing = allowed('missing');
	const allowedExtra = allowed('extra');
	const problems: string[] = [];

	const newMissing = missing.filter((n) => !allowedMissing.has(n)).sort();
	if (newMissing.length > 0) {
		problems.push(
			`missing from the "${condition}" entry (exported by default): ${newMissing.join(', ')}\n` +
				`    → add them to the ${condition} entry file (a re-export, or a synthGuard/browser stub).`,
		);
	}
	const newExtra = extra.filter((n) => !allowedExtra.has(n)).sort();
	if (newExtra.length > 0) {
		problems.push(
			`only in the "${condition}" entry (not exported by default): ${newExtra.join(', ')}\n` +
				'    → export them from the default (mock) entry too, or stop exporting them here.',
		);
	}
	const stale = [
		...[...allowedMissing].filter((n) => !missing.includes(n)),
		...[...allowedExtra].filter((n) => !extra.includes(n)),
	];
	if (stale.length > 0) {
		problems.push(
			`KNOWN_GAPS lists gaps that no longer exist: ${stale.join(', ')}\n    → remove them from KNOWN_GAPS.`,
		);
	}

	assert.deepStrictEqual(problems, [], `${pkg} under --conditions=${condition}:\n  ${problems.join('\n  ')}`);
}

// ── Discovery sanity ────────────────────────────────────────────────────────

const packages = discoverPackages();

test('discovery sanity check', () => {
	assert.ok(packages.length >= 8, `Expected ≥8 BB packages, found ${packages.length}: ${packages.join(', ')}`);
	for (const expected of [
		'@aws-blocks/bb-kv-store',
		'@aws-blocks/bb-distributed-table',
		'@aws-blocks/bb-data',
		'@aws-blocks/auth-common',
	]) {
		assert.ok(packages.includes(expected), `Expected to discover ${expected}`);
	}
});

test('KNOWN_GAPS only names checked packages', () => {
	const checked = new Set([...packages, '@aws-blocks/blocks']);
	const stale = [...new Set(KNOWN_GAPS.map((g) => g.pkg))].filter((p) => !checked.has(p));
	assert.deepStrictEqual(stale, [], `KNOWN_GAPS names packages that are no longer checked: ${stale.join(', ')}`);
});

// ── Umbrella package ────────────────────────────────────────────────────────

for (const condition of CONDITIONS) {
	const policy = UMBRELLA_POLICY[condition];
	if (policy === 'skip') {
		test(`@aws-blocks/blocks: ${condition} exports`, {
			skip: 'intentionally a different surface (see UMBRELLA_POLICY)',
		});
		continue;
	}
	test(`@aws-blocks/blocks: ${condition} exports ${policy} default`, () => {
		assertParity('@aws-blocks/blocks', condition, policy);
	});
}

// ── BB packages (auto-discovered) ───────────────────────────────────────────

for (const pkg of packages) {
	for (const condition of CONDITIONS) {
		test(`${pkg}: ${condition} exports ${BB_POLICY[condition]} default`, () => {
			assertParity(pkg, condition, BB_POLICY[condition]);
		});
	}
}

// ── Class methods and cdk guards ────────────────────────────────────────────
// The checks above compare export *names*. A class can exist in every entry yet
// lose methods, so the following compare each class's public methods per server
// condition, and call every cdk runtime stub to make sure it throws `synthGuard`.

type ServerCondition = 'aws-runtime' | 'cdk';
type ExportTarget = string | { types?: string; default?: string };
type PackageEntry = {
	name: string;
	dir: string;
	exports: Partial<Record<ServerCondition | 'browser' | 'types' | 'default', ExportTarget>>;
};

function readPackage(dir: string): PackageEntry {
	const pkg: { name: string; exports: { '.': PackageEntry['exports'] } } = JSON.parse(
		readFileSync(join(dir, 'package.json'), 'utf-8'),
	);
	return { name: pkg.name, dir, exports: pkg.exports['.'] };
}

// Read each manifest once. A malformed manifest should fail discovery, not
// silently remove a Building Block from the regression checks.
const buildingBlocks = readdirSync(packagesDir, { withFileTypes: true })
	.filter((dir) => dir.isDirectory() && dir.name.startsWith('bb-'))
	.map((dir) => readPackage(join(packagesDir, dir.name)))
	.sort((a, b) => a.name.localeCompare(b.name));
// Every bb-* package (browser error-constant checks), and the ones with a server
// entry (export, method and guard checks).
const bbPackages = buildingBlocks.filter((pkg) => pkg.exports['aws-runtime']);
const serverConditions: ServerCondition[] = ['aws-runtime', 'cdk'];

test('bb-* discovery floor', () => {
	// The browser checks below cover every bb-* package, so a floor keeps the set
	// from shrinking quietly (e.g. if a directory is renamed out of the bb- prefix).
	assert.ok(buildingBlocks.length >= 21, `Expected ≥21 bb-* packages, found ${buildingBlocks.length}`);
});

// ── BB packages: browser (auto-discovered) ──────────────────────────────────
// Frontend code imports a BB package directly only for its error constants, to
// match errors with `isBlocksError(e, FileBucketErrors.FileNotFound)`. Only the
// error name crosses the RPC wire, so the browser entry must export every
// `*Errors` constant the default entry has, with the same values: a frontend
// typechecks against the default entry's `.d.ts`, so a missing key is `undefined`
// at runtime and the match silently fails. Re-export them from `errors.js` rather
// than copying literals. The rest of a BB is server-side, so other exports are
// not compared.
//
// A BB with error constants but no "browser" condition fails too: a frontend
// import would resolve the server entry. Packages without an aws-runtime entry
// are included.

/** Load `pkg` under `condition` and return its `*Errors` constants with their values. */
const getErrorConstants = (pkg: string, condition?: string): Record<string, unknown> => {
	const flags = condition ? [`--conditions=${condition}`] : [];
	const script = `import(${JSON.stringify(pkg)}).then(m => console.log(JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k.endsWith('Errors'))))))`;
	const out = execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script], {
		encoding: 'utf-8',
	});
	return JSON.parse(out.trim());
};

for (const { name, exports: entry } of buildingBlocks) {
	test(`${name}: browser entry exports the same error constants`, () => {
		const expected = getErrorConstants(name);
		if (!entry.browser) {
			assert.deepStrictEqual(
				Object.keys(expected),
				[],
				`${name} exports error constants but has no "browser" condition, so a frontend import ` +
					'resolves the server entry. Add a browser entry that re-exports them from `errors.js`.',
			);
			return;
		}
		assert.deepStrictEqual(
			getErrorConstants(name, 'browser'),
			expected,
			`${name} "browser" entry error constants differ from the default entry. ` +
				'Re-export them from `errors.js` in the browser entry file instead of copying them.',
		);
	});

	// Node resolves `node:*` built-ins and server packages under --conditions=browser,
	// so loading the entry in Node (above) does not prove a bundler can build it.
	test(`${name}: browser entry bundles for the browser`, { skip: !entry.browser }, async () => {
		const result = await build({
			stdin: { contents: `export * from ${JSON.stringify(name)};`, resolveDir: packagesDir },
			bundle: true,
			platform: 'browser',
			conditions: ['browser'],
			write: false,
			metafile: true,
			logLevel: 'silent',
		});
		const serverOnly = Object.keys(result.metafile.inputs).filter((input) => input.includes('node_modules/@aws-sdk/'));
		assert.deepStrictEqual(serverOnly, [], `${name} "browser" entry bundles server-only modules`);
	});
}

// ── BB packages: class methods (auto-discovered) ────────────────────────────
// A class can exist in every entry yet lose methods: under cdk it is a different
// class (the construct), so every runtime-only method needs a `synthGuard` stub
// there. Without one, calling it during synth fails with `x is not a function`
// instead of an actionable message, and a static that must work at synth (e.g. a
// `fromExisting()` used in a constructor call) is simply missing.
//
// Methods are read from each entry's `.d.ts` with the TypeScript compiler, not
// from the loaded module: TypeScript `private` is erased at runtime, so only the
// declarations can tell public methods from internal helpers. Skipped: private,
// protected, `@internal` and `_`-prefixed methods, and properties/accessors (an
// accessor such as `AuthCognito.admin` is tested in its own package instead).

/** `.d.ts` for an exports-map target: its explicit `types`, else the sibling of the `.js`. */
const declarationFile = (pkgDir: string, target: ExportTarget | undefined): string | undefined => {
	if (!target) return undefined;
	if (typeof target === 'string') return join(pkgDir, target.replace(/\.js$/, '.d.ts'));
	const file = target.types ?? target.default;
	assert.ok(file, `${pkgDir} has an export target without "types" or "default"`);
	return join(pkgDir, file.replace(/\.js$/, '.d.ts'));
};

/** The `.d.ts` of a package's default, aws-runtime and cdk entries. */
const declarationEntry = ({ name, dir, exports: entry }: PackageEntry) => {
	return {
		name,
		dir,
		files: {
			default: declarationFile(dir, entry.types),
			'aws-runtime': declarationFile(dir, entry['aws-runtime']),
			cdk: declarationFile(dir, entry.cdk),
		} satisfies Record<string, string | undefined>,
	};
};

const bbEntries = bbPackages.map(declarationEntry);
// The umbrella re-exports core (`Scope`, `RawRoute`, `ApiNamespace`, ...) from a
// different module per condition, so its classes get the same method-parity check.
// Not the guard check below: core's cdk classes are constructs, not `synthGuard` stubs.
const umbrellaEntry = declarationEntry(readPackage(join(packagesDir, 'blocks')));

let program: ts.Program | undefined;

/** One program over every BB entry and the umbrella, built on first use. */
const getProgram = () =>
	(program ??= ts.createProgram(
		[...bbEntries, umbrellaEntry].flatMap((e) =>
			Object.values(e.files).filter((f): f is string => f !== undefined),
		),
		{
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			skipLibCheck: true,
			noEmit: true,
		},
	));

const isPublicMethod = (member: ts.Symbol) =>
	(member.flags & ts.SymbolFlags.Method) !== 0 &&
	!member.name.startsWith('_') &&
	(member.declarations ?? []).every(
		(d) =>
			!(ts.getCombinedModifierFlags(d) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) &&
			!ts.getJSDocTags(d).some((t) => t.tagName.text === 'internal'),
	);

/** Every export of the declaration file `file`, types included. */
const declaredExports = (file: string): ts.Symbol[] => {
	const checker = getProgram().getTypeChecker();
	const source = getProgram().getSourceFile(file);
	assert.ok(source, `Declaration file not found: ${file} — run \`npm run build\` first.`);
	const moduleSymbol = checker.getSymbolAtLocation(source);
	assert.ok(moduleSymbol, `${file} is not a module`);
	return checker.getExportsOfModule(moduleSymbol);
};

/** Every class `file` exports, keyed by export name, with aliases (re-exports) resolved. */
const declaredClasses = (file: string): Map<string, ts.Symbol> => {
	const checker = getProgram().getTypeChecker();
	const result = new Map<string, ts.Symbol>();
	for (const exported of declaredExports(file)) {
		const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
		if (symbol.flags & ts.SymbolFlags.Class) result.set(exported.name, symbol);
	}
	return result;
};

/** Public instance and static methods (inherited included) of every class `file` exports. */
const classMethods = (file: string): Set<string> => {
	const checker = getProgram().getTypeChecker();
	const result = new Set<string>();

	const addMethods = (prefix: string, type: ts.Type) => {
		for (const member of checker.getPropertiesOfType(type)) {
			if (isPublicMethod(member)) result.add(`${prefix}.${member.name}`);
		}
	};

	for (const [name, symbol] of declaredClasses(file)) {
		addMethods(`${name}.prototype`, checker.getDeclaredTypeOfSymbol(symbol));
		addMethods(name, checker.getTypeOfSymbol(symbol));
	}
	return result;
};

for (const { name, files } of [...bbEntries, umbrellaEntry]) {
	for (const condition of serverConditions) {
		test(`${name}: ${condition} class methods match default`, { skip: !files[condition] }, () => {
			assert.ok(files.default, `${name} has no "types" entry`);
			const expected = classMethods(files.default);
			const conditionFile = files[condition];
			assert.ok(conditionFile, `${name} has no "${condition}" entry`);
			const actual = classMethods(conditionFile);
			const missing = [...expected].filter((method) => !actual.has(method));

			assert.deepStrictEqual(
				missing,
				[],
				`${name} "${condition}" entry is missing class methods:\n  ${missing.join(', ')}\n\n` +
					`Add them to the ${condition} entry's class.` +
					(condition === 'cdk'
						? ' Use `synthGuard` for runtime-only methods; synth-time helpers need real implementations.'
						: ''),
			);
		});
	}
}

// ── BB packages: cdk guards throw (auto-discovered) ─────────────────────────
// Presence is not enough: a stub that throws the wrong message, or returns without
// throwing, still passes the parity test above. Under cdk, calling a runtime-only
// instance method must throw `synthGuard`'s error. Skipped:
// - statics: they are synth-time helpers (`fromExisting()`, `fromKmsKey()`, ...);
// - classes the cdk entry re-exports unchanged from the runtime (e.g. bb-data's
//   `PgClientEngine`): same declaration as the default entry, so not a construct;
// - methods the construct inherits from outside its package (core's `Scope`);
// - SYNTH_SAFE_METHODS below.

/** Instance methods that must work during synth, so the cdk class implements them for real. */
const SYNTH_SAFE_METHODS = new Set([
	// Synth-time wiring: `createApi()` builds the RPC namespace the backend module exports.
	'Auth.prototype.createApi',
	// Synth-time config: sets an environment variable on the Lambda function.
	'LambdaCompute.prototype.setEnv',
	// Synth-time config: adds an env var to the Fargate container definition.
	'ContainerCompute.prototype.setEnv',
	// Resolves the backing compute at synth (an AsyncJob/CronJob calls it in its
	// CDK constructor to wire against the real backing) — the ComputeProvider
	// contract, not a runtime-only method.
	'Compute.prototype.resolve',
	// Top-level logging also runs under `cdk synth`; it writes the same lines as at runtime.
	'Logger.prototype.debug',
	'Logger.prototype.info',
	'Logger.prototype.warn',
	'Logger.prototype.error',
	'Logger.prototype.child',
]);

/** Instance methods of the cdk entry's constructs that must throw `synthGuard`'s error. */
const guardedMethods = ({ dir, files }: (typeof bbEntries)[number]): string[] => {
	assert.ok(files.default && files.cdk);
	const checker = getProgram().getTypeChecker();
	const sourceOf = (symbol: ts.Symbol | undefined) => symbol?.declarations?.[0]?.getSourceFile().fileName;
	const defaultClasses = declaredClasses(files.default);
	const cdkClasses = declaredClasses(files.cdk);
	/** Whether the cdk class declares `method` in this package (not inherited from core). */
	const ownMethod = (cdkClass: ts.Symbol, method: string) => {
		const member = checker.getPropertyOfType(checker.getDeclaredTypeOfSymbol(cdkClass), method);
		return sourceOf(member)?.startsWith(dir) ?? false;
	};
	return [...classMethods(files.default)].filter((method) => {
		const [className, kind, methodName] = method.split('.');
		const cdkClass = cdkClasses.get(className);
		return (
			kind === 'prototype' &&
			!SYNTH_SAFE_METHODS.has(method) &&
			cdkClass !== undefined &&
			sourceOf(defaultClasses.get(className)) !== sourceOf(cdkClass) &&
			ownMethod(cdkClass, methodName)
		);
	});
};

/**
 * Load `pkg` under cdk and call each `Class.prototype.method` on a bare instance
 * (no stack needed: the guards never touch `this`). Returns each call's error
 * message, or a marker when it did not throw.
 */
const callUnderCdk = (pkg: string, methods: string[]): Record<string, string> => {
	const script = `
const mod = await import(${JSON.stringify(pkg)});
const out = {};
for (const key of ${JSON.stringify(methods)}) {
	const [className, , method] = key.split('.');
	const Class = mod[className];
	try {
		const result = Class.prototype[method].call(Object.create(Class.prototype));
		if (result && typeof result.then === 'function') result.then(() => {}, () => {});
		out[key] = '<returned without throwing>';
	} catch (e) {
		out[key] = String(e instanceof Error ? e.message : e);
	}
}
process.stdout.write('\\n' + JSON.stringify(out) + '\\n', () => process.exit(0));
`;
	const out = execFileSync(process.execPath, ['--conditions=cdk', '--input-type=module', '-e', script], {
		encoding: 'utf-8',
	});
	// The last line is the result; anything a module logged on import comes before it.
	return JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
};

for (const entry of bbEntries) {
	const { name, files } = entry;
	test(`${name}: cdk runtime methods throw the synthGuard error`, { skip: !files.cdk }, () => {
		const methods = guardedMethods(entry);
		const results = callUnderCdk(name, methods);
		const wrong = methods
			.map((method) => {
				const [className, , methodName] = method.split('.');
				const expected = `${className}.${methodName}() cannot be called during CDK synth.`;
				return results[method]?.startsWith(expected) ? undefined : `${method}: ${results[method]}`;
			})
			.filter((line): line is string => line !== undefined);

		assert.deepStrictEqual(
			wrong,
			[],
			`${name} "cdk" entry has runtime methods that do not throw the synthGuard error:\n  ${wrong.join('\n  ')}\n\n` +
				"Stub them with `synthGuard('<Class>', '<method>')`. If a method must work at synth, " +
				'implement it for real and add it to SYNTH_SAFE_METHODS.',
		);
	});
}

// ── Type exports (auto-discovered) ──────────────────────────────────────────
// Type-only exports are erased at runtime, so the export checks above cannot see
// them. A type the default entry exports but a server entry lacks breaks any
// backend that imports it once it is type-checked under that condition.
// Compares every declared name, types included.

for (const { name, files } of [umbrellaEntry, ...bbEntries]) {
	for (const condition of serverConditions) {
		test(`${name}: ${condition} type exports match default`, { skip: !files[condition] }, () => {
			assert.ok(files.default, `${name} has no "types" entry`);
			const conditionFile = files[condition];
			assert.ok(conditionFile, `${name} has no "${condition}" entry`);
			const actual = new Set(declaredExports(conditionFile).map((s) => s.name));
			const missing = declaredExports(files.default)
				.map((s) => s.name)
				.filter((n) => n !== 'default' && !actual.has(n));

			assert.deepStrictEqual(
				missing,
				[],
				`${name} "${condition}" entry is missing exports:\n  ${missing.join(', ')}\n\n` +
					`Re-export them from the ${condition} entry file: \`export type\` for types, a plain \`export\` for values.`,
			);
		});
	}
}
