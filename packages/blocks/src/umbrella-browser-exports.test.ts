// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

/**
 * Regression test: what `aws-cdk-blocks` exports under the `browser` condition.
 *
 * An app depends on `aws-cdk-blocks`, and the block READMEs match errors with
 * `isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)`, on the server and in
 * client code. A frontend compiles against the backend entry's types
 * (`index.d.ts`), but a bundler and `tsx -C browser` load `index.browser.js`, so
 * a name missing there type-checks and then fails to link at run time
 * (`does not provide an export named 'KVStoreErrors'`).
 *
 * The browser entry must export exactly the backend entry's client-safe values:
 *
 * - every `*Errors` constant, with the value of the `errors.js` of the package
 *   that defines it (the same object, not a copy), and every block's `*Errors`
 *   must be exported by the backend entry in the first place;
 * - every value of core's browser entry (`@aws-cdk-blocks/core/client`) that the
 *   backend entry exports;
 * - every value of a block's browser build that the backend entry exports and
 *   that is not a class (the classes there are server-side stubs).
 *
 * minus {@link NOT_IN_BROWSER}. It must export nothing else: a name the backend
 * entry lacks is a value the types never describe.
 *
 * Run: node --test dist/umbrella-browser-exports.test.js
 */

const blocksDir = join(fileURLToPath(import.meta.url), '..', '..');
const nodeModules = join(blocksDir, '..', '..', 'node_modules');

/**
 * Backend-entry values the browser entry leaves out on purpose, with the reason. An entry that no
 * longer matches (the name is gone, or it is no longer a candidate) fails the test, so the list cannot rot.
 */
const NOT_IN_BROWSER: Record<string, string> = {
	RawRouteErrors:
		"thrown while a RawRoute is registered on the server, so it never reaches a client; core's browser entry does not carry the route registry",
	sql: "bb-database's browser build defines it as a function that throws (a server-side stub)",
};

/**
 * The `@aws-cdk-blocks/*` dependencies of `aws-cdk-blocks` whose root has a `browser` build (core aside: its
 * browser entry is read as `@aws-cdk-blocks/core/client`), with the URL of their `dist/errors.js` if they have one.
 */
