#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates src/readme.generated.test.ts from README.md.
 *
 * The test file holds every fenced `typescript` block of the README, in README
 * order, inside one function that is never called. The package build compiles
 * it against the package's own types, so a README edit that breaks a snippet
 * fails the build. Nothing in the snippets runs.
 *
 * The file also holds a digest of the snippets. Its second test reads
 * README.md when the tests run and compares: a README edit with no build after
 * it fails that test, so the tests never pass on snippets that were not
 * compiled.
 *
 * What the generator does to a block, and nothing else:
 * - `import { a, b } from 'module'` lines move to the top of the file. The
 *   package's own name resolves to the mock entry. `@aws-cdk-blocks/bb-auth`
 *   depends on this package, so it cannot be imported here: `Auth` gets a
 *   declared stand-in with the one method the README calls. Names imported
 *   from the umbrella `aws-cdk-blocks`, which also depends on this
 *   package, resolve one by one to the module the umbrella re-exports them from.
 * - A leading `export ` is dropped, because the code is inside a function.
 * - A line of the form `// <code>;   compile error...` is a claim that `<code>`
 *   does not compile. It becomes `<code>` under `// @ts-expect-error`, so the
 *   build also fails when the claim stops being true.
 *
 * The blocks share one scope, as they do for a reader: a later block uses the
 * stores an earlier block declares. A block that is not TypeScript source (a
 * signature sketch, shell output) must use another fence label, such as `text`.
 *
 * Called from the package's `prebuild` script.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(pkgDir, 'README.md'), 'utf8');

/** The fewest blocks and compile-error claims the README has had; fewer means the extraction broke. */
const MIN_BLOCKS = 15;
const MIN_CLAIMS = 4;

/** Module specifiers the generated file resolves differently from an app. */
const MODULE_ALIASES = { '@aws-cdk-blocks/bb-kv-store': './index.mock.js' };

/**
 * The README imports from the umbrella, as an app does, but the umbrella depends on
 * this package, so the generated file cannot import it. Each name is resolved where
 * the umbrella re-exports it from: a name this package exports (from the mock entry
 * or `types.ts`) to the mock entry, a name with a stand-in to the stand-in, and every
 * other name to `@aws-cdk-blocks/core`, which the umbrella re-exports whole. A name
 * resolved to the wrong module fails the build.
 */
const UMBRELLA = 'aws-cdk-blocks';
const UMBRELLA_STAND_INS = { Auth: '@aws-cdk-blocks/bb-auth' };
const ownNames = new Set(
	['index.mock.ts', 'types.ts'].flatMap((file) => {
		const source = readFileSync(join(pkgDir, 'src', file), 'utf8');
		const declared = [...source.matchAll(/^export (?:declare )?(?:abstract )?(?:class|const|function|type|interface|enum) (\w+)/gm)];
		const listed = [...source.matchAll(/^export (?:type )?\{([^}]+)\} from /gm)].flatMap((match) =>
			match[1].split(',').map((name) => [null, name.trim().split(/\s+as\s+/).pop()]),
		);
		return [...declared, ...listed].map((match) => match[1]);
	}),
);

/** Where one name imported from `specifier` resolves in the generated file. */
function resolveImport(specifier, name) {
	if (specifier !== UMBRELLA) return MODULE_ALIASES[specifier] ?? specifier;
	if (UMBRELLA_STAND_INS[name]) return UMBRELLA_STAND_INS[name];
	if (ownNames.has(name)) return MODULE_ALIASES['@aws-cdk-blocks/bb-kv-store'];
	return '@aws-cdk-blocks/core';
}

/** Modules that cannot be imported from this package, and the declaration that stands in for what the README uses. */
const STAND_INS = {
	'@aws-cdk-blocks/bb-auth': [
		'/** Stand-in for `Auth`: bb-auth depends on this package, so it cannot be imported here. */',
		'declare class Auth {',
		'\tconstructor(scope: ScopeParent, id: string);',
		'\trequireAuth(context: unknown): Promise<{ userSub: string; username: string }>;',
		'}',
	],
};

