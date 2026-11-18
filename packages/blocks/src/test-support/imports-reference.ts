// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates `IMPORTS.md`, the "what to import from where" reference: every
 * app-facing entry of `@aws-blocks/blocks`, where it runs, and each name it
 * exports (value or type-only), read from the built declaration files with the
 * TypeScript compiler. `imports-reference.test.ts` fails when the committed
 * file differs; `npm run update:imports` rewrites it.
 *
 * The names come from `dist/`, so this runs after `tsc` (the docs generator
 * runs as `prebuild`, before it). `IMPORTS.md` is therefore committed at the
 * package root, from where gen-block-docs.mjs copies it into `docs/`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** `packages/blocks`. */
export const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IMPORTS_MD = join(PACKAGE_DIR, 'IMPORTS.md');

/** Where each app-facing entry runs and what it is for. A new export-map entry must be added here or to {@link NOT_APP_FACING}. */
const APP_FACING: Record<string, { readonly runs: string; readonly purpose: string }> = {
	'.': {
		runs: 'Backend (`aws-blocks/`): local dev, Lambda, CDK synth.',
		purpose:
			'Every Building Block and the core backend API. It is the only entry with a `browser` condition: there (browser bundles, and the templates’ `npm run test:e2e`, which runs `tsx -C browser`) it resolves to an empty module, so no values, though `import type` still works. Under `--conditions=cdk` it resolves to the `/cdk` build.',
	},
	'./client': {
		runs: 'Browser, Node, and the `tsx -C browser` e2e tests.',
		purpose:
			'Core’s browser-safe values: errors and their matchers, and the API client runtime the generated `aws-blocks` client uses.',
	},
	'./ui': {
		runs: 'Browser (returns DOM nodes).',
		purpose: 'The auth UI components and the auth state store.',
	},
	'./theme': {
		runs: 'Browser.',
		purpose: 'The stylesheet the UI components use.',
	},
	'./server': {
		runs: 'Server-side rendering (Node).',
		purpose: 'Forwarding the browser’s cookies to API calls made during SSR.',
	},
	'./utils': {
		runs: 'Node tests and scripts, including the templates’ `tsx -C browser` e2e tests (no `browser` condition, so it resolves the same everywhere).',
		purpose: 'Test helpers: a cookie jar for `fetch`, per-user test clients, local auth codes, TOTP codes.',
	},
	'./cdk': {
		runs: 'CDK synth (`cdk-blocks deploy` / `sandbox`), in your app’s CDK entry file `aws-blocks/index.cdk.ts`.',
		purpose:
			'The synth-time build: what the generated `aws-blocks/index.cdk.ts` imports (`BlocksStack`, `BlocksPresets`, `Hosting`, `HostingPresets`), plus every block’s CDK construct.',
	},
	'./lambda-handler': {
		runs: 'The deployed Lambda.',
		purpose: '`createLambdaHandler`, which the generated `aws-blocks/index.handler.ts` imports.',
	},
	'./scripts': {
		runs: 'Node: the `cdk-blocks` CLI, and your CDK entry file.',
		purpose:
			'CLI plumbing (dev server, deploy, sandbox). The generated `aws-blocks/index.cdk.ts` imports `getStackName` from it, and the amplify template’s `aws-blocks/scripts/generate-client.ts` imports `generateClientCode`.',
	},
};

/** Export-map entries an app does not import from. */
const NOT_APP_FACING: Record<string, string> = {
	'./vendorize': 'the `cdk-blocks vendorize` implementation',
	'./docs/*': 'these docs',
};

interface EntryNames {
	readonly values: string[];
	readonly types: string[];
	/** Classes declared in the entry file itself, not re-exported: the stubs a block's browser build defines. */
	readonly stubs: string[];
}

