// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Regression test: a client middleware module must stay in a bundle of the generated client.
 *
 * A client middleware module registers itself when it is imported: it calls
 * `registerMiddleware()` at its top level. The generated `client.js` loads it with
 * a bare `import '<specifier>';` — `generateClientCode` in `@aws-blocks/core` emits
 * one for every specifier a Building Block passes to `registerClientMiddleware()`.
 *
 * A bundler removes a bare import of a module that its package declares free of
 * side effects (`"sideEffects": false`, or a `"sideEffects"` array that leaves the
 * module out). The frontend still builds, and API calls then return the raw
 * `{ __blocks: … }` descriptor instead of the live client object.
 *
 * This test finds every specifier a Building Block registers, bundles the import
 * the generated client contains for it under the `browser` condition, and checks
 * that the module is in the output.
 *
 * Packages are discovered automatically: every `packages/bb-*` package whose
 * compiled code calls `registerClientMiddleware('<specifier>')`.
 *
 * Run: node --test dist/client-middleware-side-effects.test.js
 */

const packagesDir = realpathSync(join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'packages'));

type ExportTarget = string | { [condition: string]: ExportTarget };
type Manifest = { name: string; sideEffects?: boolean | string[]; exports?: Record<string, ExportTarget> };
type Package = { dirName: string; dir: string; manifest: Manifest };

/** `this.registerClientMiddleware('<specifier>')`. Group 2 is the specifier. */
const REGISTER_LITERAL = /\.registerClientMiddleware\(\s*(['"])([^'"]+)\1\s*\)/g;
/** Any call, to catch a specifier this test cannot read (a variable, a template literal). */
const REGISTER_ANY = /\.registerClientMiddleware\(/g;

/** Compiled source without its comment lines: tsc keeps JSDoc, and a comment may name the call. */
const withoutCommentLines = (source: string): string =>
	source
		.split('\n')
		.filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
		.join('\n');

function compiledFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== 'node_modules') compiledFiles(full, acc);
		} else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
			acc.push(full);
		}
	}
	return acc;
}

/** The file an exports-map target loads by default: the string itself, or its `default` condition. */
const defaultTarget = (target: ExportTarget | undefined): string | undefined =>
	typeof target === 'object' ? defaultTarget(target.default) : target;

const packages: Package[] = readdirSync(packagesDir, { withFileTypes: true })
	.filter((dir) => dir.isDirectory() && existsSync(join(packagesDir, dir.name, 'package.json')))
	.map((dir) => {
		const packageDir = join(packagesDir, dir.name);
		return {
			dirName: dir.name,
			dir: packageDir,
			manifest: JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')),
		};
	});

// Every specifier a Building Block registers, read from its compiled code.
const specifiers = new Set<string>();
const unreadable: string[] = [];
for (const { dirName, dir } of packages) {
	const dist = join(dir, 'dist');
	if (!dirName.startsWith('bb-') || !existsSync(dist)) continue;
	for (const file of compiledFiles(dist)) {
		const source = withoutCommentLines(readFileSync(file, 'utf-8'));
		const literal = [...source.matchAll(REGISTER_LITERAL)];
		for (const match of literal) {
			if (match[2]) specifiers.add(match[2]);
		}
		if ((source.match(REGISTER_ANY) ?? []).length !== literal.length) unreadable.push(relative(packagesDir, file));
	}
}

/** The package that owns `specifier` and the file its exports map loads for it. */
function resolveMiddleware(specifier: string): { owner: Package; target: string } {
	const [scope, name, ...rest] = specifier.split('/');
	const owner = packages.find((pkg) => pkg.manifest.name === `${scope}/${name}`);
	assert.ok(owner, `${specifier} names a package that is not in packages/`);
	const subpath = `./${rest.join('/')}`;
	const target = defaultTarget(owner.manifest.exports?.[subpath]);
	assert.ok(target, `${owner.manifest.name} has no "${subpath}" export for the client middleware it registers`);
	return { owner, target };
}

test('client middleware discovery floor', () => {
	assert.deepStrictEqual(
		unreadable,
		[],
		'registerClientMiddleware() is called with something other than a string literal, ' +
			'so this test cannot read the specifier from the compiled code',
	);
	// bb-realtime (AWS and local) and bb-file-bucket. A floor keeps the set from shrinking
	// quietly, e.g. if the compiled call changes shape and the pattern stops matching.
	assert.ok(specifiers.size >= 3, `Expected ≥3 client middleware modules, found ${specifiers.size}`);
});

for (const specifier of [...specifiers].sort()) {
	test(`${specifier}: stays in a browser bundle of the generated client`, async () => {
		const { owner, target } = resolveMiddleware(specifier);
		const result = await build({
			// The line `generateClientCode` emits for this specifier.
			stdin: { contents: `import ${JSON.stringify(specifier)};`, resolveDir: packagesDir },
			absWorkingDir: packagesDir,
			bundle: true,
			platform: 'browser',
			conditions: ['browser'],
			write: false,
			metafile: true,
			logLevel: 'silent',
		});
		const bundled = Object.values(result.metafile.outputs).flatMap((output) =>
			Object.entries(output.inputs)
				.filter(([, input]) => input.bytesInOutput > 0)
				.map(([file]) => file),
		);
		const file = relative(packagesDir, realpathSync(join(owner.dir, target)))
			.split(sep)
			.join('/');

		assert.ok(
			bundled.includes(file),
			`A bundler drops ${specifier} from the generated client: ${owner.manifest.name} declares ` +
				`"sideEffects": ${JSON.stringify(owner.manifest.sideEffects)}, which marks ${target} as free of side effects. ` +
				'The module registers its middleware when it is imported, so add ' +
				`"${target}" to the "sideEffects" array in packages/${owner.dirName}/package.json.`,
		);
	});
}
