// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Regression test: conditional export entries must not drop named exports.
 *
 * A normal backend type-check uses the default "types" entry, so it does not
 * verify the other implementations. This test loads entry points under each
 * condition and compares their named exports to catch drift.
 *
 * Every BB is checked under both "aws-runtime" (the Lambda bundle) and "cdk"
 * (`cdk synth` loads the backend module under it, so a missing export crashes
 * synth at import time).
 *
 * The public methods of every exported BB class are compared too, read from each
 * entry's `.d.ts`. Instance and static methods are checked separately — under
 * "cdk" a runtime-only method must exist as a `synthGuard` stub, and calling it
 * must actually throw the `synthGuard` error.
 *
 * This checks exported names, method presence and the cdk guards, not signature
 * compatibility. CDK stubs intentionally have different signatures.
 *
 * BB packages are discovered automatically — any package under packages/ whose
 * exports["."] has an "aws-runtime" condition is treated as a Building Block.
 *
 * Run: node --test dist/conditional-exports.test.js
 */
// ── Discovery ───────────────────────────────────────────────────────────────

const packagesDir = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages');

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
const bbPackages = buildingBlocks.filter((pkg) => pkg.exports['aws-runtime']);
const serverConditions: ServerCondition[] = ['aws-runtime', 'cdk'];

// ── Helpers ─────────────────────────────────────────────────────────────────

const exportCache = new Map<string, Set<string>>();

/** Load `pkg` under `condition` (once per pair) and return its named exports. */
const getExports = (pkg: string, condition?: string): ReadonlySet<string> => {
	const key = `${pkg}|${condition ?? 'default'}`;
	let names = exportCache.get(key);
	if (!names) {
		const flags = condition ? [`--conditions=${condition}`] : [];
		const script = `import(${JSON.stringify(pkg)}).then(m => console.log(JSON.stringify(Object.keys(m))))`;
		const out = execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script], {
			encoding: 'utf-8',
		});
		const parsedNames: string[] = JSON.parse(out.trim());
		names = new Set(parsedNames);
		exportCache.set(key, names);
	}
	return names;
};

const assertSuperset = (pkg: string, condition: string) => {
	const defaultNames = getExports(pkg);
	const conditionNames = getExports(pkg, condition);
	const missing = [...defaultNames].filter((name) => name !== 'default' && !conditionNames.has(name));

	assert.deepStrictEqual(
		missing,
		[],
		`${pkg} "${condition}" entry is missing exports:\n  ${missing.join(', ')}\n\n` +
			`Add these to the ${condition} entry file.`,
	);
};

// ── Umbrella package ────────────────────────────────────────────────────────

test('umbrella: cdk exports match default', () => {
	assertSuperset('@aws-blocks/blocks', 'cdk');
});

// ── BB packages: server entries (auto-discovered) ───────────────────────────

test('discovery sanity check', () => {
	const names = bbPackages.map((pkg) => pkg.name);
	assert.ok(names.length >= 8, `Expected ≥8 BB packages, found ${names.length}: ${names.join(', ')}`);
	for (const expected of ['@aws-blocks/bb-kv-store', '@aws-blocks/bb-distributed-table', '@aws-blocks/bb-data']) {
		assert.ok(names.includes(expected), `Expected to discover ${expected}`);
	}
});

// `cdk synth` loads the whole backend module under --conditions=cdk, so an export
// the default entry has but the cdk entry lacks crashes synth at import time.
for (const { name } of bbPackages) {
	for (const condition of serverConditions) {
		test(`${name}: ${condition} exports match default`, () => {
			assertSuperset(name, condition);
		});
	}
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
	'AuthCognito.prototype.createApi',
	'AuthOIDC.prototype.createApi',
	// Pure: derived from `callbackPath`.
	'AuthOIDC.prototype.signInRoutePath',
	// Synth-time config: sets an environment variable on the Lambda function.
	'LambdaCompute.prototype.setEnv',
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