/** Whether `symbol` (an export) reaches its declaration through a type-only re-export or import anywhere on the way. */
function isTypeOnlyExport(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
	let current = symbol;
	for (let hops = 0; current.flags & ts.SymbolFlags.Alias && hops < 50; hops++) {
		for (const decl of current.declarations ?? []) {
			if (ts.isExportSpecifier(decl) && (decl.isTypeOnly || decl.parent.parent.isTypeOnly)) return true;
			if (ts.isImportSpecifier(decl) && (decl.isTypeOnly || decl.parent.parent.isTypeOnly)) return true;
			if (ts.isImportClause(decl) && decl.isTypeOnly) return true;
		}
		current = checker.getImmediateAliasedSymbol(current) ?? current;
		if (current === symbol) break;
	}
	return !(current.flags & ts.SymbolFlags.Value);
}

/** The names each entry exports, from the built declaration files, resolved with `conditions` (e.g. `['browser']`). */
function readEntries(specifiers: readonly string[], conditions: string[] = []): Map<string, EntryNames> {
	const base = join(PACKAGE_DIR, 'dist', '.imports-reference-scratch');
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, 'run-'));
	try {
		const file = join(dir, 'probe.ts');
		writeFileSync(file, `${specifiers.map((s, i) => `import * as e${i} from '${s}';`).join('\n')}\nexport {};\n`);
		const program = ts.createProgram([file], {
			noEmit: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			customConditions: conditions,
			types: ['node'],
			skipLibCheck: true,
		});
		const checker = program.getTypeChecker();
		const sf = program.getSourceFile(file);
		if (!sf) throw new Error('probe file missing');
		const result = new Map<string, EntryNames>();
		const byName = (a: string, b: string) => a.localeCompare(b, 'en');
		sf.statements.filter(ts.isImportDeclaration).forEach((decl, i) => {
			const spec = specifiers[i];
			const moduleSymbol = checker.getSymbolAtLocation(decl.moduleSpecifier);
			if (spec === undefined || !moduleSymbol) throw new Error(`cannot resolve ${spec}; run npm run build first`);
			const values: string[] = [];
			const types: string[] = [];
			const stubs: string[] = [];
			for (const s of checker.getExportsOfModule(moduleSymbol)) {
				(isTypeOnlyExport(checker, s) ? types : values).push(s.name);
				if (!(s.flags & ts.SymbolFlags.Alias) && s.flags & ts.SymbolFlags.Class) stubs.push(s.name);
			}
			result.set(spec, { values: values.sort(byName), types: types.sort(byName), stubs });
		});
		return result;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const specifierOf = (key: string) => `@aws-blocks/blocks${key.slice(1)}`;

/** The content `IMPORTS.md` must have for the current build. */
export function renderImportsReference(): string {
	const pkg: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
	if (!(pkg && typeof pkg === 'object' && 'exports' in pkg && pkg.exports && typeof pkg.exports === 'object')) {
		throw new Error('packages/blocks/package.json has no exports map');
	}
	const dependencies =
		'dependencies' in pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
	// The packages whose root entry has a browser build of its own (a `browser` export condition).
	const blockPackages = Object.keys(dependencies).filter((name) => {
		if (!name.startsWith('@aws-blocks/')) return false;
		const manifest: unknown = JSON.parse(
			readFileSync(join(PACKAGE_DIR, '..', '..', 'node_modules', name, 'package.json'), 'utf8'),
		);
		if (!(manifest && typeof manifest === 'object' && 'exports' in manifest)) return false;
		const { exports } = manifest;
		const root = exports && typeof exports === 'object' && '.' in exports ? exports['.'] : undefined;
		return !!root && typeof root === 'object' && 'browser' in root;
	});
	const keys = Object.keys(pkg.exports);
	const unknown = keys.filter((k) => !(k in APP_FACING) && !(k in NOT_APP_FACING));
	if (unknown.length > 0) {
		throw new Error(
			`describe the new export-map entries ${unknown.join(', ')} in APP_FACING or NOT_APP_FACING (src/test-support/imports-reference.ts)`,
		);
	}
	const appKeys = Object.keys(APP_FACING).filter((k) => keys.includes(k));
	const names = readEntries(appKeys.map(specifierOf));
	const get = (key: string): EntryNames => names.get(specifierOf(key)) ?? { values: [], types: [], stubs: [] };
	const browserBuilds = readEntries(blockPackages, ['browser']);

	const out: string[] = [
		'# What to import from where',
		'',
		'<!-- Generated from the built packages by `npm run update:imports`; do not edit. -->',
		'',
		'Every app-facing entry of `@aws-blocks/blocks`, where it runs, and every name it exports. A **value** can be imported normally; a **type** only with `import type` (or `import { type … }`).',
		'',
		"The rule that matters most: **code that runs under the `browser` condition imports no values from the root `@aws-blocks/blocks`**. That covers browser bundles and the templates' e2e tests (`npm run test:e2e` runs `tsx -C browser`). The root is the backend entry and the only one with a `browser` condition, under which it resolves to an empty module; every subpath resolves to the same file everywhere. Such code imports from `/client`, `/ui` and `/theme`, the e2e tests also from `/utils`, and a block's error constants come from that block's own package (`KVStoreErrors` from `@aws-blocks/bb-kv-store`; see [Root values in browser code](#root-values-in-browser-code)). The typed client of your own API is `import { api } from 'aws-blocks'` (your backend module), not an `@aws-blocks/blocks` entry.",
		'',
		'| Entry | Runs in | For |',
		'|---|---|---|',
		...appKeys.map((k) => {
			const info = APP_FACING[k];
			return `| \`${specifierOf(k)}\` | ${info?.runs ?? ''} | ${info?.purpose ?? ''} |`;
		}),
		'',
		'## Root values in browser code',
		'',
		"Code run under the `browser` condition can’t import values from the root. These root values have a browser export: in a browser-safe entry of `@aws-blocks/blocks`, or in the browser build of the package that defines them, which carries its error constants and pure helpers (the Building Block classes there are stubs, so they are not listed). Those packages are dependencies of `@aws-blocks/blocks`; to import one directly, add it to your app’s `dependencies`. An error can also be matched by its name string, with nothing extra installed: `isBlocksError(e, 'ConditionalCheckFailedException')` from `@aws-blocks/blocks/client`.",
		'',
		'| Name | In browser code, import from |',
		'|---|---|',
	];
	const rootValues = get('.').values;
	const browserEntries = ['./client', './ui', './theme'].filter((k) => appKeys.includes(k));
	const moved = rootValues.flatMap((name) => {
		const umbrella = browserEntries.filter((k) => get(k).values.includes(name)).map(specifierOf);
		const own = blockPackages.filter((p) => {
			const build = browserBuilds.get(p);
			return build?.values.includes(name) && !build.stubs.includes(name);
		});
		const where = umbrella.length ? umbrella : own;
		return where.length ? [`| \`${name}\` | ${where.map((w) => `\`${w}\``).join(', ')} |`] : [];
	});
	out.push(...(moved.length ? moved : ['| — | — |']), '');
	out.push(
		'The other root values (the Building Block classes, CDK and server helpers) have no browser export; browser code uses `import type` for their types.',
		'',
	);

	for (const k of appKeys) {
		const entry = get(k);
		out.push(`## \`${specifierOf(k)}\``, '', `${APP_FACING[k]?.runs ?? ''}`, '');
		for (const [label, names] of [
			['Values', entry.values],
			['Types', entry.types],
		] as const) {
			const shown = names.length ? names.map((n) => `\`${n}\``).join(', ') : '—';
			out.push(`**${label} (${names.length}):** ${shown}`, '');
		}
	}

	out.push('## Not for app code', '', '| Entry | What it is |', '|---|---|');
	for (const k of keys.filter((key) => key in NOT_APP_FACING)) {
		out.push(`| \`${specifierOf(k)}\` | ${NOT_APP_FACING[k]} |`);
	}
	out.push('');
	return out.join('\n');
}