function browserPackages(): { name: string; errorsUrl: string | null }[] {
	const pkg: { dependencies?: Record<string, string> } = JSON.parse(
		readFileSync(join(blocksDir, 'package.json'), 'utf-8'),
	);
	return Object.keys(pkg.dependencies ?? {})
		.filter((name) => name.startsWith('@aws-cdk-blocks/') && name !== '@aws-cdk-blocks/core')
		.flatMap((name) => {
			const dir = realpathSync(join(nodeModules, name));
			const manifest: { exports?: { '.'?: unknown } } = JSON.parse(
				readFileSync(join(dir, 'package.json'), 'utf-8'),
			);
			const root = manifest.exports?.['.'];
			if (!(root && typeof root === 'object' && 'browser' in root)) return [];
			const errors = join(dir, 'dist', 'errors.js');
			return [{ name, errorsUrl: existsSync(errors) ? pathToFileURL(errors).href : null }];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

const packages = browserPackages();

/** Run `script` (an ES module body) in a fresh Node process, optionally under `condition`, and parse its JSON output. */
function run<T>(script: string, condition?: string): T {
	const flags = condition ? [`--conditions=${condition}`] : [];
	const out = execFileSync(process.execPath, [...flags, '--input-type=module', '-e', script], {
		cwd: blocksDir,
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return JSON.parse(out.trim().split('\n').pop() ?? 'null') as T;
}

interface EntryView {
	/** Named exports of `aws-cdk-blocks`. */
	names: string[];
	/** `*Errors` values of the entry. */
	errorValues: Record<string, unknown>;
}

interface BrowserView extends EntryView {
	/** Value exports of `@aws-cdk-blocks/core/client`, and which of them the browser entry re-exports as is. */
	client: { values: string[]; same: string[] };
	/** Per package: its browser build's non-class values, and which browser-entry names are that package's object. */
	builds: Record<string, { values: string[]; same: string[] }>;
	/** Per package: the `*Errors` exports of its `dist/errors.js`, and which the browser entry re-exports as is. */
	errorsFiles: Record<string, { names: string[]; same: string[] }>;
}

const entryScript = `
const umbrella = await import('aws-cdk-blocks');
const names = Object.keys(umbrella).filter((n) => n !== 'default').sort();
const errorValues = Object.fromEntries(names.filter((n) => n.endsWith('Errors')).map((n) => [n, umbrella[n]]));
`;

const browserScript = `${entryScript}
const isClass = (v) => typeof v === 'function' && /^class[\\s{]/.test(Function.prototype.toString.call(v));
const same = (m) => names.filter((n) => n in m && m[n] === umbrella[n]);
const client = await import('@aws-cdk-blocks/core/client');
const view = {
	names,
	errorValues,
	client: { values: Object.keys(client).filter((n) => n !== 'default'), same: same(client) },
	builds: {},
	errorsFiles: {},
};
for (const { name, errorsUrl } of ${JSON.stringify(packages)}) {
	const m = await import(name);
	view.builds[name] = {
		values: Object.keys(m).filter((n) => n !== 'default' && !isClass(m[n])),
		same: same(m),
	};
	if (!errorsUrl) continue;
	const e = await import(errorsUrl);
	view.errorsFiles[name] = { names: Object.keys(e).filter((n) => n.endsWith('Errors')), same: same(e) };
}
console.log(JSON.stringify(view));
`;

const defaultScript = `${entryScript}
console.log(JSON.stringify({ names, errorValues }));
`;

let browserView: BrowserView | undefined;
const browser = (): BrowserView => {
	browserView ??= run<BrowserView>(browserScript, 'browser');
	return browserView;
};
let defaultView: EntryView | undefined;
const backend = (): EntryView => {
	defaultView ??= run<EntryView>(defaultScript);
	return defaultView;
};

test('discovery sanity check', () => {
	assert.ok(packages.length >= 15, `Expected ≥15 packages with a browser build, found ${packages.length}`);
	for (const expected of ['@aws-cdk-blocks/bb-kv-store', '@aws-cdk-blocks/bb-database', '@aws-cdk-blocks/bb-auth']) {
		assert.ok(
			packages.some((p) => p.name === expected),
			`Expected to discover ${expected}`,
		);
	}
	assert.ok(
		packages.filter((p) => p.errorsUrl).length >= 14,
		'Expected ≥14 packages with a dist/errors.js (run npm run build first)',
	);
});

test('aws-cdk-blocks: browser entry exports every client-safe value of the backend entry, and nothing else', () => {
	const { names: backendNames } = backend();
	const view = browser();
	const exported = new Set(backendNames);
	const candidates = new Set<string>([
		...backendNames.filter((n) => n.endsWith('Errors')),
		...view.client.values.filter((n) => exported.has(n)),
		...Object.values(view.builds).flatMap((b) => b.values.filter((n) => exported.has(n))),
	]);
	const stale = Object.keys(NOT_IN_BROWSER).filter((n) => !candidates.has(n));
	assert.deepStrictEqual(stale, [], `NOT_IN_BROWSER lists names that are no longer candidates: ${stale.join(', ')}`);

	const expected = [...candidates].filter((n) => !(n in NOT_IN_BROWSER)).sort();
	const actual = new Set(view.names);
	const missing = expected.filter((n) => !actual.has(n));
	const extra = view.names.filter((n) => !expected.includes(n));
	const problems: string[] = [];
	if (missing.length > 0) {
		problems.push(
			`missing from the "browser" entry (exported by the backend entry, client-safe): ${missing.join(', ')}\n` +
				"    → re-export them in src/index.browser.ts from the package's root (its browser build), or add them to NOT_IN_BROWSER with the reason.",
		);
	}
	if (extra.length > 0) {
		problems.push(
			`only in the "browser" entry, or not client-safe: ${extra.join(', ')}\n` +
				'    → export them from the backend entry (src/index.ts) too, or stop exporting them here.',
		);
	}
	assert.deepStrictEqual(problems, [], `aws-cdk-blocks under --conditions=browser:\n  ${problems.join('\n  ')}`);
});

test('aws-cdk-blocks: browser entry re-exports each value from the package that defines it, as is', () => {
	const view = browser();
	const sources = [view.client.same, ...Object.values(view.builds).map((b) => b.same)];
	const orphans = view.names.filter((n) => !sources.some((same) => same.includes(n)));
	assert.deepStrictEqual(
		orphans,
		[],
		`these browser-entry values are not the object exported by core's browser entry or a block's browser build: ${orphans.join(', ')}`,
	);
});

for (const { name } of packages.filter((p) => p.errorsUrl)) {
	test(`aws-cdk-blocks: ${name} error constants are exported under browser, from its errors.js`, () => {
		const file = browser().errorsFiles[name];
		const { names: backendNames } = backend();
		const notOnRoot = file.names.filter((n) => !backendNames.includes(n));
		assert.deepStrictEqual(
			notOnRoot,
			[],
			`${name} defines ${notOnRoot.join(', ')} but aws-cdk-blocks does not export it: add it to src/index.ts, src/index.cdk.ts and src/index.browser.ts`,
		);
		const notSame = file.names.filter((n) => !file.same.includes(n));
		assert.deepStrictEqual(
			notSame,
			[],
			`aws-cdk-blocks under --conditions=browser does not export ${notSame.join(', ')} from ${name}'s errors.js`,
		);
	});
}

test('aws-cdk-blocks: error constants have the same values under browser as in the backend entry', () => {
	const { errorValues } = backend();
	const view = browser();
	const expected = Object.fromEntries(Object.entries(errorValues).filter(([n]) => !(n in NOT_IN_BROWSER)));
	assert.deepStrictEqual(view.errorValues, expected);
});

test('aws-cdk-blocks: isBlocksError matches a block error constant under browser', () => {
	const matched = run<boolean[]>(
		`
const { ApiError, DatabaseErrors, isBlocksError, KVStoreErrors } = await import('aws-cdk-blocks');
const conflict = new ApiError('conflict', 409, { name: KVStoreErrors.ConditionalCheckFailed });
const unique = new ApiError('taken', 409, { name: DatabaseErrors.UniqueConstraintViolation });
console.log(JSON.stringify([
	isBlocksError(conflict, KVStoreErrors.ConditionalCheckFailed),
	isBlocksError(unique, DatabaseErrors.UniqueConstraintViolation),
	isBlocksError(unique, KVStoreErrors.ConditionalCheckFailed),
]));
`,
		'browser',
	);
	assert.deepStrictEqual(matched, [true, true, false]);
});

// Node resolves `node:*` built-ins and server packages under --conditions=browser, so
// loading the entry in Node (above) does not prove a bundler can build it.
test('aws-cdk-blocks: browser entry bundles for the browser without server code', async () => {
	const result = await build({
		stdin: { contents: "export * from 'aws-cdk-blocks';", resolveDir: blocksDir },
		bundle: true,
		platform: 'browser',
		conditions: ['browser'],
		write: false,
		metafile: true,
		logLevel: 'silent',
	});
	const inputs = Object.keys(result.metafile.inputs);
	const serverOnly = inputs.filter(
		(input) =>
			input.includes('node_modules/@aws-sdk/') ||
			input.includes('node_modules/@smithy/') ||
			input.startsWith('node:') ||
			/\/dist\/(?:.*\/)?index\.(?:mock|aws|cdk)\.js$/.test(input),
	);
	assert.deepStrictEqual(serverOnly, [], 'aws-cdk-blocks "browser" entry bundles server-only modules');
	const nodeImports = Object.values(result.metafile.inputs).flatMap((i) =>
		i.imports.filter((imp) => imp.path.startsWith('node:')).map((imp) => imp.path),
	);
	assert.deepStrictEqual(nodeImports, [], 'aws-cdk-blocks "browser" entry imports Node.js built-ins');
});
