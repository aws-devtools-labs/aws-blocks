// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NativeCatalogError, type NativeDeclarationInput, type NativePackageRegistration } from './native-catalogs.js';
import { readNativeDeclarations } from './read-native-declarations.js';

const roots: string[] = [];

after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeApp(): string {
	const root = join(tmpdir(), `blocks-native-decl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, 'aws-blocks'), { recursive: true });
	roots.push(root);
	return root;
}

function installPackage(dir: string, name: string, manifest: Record<string, unknown>): string {
	const packageDir = join(dir, 'node_modules', ...name.split('/'));
	mkdirSync(packageDir, { recursive: true });
	const manifestPath = join(packageDir, 'package.json');
	writeFileSync(manifestPath, JSON.stringify({ name, version: '1.0.0', ...manifest }));
	return manifestPath;
}

function installRawManifest(dir: string, name: string, contents: string): string {
	const packageDir = join(dir, 'node_modules', ...name.split('/'));
	mkdirSync(packageDir, { recursive: true });
	const manifestPath = join(packageDir, 'package.json');
	writeFileSync(manifestPath, contents);
	return manifestPath;
}

const PACKAGES = [
	{
		identity: 'example-iot-native',
		platforms: { dart: { package: { name: 'example_iot_native', library: 'example_iot_native.dart' } } },
	},
];

const BINDINGS = [
	{
		id: 'example-device-link',
		kind: 'transferable',
		tag: 'example-iot/device-link',
		package: 'example-iot-native',
		export: 'deviceLink',
		abi: 'blocks-transferable-v1',
		genericArity: 0,
	},
];

function native(declarations: unknown): Record<string, unknown> {
	return { 'aws-blocks': { native: declarations } };
}

function foundationOf(root: string): string {
	return join(root, 'aws-blocks', 'index.ts');
}

/**
 * The walk climbs to the filesystem root, so a package installed above `tmpdir()`
 * contributes to every fixture. Snapshotting it once is what makes an exact-array
 * assertion a statement about the fixture rather than about the host.
 */
const ambient = new Set<string>();

/**
 * Warnings the fixture itself produced. A package installed above `tmpdir()` can warn too,
 * and that warning names a path outside the fixture, so it is not the fixture's to assert on.
 */
function fixtureWarnings(warnings: readonly string[], root: string): string[] {
	return warnings.filter((warning) => warning.includes(root));
}

/** Every specifier the fixtures install, so a name collision with `ambient` is caught here. */
const FIXTURE_SPECIFIERS = [
	'.cache',
	'@aws-blocks/blocks',
	'@example/alpha',
	'@example/bb-iot',
	'@example/broken',
	'@example/carrier',
	'@example/cwd-block',
	'@example/escaped',
	'@example/nested-block',
	'@example/odd',
	'@example/root-block',
	'@example/target-block',
	'@example/unrelated',
	'@example/zulu',
	'bb-iot-alias',
	'iot-block',
	'leftpad',
	'mike',
	'not-a-dir',
	'unrelated-corrupt',
];

before(() => {
	for (const source of readNativeDeclarations(foundationOf(makeApp()))) ambient.add(source.sourcePackage);
	const collisions = FIXTURE_SPECIFIERS.filter((name) => ambient.has(name));
	assert.deepStrictEqual(
		collisions,
		[],
		'a package installed above tmpdir() shares a fixture name, so subtracting it would hide the fixture',
	);
});

function sourcesFrom(foundationPath: string): NativeDeclarationInput[] {
	return readNativeDeclarations(foundationPath).filter((s) => !ambient.has(s.sourcePackage));
}

function namesFrom(foundationPath: string): string[] {
	return sourcesFrom(foundationPath)
		.map((s) => s.sourcePackage)
		.sort();
}

describe('readNativeDeclarations', () => {
	it('reads packages and bindings from a block package.json', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES, bindings: BINDINGS }));

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), [
			{ sourcePackage: '@example/bb-iot', packages: PACKAGES, bindings: BINDINGS },
		]);
	});

	it('reads an unscoped block package', () => {
		const root = makeApp();
		installPackage(root, 'iot-block', native({ bindings: BINDINGS }));

		assert.deepStrictEqual(namesFrom(foundationOf(root)), ['iot-block']);
	});

	it('keeps a declaration that carries only packages', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));

		const sources = sourcesFrom(foundationOf(root));

		assert.strictEqual(sources.length, 1);
		assert.deepStrictEqual(sources[0].packages, PACKAGES);
		assert.strictEqual(sources[0].bindings, undefined);
	});

	it('reads every installed block, not just the first', () => {
		const root = makeApp();
		installPackage(root, '@example/zulu', native({ bindings: BINDINGS }));
		installPackage(root, '@example/alpha', native({ packages: PACKAGES }));
		installPackage(root, 'mike', native({ packages: PACKAGES }));

		assert.deepStrictEqual(namesFrom(foundationOf(root)), ['@example/alpha', '@example/zulu', 'mike']);
	});

	it('skips a package with no aws-blocks namespace', () => {
		const root = makeApp();
		installPackage(root, '@example/unrelated', { main: 'index.js' });

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('skips a package whose aws-blocks namespace has no native key', () => {
		const root = makeApp();
		installPackage(root, '@aws-blocks/blocks', {
			'aws-blocks': { vendorize: { '@aws-blocks/bb-realtime': ['Realtime'] } },
		});

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('skips a package whose aws-blocks namespace is null', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', { 'aws-blocks': null });

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('skips a package whose native object declares neither packages nor bindings', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({}));

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('skips a package.json that parses to null', () => {
		const root = makeApp();
		installRawManifest(root, '@example/odd', 'null');

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('finds a block at the project root when the foundation workspace has its own node_modules', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		installPackage(join(root, 'aws-blocks'), 'leftpad', { main: 'index.js' });

		assert.deepStrictEqual(namesFrom(foundationOf(root)), ['@example/bb-iot']);
	});

	it('reads declaring blocks from every node_modules level', () => {
		const root = makeApp();
		installPackage(root, '@example/root-block', native({ packages: PACKAGES }));
		installPackage(join(root, 'aws-blocks'), '@example/nested-block', native({ bindings: BINDINGS }));

		assert.deepStrictEqual(namesFrom(foundationOf(root)), ['@example/nested-block', '@example/root-block']);
	});

	it('resolves a relative foundation path instead of returning nothing', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const cwd = process.cwd();
		// The block is one level above the cwd, which a bare relative walk never reaches.
		process.chdir(join(root, 'aws-blocks'));
		try {
			const sources = sourcesFrom('index.ts');
			assert.strictEqual(sources.length, 1);
		} finally {
			process.chdir(cwd);
		}
	});

	it('accepts a manifest carrying a byte-order mark, as npm does', () => {
		const root = makeApp();
		installRawManifest(
			root,
			'@example/bb-iot',
			`\uFEFF${JSON.stringify({ name: '@example/bb-iot', ...native({ packages: PACKAGES }) })}`,
		);

		const sources = sourcesFrom(foundationOf(root));

		assert.strictEqual(sources.length, 1);
	});

	it('skips an unreadable node_modules directory instead of failing generation', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const locked = join(root, 'aws-blocks', 'node_modules');
		mkdirSync(locked, { recursive: true });
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

		try {
			chmodSync(locked, 0o000);
			const sources = sourcesFrom(foundationOf(root));

			assert.deepStrictEqual(
				sources.map((s) => s.sourcePackage),
				['@example/bb-iot'],
				'a readable level still contributes',
			);
			assert.ok(
				warnings.some((w) => w.includes('node_modules') && w.includes('EACCES')),
				`the skip must be warned, got ${JSON.stringify(warnings)}`,
			);
		} finally {
			console.warn = realWarn;
			chmodSync(locked, 0o755);
		}
	});

	it('warns about nothing when every level reads cleanly', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

		try {
			sourcesFrom(foundationOf(root));
		} finally {
			console.warn = realWarn;
		}

		assert.deepStrictEqual(fixtureWarnings(warnings, root), [], 'an absent level is not a failure to report');
	});

	it('skips a node_modules entry that is a file, not a directory', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		writeFileSync(join(root, 'node_modules', 'not-a-dir'), 'this is a file');
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

		try {
			const sources = sourcesFrom(foundationOf(root));

			assert.deepStrictEqual(
				sources.map((s) => s.sourcePackage),
				['@example/bb-iot'],
			);
			assert.deepStrictEqual(fixtureWarnings(warnings, root), [], 'ENOTDIR is absence, not a failure');
		} finally {
			console.warn = realWarn;
		}
	});

	it('does not read a block nested inside another package, which no import can reach', () => {
		const root = makeApp();
		const nested = join(root, 'node_modules', '@example', 'carrier');
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@example/carrier' }));
		installPackage(nested, '@example/bb-iot', native({ packages: PACKAGES }));

		assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
	});

	it('reads a block installed under an npm alias, naming it by its specifier', () => {
		const root = makeApp();
		const dir = join(root, 'node_modules', 'bb-iot-alias');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: '@example/bb-iot', ...native({ packages: PACKAGES }) }),
		);

		const sources = sourcesFrom(foundationOf(root));

		assert.strictEqual(sources.length, 1);
		assert.strictEqual(sources[0].sourcePackage, 'bb-iot-alias');
	});

	it('lets a nearest copy that is not an object shadow a declaring copy behind it', () => {
		const root = makeApp();
		installRawManifest(join(root, 'aws-blocks'), '@example/bb-iot', '[]');
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));

		const sources = sourcesFrom(foundationOf(root));

		assert.deepStrictEqual(sources, [], 'the copy Node resolves declares nothing, so nothing is declared');
	});

	it('resolves a package installed at two levels to its nearest copy', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		installPackage(
			join(root, 'aws-blocks'),
			'@example/bb-iot',
			native({
				packages: [
					{
						identity: 'example-iot-native',
						platforms: { dart: { package: { name: 'nearer', library: 'nearer.dart' } } },
					},
				],
			}),
		);

		const sources = sourcesFrom(foundationOf(root));

		assert.strictEqual(sources.length, 1);
		const packages = sources[0].packages as NativePackageRegistration[];
		assert.deepStrictEqual(packages[0].platforms.dart?.package.name, 'nearer');
	});

	it('reaches a hoisted package from a deeply nested foundation', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const nested = join(root, 'packages', 'app', 'aws-blocks');
		mkdirSync(nested, { recursive: true });

		assert.deepStrictEqual(namesFrom(join(nested, 'index.ts')), ['@example/bb-iot']);
	});

	it('resolves from the foundation path, not the process working directory', () => {
		const elsewhere = makeApp();
		installPackage(elsewhere, '@example/cwd-block', native({ packages: PACKAGES }));
		const target = makeApp();
		installPackage(target, '@example/target-block', native({ packages: PACKAGES }));

		const previousCwd = process.cwd();
		process.chdir(elsewhere);
		try {
			assert.deepStrictEqual(namesFrom(foundationOf(target)), ['@example/target-block']);
		} finally {
			process.chdir(previousCwd);
		}
	});

	it('returns nothing when no node_modules exists above the foundation', () => {
		const root = join(tmpdir(), `blocks-native-decl-bare-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		roots.push(root);

		assert.deepStrictEqual(sourcesFrom(join(root, 'index.ts')), []);
	});

	it('ignores a dot-directory inside a scope, as it does at the top level', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const hidden = join(root, 'node_modules', '@example', '.hidden');
		mkdirSync(hidden, { recursive: true });
		writeFileSync(join(hidden, 'package.json'), JSON.stringify(native({ bindings: BINDINGS })));

		assert.deepStrictEqual(
			sourcesFrom(foundationOf(root)).map((s) => s.sourcePackage),
			['@example/bb-iot'],
		);
	});

	it('ignores dot-directories inside node_modules', () => {
		const root = makeApp();
		installPackage(root, '.cache', native({ packages: PACKAGES }));
		installPackage(root, '@example/bb-iot', native({ bindings: BINDINGS }));

		assert.deepStrictEqual(namesFrom(foundationOf(root)), ['@example/bb-iot']);
	});

	it('reports a native key that is not an object', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native('transferable'));

		assert.throws(
			() => readNativeDeclarations(foundationOf(root)),
			(err: unknown) => {
				assert.ok(err instanceof NativeCatalogError);
				assert.strictEqual(err.errors.length, 1);
				assert.strictEqual(err.errors[0].path, 'aws-blocks.native');
				assert.match(err.errors[0].message, /declared by @example\/bb-iot/);
				return true;
			},
		);
	});

	it('reports a native key that is an array', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native([{ packages: PACKAGES }]));

		assert.throws(() => readNativeDeclarations(foundationOf(root)), NativeCatalogError);
	});

	it('reports an unrecognised field under native', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packagez: PACKAGES }));

		assert.throws(
			() => readNativeDeclarations(foundationOf(root)),
			(err: unknown) => {
				assert.ok(err instanceof NativeCatalogError);
				assert.strictEqual(err.errors[0].path, 'aws-blocks.native.packagez');
				assert.match(err.errors[0].message, /Unexpected field "packagez"/);
				assert.match(err.errors[0].message, /declared by @example\/bb-iot/);
				return true;
			},
		);
	});

	it('passes a non-array packages value through for the validator to report', () => {
		for (const value of [5, 'abc', null, { id: 'x' }]) {
			const root = makeApp();
			installPackage(root, '@example/bb-iot', native({ packages: value }));

			const sources = sourcesFrom(foundationOf(root));

			assert.strictEqual(sources.length, 1, JSON.stringify(value));
			assert.deepStrictEqual(sources[0].packages, value, JSON.stringify(value));
		}
	});

	it('warns and skips an installed manifest that cannot be read', () => {
		const root = makeApp();
		const manifestPath = installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

		try {
			chmodSync(manifestPath, 0o000);
			assert.deepStrictEqual(sourcesFrom(foundationOf(root)), []);
			assert.deepStrictEqual(fixtureWarnings(warnings, root), [
				`⚠️  Native declarations skipped in ${manifestPath}: EACCES`,
			]);
		} finally {
			console.warn = realWarn;
			chmodSync(manifestPath, 0o644);
		}
	});

	it('reports an installed manifest that is not valid JSON but names the key', () => {
		const root = makeApp();
		installRawManifest(root, '@example/broken', '{ "name": "@example/broken", "aws-blocks": { "native": ');

		assert.throws(
			() => readNativeDeclarations(foundationOf(root)),
			(err: unknown) => {
				assert.ok(err instanceof NativeCatalogError);
				assert.match(
					err.errors[0].message,
					/Cannot parse .*package\.json as JSON \(declared by @example\/broken\)/,
				);
				return true;
			},
		);
	});

	it('skips an unparseable manifest that cannot carry the key, keeping other declarations', () => {
		const root = makeApp();
		installPackage(root, '@example/bb-iot', native({ packages: PACKAGES }));
		installRawManifest(root, 'unrelated-corrupt', '{ "name": "unrelated-corrupt", ');
		const warnings: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));

		try {
			const sources = sourcesFrom(foundationOf(root));

			assert.deepStrictEqual(
				sources.map((s) => s.sourcePackage),
				['@example/bb-iot'],
				'one corrupt dependency must not drop a declaring block',
			);
			assert.ok(
				warnings.some((w) => w.includes('unrelated-corrupt') && w.includes('not valid JSON')),
				`the skip must be warned, got ${JSON.stringify(warnings)}`,
			);
		} finally {
			console.warn = realWarn;
		}
	});

	it('reports an unparseable manifest that names the key through a unicode escape', () => {
		const root = makeApp();
		installRawManifest(root, '@example/escaped', '{ "name": "@example/escaped", "aws\\u002Dblocks": { "native": ');

		assert.throws(
			() => readNativeDeclarations(foundationOf(root)),
			(err: unknown) => {
				assert.ok(err instanceof NativeCatalogError);
				assert.match(err.errors[0].message, /Cannot parse .*package\.json as JSON/);
				return true;
			},
		);
	});

	it('reports every malformed declaration, not just the first', () => {
		const root = makeApp();
		installPackage(root, '@example/alpha', native({ packagez: PACKAGES }));
		installPackage(root, '@example/zulu', native({ bindingz: BINDINGS }));

		assert.throws(
			() => readNativeDeclarations(foundationOf(root)),
			(err: unknown) => {
				assert.ok(err instanceof NativeCatalogError);
				assert.strictEqual(err.errors.length, 2);
				return true;
			},
		);
	});
});