function fail(message) {
	console.error(`generate-readme-test: ${message}`);
	process.exit(1);
}

const blocks = [...readme.matchAll(/^```typescript\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
if (blocks.length < MIN_BLOCKS) {
	fail(`found ${blocks.length} \`typescript\` blocks in README.md, expected at least ${MIN_BLOCKS}`);
}

/** A digest of the snippets, for the test that compares it with README.md when the tests run. */
const digest = createHash('sha256').update(blocks.join('\n')).digest('hex');

/** module specifier → imported names */
const imports = new Map();
const standIns = [];
const body = [];
let claims = 0;

for (const [index, block] of blocks.entries()) {
	body.push('', `\t// ── README snippet ${index + 1} of ${blocks.length} ──`);
	for (const line of block.replace(/\n$/, '').split('\n')) {
		const named = line.match(/^import \{ ([^}]+) \} from '([^']+)';$/);
		if (named) {
			const [, names, specifier] = named;
			for (const name of names.split(',').map((n) => n.trim())) {
				const module = resolveImport(specifier, name);
				if (STAND_INS[module]) {
					if (!standIns.includes(module)) standIns.push(module);
					continue;
				}
				const set = imports.get(module) ?? new Set();
				set.add(name);
				imports.set(module, set);
			}
			continue;
		}
		if (/^import\b/.test(line)) fail(`snippet ${index + 1}: unsupported import form: ${line}`);

		const claim = line.match(/^(\s*)\/\/ (\S.*?;)\s+compile error(.*)$/);
		if (claim) {
			const [, indent, code, reason] = claim;
			claims++;
			body.push(`\t${indent}// @ts-expect-error README says: compile error${reason}`, `\t${indent}${code}`);
			continue;
		}
		body.push(line === '' ? '' : `\t${line.replace(/^export /, '')}`);
	}
}
if (claims < MIN_CLAIMS) {
	fail(`found ${claims} "compile error" claims in README.md, expected at least ${MIN_CLAIMS}`);
}

// `scope` and the stand-ins need `ScopeParent`.
const core = imports.get('@aws-cdk-blocks/core') ?? new Set();
imports.set('@aws-cdk-blocks/core', core);

const importLines = [...imports.entries()]
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([module, names]) => `import { ${[...names].sort().join(', ')} } from '${module}';`);

const output = [
	'// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.',
	'// SPDX-License-Identifier: Apache-2.0',
	'',
	'// GENERATED by scripts/generate-readme-test.mjs from README.md — do not edit.',
	'// Edit README.md and run `npm run prebuild`; see the script for what it changes in a snippet.',
	'',
	"import assert from 'node:assert';",
	"import { createHash } from 'node:crypto';",
	"import { readFileSync } from 'node:fs';",
	"import { test } from 'node:test';",
	"import type { ScopeParent } from '@aws-cdk-blocks/core';",
	...importLines,
	'',
	'declare const scope: ScopeParent;',
	...standIns.flatMap((specifier) => ['', ...STAND_INS[specifier]]),
	'',
	'async function _readme() {',
	...body.slice(1),
	'}',
	'',
	`test('the ${blocks.length} TypeScript snippets of README.md compile against the package types', () => {`,
	'\t// The compiler checked the function above when the package was built; it is never called.',
	"\tassert.strictEqual(typeof _readme, 'function');",
	'});',
	'',
	"test('the snippets compiled here are the snippets of README.md as it is now', () => {",
	"\tconst readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');",
	'\tconst blocks = [...readme.matchAll(/^```typescript\\n([\\s\\S]*?)^```$/gm)].map((match) => match[1]);',
	"\tconst stale = 'README.md changed after the build. Build the package again to compile its snippets.';",
	`\tassert.strictEqual(blocks.length, ${blocks.length}, stale);`,
	`\tassert.strictEqual(createHash('sha256').update(blocks.join('\\n')).digest('hex'), '${digest}', stale);`,
	'});',
	'',
].join('\n');

writeFileSync(join(pkgDir, 'src', 'readme.generated.test.ts'), output);
console.log(`Generated readme.generated.test.ts: ${blocks.length} snippets, ${claims} compile-error claims`);
