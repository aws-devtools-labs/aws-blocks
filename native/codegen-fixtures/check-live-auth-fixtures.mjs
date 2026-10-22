#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that the auth-derived codegen fixtures still describe what the live
 * `Auth` block emits.
 *
 * `regenerate-all.sh` regenerates the golden files from each fixture's
 * committed `spec.json`, so a clean regeneration proves only that the
 * generators did not change — not that the fixture matches the auth block.
 * This script closes that gap: it reads the OpenRPC spec of
 * `test-apps/native-bindings` (whose `auth-*` blocks are `Auth` instances) and
 * compares the auth methods, plus every component schema they reach through
 * `$ref`, against the fixtures below. Any other component a fixture carries
 * (e.g. `Todo` in 18) is not compared.
 *
 * Usage (from the repo root, after `npm run build`):
 *
 *   node native/codegen-fixtures/check-live-auth-fixtures.mjs --generate
 *       regenerate the spec (`npm run spec` in test-apps/native-bindings), then check
 *   node native/codegen-fixtures/check-live-auth-fixtures.mjs [path/to/blocks.spec.json]
 *       check an already-generated spec (default: test-apps/native-bindings/aws-blocks/blocks.spec.json)
 *   node native/codegen-fixtures/check-live-auth-fixtures.mjs --write [...]
 *       rewrite the fixtures' spec.json from the live spec; then run
 *       native/codegen-fixtures/regenerate-all.sh and review the golden-file diff
 *
 * Exits 1 when a fixture drifted (or a method is missing from the live spec).
 * CI: the `setup` job of .github/workflows/native-sdk-e2e.yml.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(FIXTURES_DIR, '..', '..');
const BACKEND_DIR = join(REPO_ROOT, 'test-apps', 'native-bindings');
const DEFAULT_SPEC = join(BACKEND_DIR, 'aws-blocks', 'blocks.spec.json');

/**
 * Each fixture: the method names it carries → the live method it must equal.
 * Fixture 18 *is* the `Auth` sign-in state machine (`createApi()`'s
 * `setAuthState`, which is identical for every `Auth` configuration);
 * fixture 23 is `Auth.signIn` / `confirmSignIn`'s nested result unions, as
 * native-bindings' `api.cognitoSignIn` / `api.cognitoConfirmSignIn` return them.
 */
const FIXTURES = [
	{ dir: '18-hybrid-arm', methods: { 'authApi.setAuthState': 'authBasicApi.setAuthState' } },
	{
		dir: '23-cognito-nested-unions',
		methods: {
			'api.cognitoConfirmSignIn': 'api.cognitoConfirmSignIn',
			'api.cognitoSignIn': 'api.cognitoSignIn',
		},
	},
];

const args = process.argv.slice(2);
const write = args.includes('--write');
const generate = args.includes('--generate');
const specPath = args.find((a) => !a.startsWith('--')) ?? DEFAULT_SPEC;

if (generate) {
	console.log(`==> Generating the live spec (npm run spec in ${relative(REPO_ROOT, BACKEND_DIR)})`);
	execFileSync('npm', ['run', 'spec'], { cwd: BACKEND_DIR, stdio: 'inherit' });
}
if (!existsSync(specPath)) {
	console.error(`No spec at ${specPath}. Run with --generate, or \`npm run spec\` in test-apps/native-bindings.`);
	process.exit(1);
}

const live = JSON.parse(readFileSync(specPath, 'utf8'));
const liveSchemas = live.components?.schemas ?? {};
const liveMethods = new Map(live.methods.map((m) => [m.name, m]));

/** Names of every component schema reachable from `roots` through `$ref`. */
function refClosure(roots, schemas) {
	const seen = new Set();
	const visit = (node) => {
		if (Array.isArray(node)) {
			for (const n of node) visit(n);
		} else if (node && typeof node === 'object') {
			const ref = node.$ref;
			if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
				const name = ref.slice('#/components/schemas/'.length);
				if (!seen.has(name)) {
					seen.add(name);
					visit(schemas[name]);
				}
			}
			for (const v of Object.values(node)) visit(v);
		}
	};
	visit(roots);
	return seen;
}

const json = (v) => JSON.stringify(v, null, 2);
let drifted = 0;

for (const fixture of FIXTURES) {
	const fixturePath = join(FIXTURES_DIR, fixture.dir, 'spec.json');
	const raw = readFileSync(fixturePath, 'utf8');
	const spec = JSON.parse(raw);
	const fixtureSchemas = spec.components?.schemas ?? {};
	const problems = [];

	const expectedMethods = Object.entries(fixture.methods).map(([fixtureName, liveName]) => {
		const method = liveMethods.get(liveName);
		if (!method) {
			problems.push(`live spec has no method ${liveName}`);
			return null;
		}
		return { ...method, name: fixtureName };
	});
	if (problems.length > 0) {
		drifted++;
		console.error(`✗ ${fixture.dir}: ${problems.join('; ')}`);
		continue;
	}

	const actualMethods = Object.keys(fixture.methods).map((name) => spec.methods.find((m) => m.name === name) ?? null);
	const expectedClosure = refClosure(expectedMethods, liveSchemas);
	const actualClosure = refClosure(
		actualMethods.filter((m) => m !== null),
		fixtureSchemas,
	);

	for (const [i, expected] of expectedMethods.entries()) {
		if (json(actualMethods[i]) !== json(expected)) problems.push(`method ${expected.name} differs`);
	}
	for (const name of new Set([...expectedClosure, ...actualClosure])) {
		if (!expectedClosure.has(name)) problems.push(`schema ${name} is no longer reachable from the live methods`);
		else if (!actualClosure.has(name)) problems.push(`schema ${name} is missing`);
		else if (json(fixtureSchemas[name]) !== json(liveSchemas[name])) problems.push(`schema ${name} differs`);
	}

	if (problems.length === 0) {
		console.log(`✓ ${fixture.dir} matches the live spec`);
		continue;
	}

	if (!write) {
		drifted++;
		console.error(`✗ ${fixture.dir} no longer matches the live spec:\n    - ${problems.join('\n    - ')}`);
		continue;
	}

	// Rewrite: replace the fixture's methods with the live ones, drop schemas only
	// the old methods reached, and set every live-reachable schema (existing keys
	// keep their position). Components outside both closures are kept.
	spec.methods = spec.methods.map((m) => expectedMethods.find((e) => e.name === m.name) ?? m);
	const schemas = { ...fixtureSchemas };
	for (const name of actualClosure) if (!expectedClosure.has(name)) delete schemas[name];
	for (const name of expectedClosure) schemas[name] = liveSchemas[name];
	spec.components = { ...spec.components, schemas };
	writeFileSync(fixturePath, json(spec) + (raw.endsWith('\n') ? '\n' : ''));
	console.log(`✎ ${fixture.dir}: rewrote spec.json (${problems.length} change(s))`);
}

if (drifted > 0) {
	console.error(
		`\n${drifted} auth fixture(s) drifted from the live Auth block. If the change is intended, run\n` +
			'  node native/codegen-fixtures/check-live-auth-fixtures.mjs --write\n' +
			'  native/codegen-fixtures/regenerate-all.sh\n' +
			'and commit the fixture specs with their regenerated golden files.',
	);
	process.exit(1);
}
