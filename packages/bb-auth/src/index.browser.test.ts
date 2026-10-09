// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bundle hygiene for the browser-facing entries: `@aws-blocks/bb-auth` under
 * the `browser` condition and `@aws-blocks/bb-auth/ui`.
 *
 * - Walks the **built** import graph (`dist/*.js`, resolved the way a browser
 *   bundler resolves it: `browser` → `import` → `default`) and asserts it
 *   reaches no server code — not `./index.mock.js` (or the other server
 *   entries / the runtime stub), no Node built-in, no AWS SDK or CDK, and not
 *   core's server entry.
 * - Actually loads both entries in a fresh Node process under
 *   `--conditions=browser`, which fails on a missing named export the same
 *   way a browser bundle does (the removed `bb-auth-cognito` / `bb-auth-basic`
 *   browser entries failed exactly like that, on `ApiNamespace`).
 * - Checks the browser entry is a named-export superset of the default entry
 *   and that every runtime method throws a "server-side" error.
 * - Requirement R15: nothing in `bb-auth`'s source broadcasts auth changes
 *   itself; `submitAuthAction` in the shared UI is the only notifier.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as browser from './index.browser.js';

const distDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(distDir, '..');

// ── A minimal browser-bundler resolver over the built output ──────────────────

/** The conditions a browser bundler applies, in priority order. `types` is never a runtime target. */
const BROWSER_CONDITIONS = new Set(['browser', 'import', 'default']);

function pickTarget(target: unknown): string | null {
	if (typeof target === 'string') return target;
	if (Array.isArray(target)) {
		for (const t of target) {
			const picked = pickTarget(t);
			if (picked) return picked;
		}
		return null;
	}
	if (target && typeof target === 'object') {
		// Object key order is the condition priority, as in Node and bundlers.
		for (const [condition, value] of Object.entries(target)) {
			if (!BROWSER_CONDITIONS.has(condition)) continue;
			const picked = pickTarget(value);
			if (picked) return picked;
		}
	}
	return null;
}

/** Resolve a bare specifier (`@scope/pkg/sub`) from `fromFile` through node_modules + `exports`. */
function resolveBare(specifier: string, fromFile: string): string {
	const parts = specifier.split('/');
	const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
	const subpath = `.${specifier.slice(name.length)}`;
	let dir = dirname(fromFile);
	for (;;) {
		const pkgJson = join(dir, 'node_modules', name, 'package.json');
		if (existsSync(pkgJson)) {
			const pkgDir = realpathSync(dirname(pkgJson));
			const pkg = JSON.parse(readFileSync(pkgJson, 'utf-8')) as { exports?: unknown; main?: string };
			let target: string | null;
			if (pkg.exports !== undefined) {
				const exportsMap = pkg.exports as Record<string, unknown>;
				const isSubpathMap =
					typeof exportsMap === 'object' && Object.keys(exportsMap).some((k) => k.startsWith('.'));
				target = pickTarget(isSubpathMap ? exportsMap[subpath] : subpath === '.' ? exportsMap : undefined);
			} else {
				target = subpath === '.' ? (pkg.main ?? 'index.js') : subpath;
			}
			assert.ok(target, `${specifier} (from ${fromFile}) has no browser/import/default export`);
			return join(pkgDir, target);
		}
		const parent = dirname(dir);
		assert.notStrictEqual(parent, dir, `cannot resolve ${specifier} from ${fromFile}`);
		dir = parent;
	}
}

interface Graph {
	files: Set<string>;
	/** Every specifier seen, with the file that imported it. */
	edges: { from: string; specifier: string }[];
}

/** Walk the static runtime import graph from `entry` (type-only imports are already erased by tsc). */
function importGraph(entry: string): Graph {
	const graph: Graph = { files: new Set(), edges: [] };
	const queue = [realpathSync(entry)];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (graph.files.has(file)) continue;
		graph.files.add(file);
		// Static imports and re-exports only: what a bundler always includes. Guarded
		// dynamic imports (core's client reads `node:fs` only when running in Node,
		// behind `webpackIgnore`) are the importing package's own contract.
		const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, false);
		const specifiers = sf.statements.flatMap((st) =>
			(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
			st.moduleSpecifier &&
			ts.isStringLiteral(st.moduleSpecifier)
				? [st.moduleSpecifier.text]
				: [],
		);
		for (const specifier of specifiers) {
			graph.edges.push({ from: file, specifier });
			if (specifier.startsWith('node:') || isBuiltin(specifier)) continue; // asserted below
			const next = specifier.startsWith('.') ? resolve(dirname(file), specifier) : resolveBare(specifier, file);
			queue.push(realpathSync(next));
		}
	}
	return graph;
}

const SERVER_FILES = ['index.mock.js', 'index.aws.js', 'index.cdk.js', 'auth-base.js'].map((f) =>
	realpathSync(join(distDir, f)),
);
const FORBIDDEN_PACKAGES = /^(@aws-sdk\/|@smithy\/|aws-cdk-lib|constructs$|@aws-blocks\/core\/cdk)/;