/**
 * The walk stops on `dirname(dir) === dir`. CI only ever runs it on POSIX — the
 * Windows lane runs templates-e2e.mjs, which never invokes `blocks-generate-spec`
 * — so the Windows roots are pinned here instead of going unexercised.
 */
describe('ancestor walk root termination', () => {
	const WINDOWS_ROOTS = [
		'C:\\',
		'C:/',
		'C:',
		'\\',
		'\\\\server\\share',
		'\\\\server\\share\\',
		'\\\\?\\C:\\',
		'\\\\?\\UNC\\',
		'\\\\.\\C:\\',
	];

	it('treats every Windows root as a fixed point, so the walk cannot spin', () => {
		assert.deepStrictEqual(
			WINDOWS_ROOTS.filter((root) => win32.dirname(root) !== root),
			[],
		);
	});

	it('treats the POSIX root as a fixed point', () => {
		assert.strictEqual(posix.dirname('/'), '/');
	});

	it('stops at a UNC share root rather than walking into the server name', () => {
		const seen: string[] = [];
		let dir = '\\\\server\\share\\app\\aws-blocks';
		for (let guard = 0; guard < 64; guard++) {
			seen.push(dir);
			const parent = win32.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}

		assert.deepStrictEqual(seen, [
			'\\\\server\\share\\app\\aws-blocks',
			'\\\\server\\share\\app',
			'\\\\server\\share\\',
		]);
	});
});