function assertBrowserSafe(entry: string) {
	const graph = importGraph(entry);
	const nodeBuiltins = graph.edges.filter((e) => e.specifier.startsWith('node:') || isBuiltin(e.specifier));
	assert.deepStrictEqual(nodeBuiltins, [], 'no Node built-ins in the browser graph');
	const serverPackages = graph.edges.filter((e) => FORBIDDEN_PACKAGES.test(e.specifier));
	assert.deepStrictEqual(serverPackages, [], 'no AWS SDK / CDK in the browser graph');
	for (const server of SERVER_FILES) {
		assert.ok(!graph.files.has(server), `${entry} must not reach ${server}`);
	}
	// core's browser condition is `dist/client/index.js`; its server entry is `dist/index.js`.
	const coreClient = resolveBare('@aws-blocks/core', join(packageRoot, 'package.json'));
	const coreServer = realpathSync(join(dirname(coreClient), '..', 'index.js'));
	assert.ok(!graph.files.has(coreServer), "core's server entry is not in the browser graph");
	return graph;
}

/** Load `specifier` in a fresh Node process, optionally under `condition`; list its named exports. */
function loadExports(specifier: string, condition?: string): string[] {
	const script = `import(${JSON.stringify(specifier)}).then((m) => console.log(JSON.stringify(Object.keys(m))))`;
	const out = execFileSync(
		process.execPath,
		[...(condition ? ['--conditions', condition] : []), '--input-type=module', '-e', script],
		{ cwd: packageRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
	);
	return (JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[]).filter((n) => n !== 'default').sort();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auth browser entry', () => {
	test('the built import graph reaches no server code (not ./index.mock.js, no Node built-ins)', () => {
		const graph = assertBrowserSafe(join(distDir, 'index.browser.js'));
		// Sanity: the walker really followed the bare imports.
		assert.ok(
			[...graph.files].some((f) => f.includes(`${join('auth-common', 'dist', 'errors.js')}`)),
			'the graph reaches auth-common (the error constants)',
		);
		assert.ok(
			[...graph.files].some((f) => /core[\\/]dist[\\/]client[\\/]/.test(f)),
			'core resolves to its browser (client) entry',
		);
	});

	test('the ./ui entry is browser-safe too', () => {
		const graph = assertBrowserSafe(join(distDir, 'ui.js'));
		assert.ok(
			[...graph.files].some((f) => f.endsWith(join('auth-common', 'dist', 'ui.js'))),
			'the graph reaches the shared renderer',
		);
	});

	test('loads under --conditions=browser and is a named-export superset of the default entry', () => {
		const browserNames = loadExports('@aws-blocks/bb-auth', 'browser');
		const defaultNames = loadExports('@aws-blocks/bb-auth');
		const missing = defaultNames.filter((n) => !browserNames.includes(n));
		assert.deepStrictEqual(missing, [], 'every default-entry export exists in the browser entry');
		assert.ok(browserNames.includes('Auth') && browserNames.includes('AuthErrors'));
	});

	test('./ui loads under --conditions=browser', () => {
		const names = loadExports('@aws-blocks/bb-auth/ui', 'browser');
		for (const expected of ['Authenticator', 'submitAuthAction', 'subscribeAuthState', 'authOverrides']) {
			assert.ok(names.includes(expected), `./ui exports ${expected}`);
		}
	});

	test('every runtime method throws a server-side error naming the generated client', () => {
		const auth = new browser.Auth();
		const methods = Object.getOwnPropertyNames(browser.Auth.prototype).filter((m) => m !== 'constructor');
		assert.ok(methods.length >= 14, `stubs every runtime method (found ${methods.length})`);
		for (const method of methods) {
			// `admin` is a getter: reading it is the call.
			const getter = Object.getOwnPropertyDescriptor(browser.Auth.prototype, method)?.get;
			const fn = getter ?? (Reflect.get(auth, method) as () => never);
			assert.throws(
				() => fn.call(auth),
				(e: unknown) =>
					e instanceof Error &&
					/is server-side; call the generated client/.test(e.message) &&
					e.message.includes(method),
				method,
			);
		}
	});

	test('re-exports the error constants and keeps fromExisting pure', () => {
		assert.strictEqual(browser.AuthErrors.NotAuthenticated, 'NotAuthenticatedException');
		assert.strictEqual(typeof browser.isAuthError, 'function');
		assert.deepStrictEqual(browser.Auth.fromExisting('us-east-1_abc', 'client'), {
			__brand: 'ExternalUserPoolRef',
			userPoolId: 'us-east-1_abc',
			clientId: 'client',
		});
	});
});

describe('R15: no second auth bridge in bb-auth', () => {
	test('no bb-auth source calls broadcastAuthChange — submitAuthAction is the only notifier', () => {
		const srcDir = join(packageRoot, 'src');
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
					if (/\bbroadcastAuthChange\s*\(/.test(readFileSync(full, 'utf-8'))) offenders.push(full);
				}
			}
		};
		walk(srcDir);
		assert.deepStrictEqual(offenders, []);
	});
});
