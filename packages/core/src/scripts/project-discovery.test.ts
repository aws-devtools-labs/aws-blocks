// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { PROJECT_MARKER, isBlocksProject, resolveProject } from './project-discovery.js';

let tmpRoot: string | undefined;

/** A real temp tree; realpath'd so comparisons survive a symlinked tmpdir. */
function makeRoot(label: string): string {
	tmpRoot = mkdtempSync(join(tmpdir(), `project-discovery-${label}-`));
	return realpathSync(tmpRoot);
}

function makeDir(...segments: string[]): string {
	const dir = join(...segments);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Plants the marker file, making `dir` a Blocks project. */
function makeProject(dir: string): string {
	mkdirSync(join(dir, 'aws-blocks'), { recursive: true });
	writeFileSync(join(dir, 'aws-blocks', 'index.ts'), 'export const blocks = {};');
	return dir;
}

function writePackageJson(dir: string, contents: string): void {
	writeFileSync(join(dir, 'package.json'), contents);
}

afterEach(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	tmpRoot = undefined;
});

describe('PROJECT_MARKER', () => {
	it('is the aws-blocks entry file', () => {
		assert.strictEqual(PROJECT_MARKER, 'aws-blocks/index.ts');
	});
});

describe('isBlocksProject', () => {
	it('is true for a directory holding the marker', () => {
		const root = makeRoot('is-project');
		makeProject(root);
		assert.strictEqual(isBlocksProject(root), true);
	});

	it('is false for a plain directory and for a nonexistent one', () => {
		const root = makeRoot('is-not-project');
		assert.strictEqual(isBlocksProject(root), false);
		assert.strictEqual(isBlocksProject(join(root, 'nope')), false);
	});

	it('is false when aws-blocks/index.ts is a directory rather than a file', () => {
		const root = makeRoot('marker-is-dir');
		makeDir(root, 'aws-blocks', 'index.ts');
		assert.strictEqual(isBlocksProject(root), false);
	});
});

describe('resolveProject — explicitPath', () => {
	it('accepts an explicit project, via "explicit", with no shadowed scan', () => {
		const root = makeRoot('explicit-good');
		const project = makeProject(makeDir(root, 'app'));
		makeProject(makeDir(project, 'nested'));

		const result = resolveProject({ startDir: root, explicitPath: project });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, project);
		assert.strictEqual(result.project.via, 'explicit');
		assert.deepStrictEqual(result.shadowed, []);
	});

	it('fails with bad-explicit and does NOT fall back to an otherwise-resolvable project', () => {
		const root = makeRoot('explicit-bad');
		makeProject(root);
		const notAProject = makeDir(root, 'docs');

		const result = resolveProject({ startDir: root, explicitPath: notAProject });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'bad-explicit');
		assert.deepStrictEqual(result.candidates, []);
		assert.match(result.message, /is not an AWS Blocks project/);
		assert.match(result.message, /aws-blocks\/index\.ts/);
		assert.ok(result.message.includes(notAProject));
	});
});

describe('resolveProject — startDir and ancestors', () => {
	it('resolves the start directory itself, via "cwd"', () => {
		const root = makeRoot('cwd-hit');
		makeProject(root);

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, root);
		assert.strictEqual(result.project.via, 'cwd');
	});

	it('resolves a parent one level up, via "ancestor"', () => {
		const root = makeRoot('ancestor-1');
		makeProject(root);
		const inner = makeDir(root, 'src');

		const result = resolveProject({ startDir: inner });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, root);
		assert.strictEqual(result.project.via, 'ancestor');
	});

	it('resolves an ancestor exactly at the maxWalkUp boundary', () => {
		const root = makeRoot('ancestor-boundary');
		makeProject(root);
		const deep = makeDir(root, 'a', 'b', 'c');

		const result = resolveProject({ startDir: deep, maxWalkUp: 3, maxChildDepth: 0 });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, root);
		assert.strictEqual(result.project.via, 'ancestor');
	});

	it('does not find an ancestor one level past maxWalkUp', () => {
		const root = makeRoot('ancestor-past-boundary');
		makeProject(root);
		const deep = makeDir(root, 'a', 'b', 'c', 'd');

		const result = resolveProject({ startDir: deep, maxWalkUp: 3 });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
	});
});

describe('resolveProject — descendant scan', () => {
	it('finds a project one level down, via "child"', () => {
		const root = makeRoot('child-depth-1');
		const project = makeProject(makeDir(root, 'app'));

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, project);
		assert.strictEqual(result.project.via, 'child');
		assert.deepStrictEqual(result.shadowed, []);
	});

	it('finds a project two levels down (apps/web) with default options', () => {
		const root = makeRoot('child-depth-2');
		const project = makeProject(makeDir(root, 'apps', 'web'));

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, project);
		assert.strictEqual(result.project.via, 'child');
	});

	it('reports ambiguous with sorted candidates when two projects are found', () => {
		const root = makeRoot('child-ambiguous');
		const zeta = makeProject(makeDir(root, 'zeta'));
		const alpha = makeProject(makeDir(root, 'alpha'));

		const result = resolveProject({ startDir: root });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'ambiguous');
		assert.deepStrictEqual(result.candidates, [alpha, zeta]);
		assert.deepStrictEqual(result.candidates, [...result.candidates].sort());
		assert.match(result.message, /--project/);
	});

	it('respects maxChildDepth, so a depth-2 project is missed at depth 1', () => {
		const root = makeRoot('child-depth-bound');
		makeProject(makeDir(root, 'apps', 'web'));

		const result = resolveProject({ startDir: root, maxChildDepth: 1 });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
	});

	it('reports not-found with actionable prose when nothing matches', () => {
		const root = makeRoot('not-found');
		makeDir(root, 'docs');

		const result = resolveProject({ startDir: root });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
		assert.deepStrictEqual(result.candidates, []);
		assert.match(result.message, /No AWS Blocks project found/);
		assert.match(result.message, /aws-blocks\/index\.ts/);
		assert.match(result.message, /--project <path>/);
		assert.ok(result.message.includes(root));
	});

	it('ignores a decoy marker inside node_modules', () => {
		const root = makeRoot('node-modules-decoy');
		makeProject(makeDir(root, 'node_modules', '@aws-blocks', 'core'));

		const result = resolveProject({ startDir: root, maxChildDepth: 4 });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
	});

	it('ignores dotted directories and build output directories', () => {
		const root = makeRoot('skip-dirs');
		makeProject(makeDir(root, '.cache', 'app'));
		makeProject(makeDir(root, 'dist', 'app'));
		makeProject(makeDir(root, 'cdk.out', 'app'));

		const result = resolveProject({ startDir: root, maxChildDepth: 4 });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
	});
});

describe('resolveProject — shadowed projects', () => {
	it('lists a project nested inside the resolved one', () => {
		const root = makeRoot('shadowed-some');
		makeProject(root);
		const nested = makeProject(makeDir(root, 'apps', 'web'));

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.strictEqual(result.project.via, 'cwd');
		assert.deepStrictEqual(result.shadowed, [nested]);
	});

	it('reports shadowed for an ancestor hit too', () => {
		const root = makeRoot('shadowed-ancestor');
		makeProject(root);
		const nested = makeProject(makeDir(root, 'packages'));
		const startDir = makeDir(root, 'scripts');

		const result = resolveProject({ startDir });

		assert.ok(result.ok);
		assert.strictEqual(result.project.path, root);
		assert.strictEqual(result.project.via, 'ancestor');
		assert.deepStrictEqual(result.shadowed, [nested]);
	});

	it('is empty when nothing is nested inside the resolved project', () => {
		const root = makeRoot('shadowed-none');
		makeProject(root);
		makeDir(root, 'apps', 'web');

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.deepStrictEqual(result.shadowed, []);
	});
});

describe('resolveProject — project name', () => {
	it('uses package.json name when it is a non-empty string', () => {
		const root = makeRoot('name-from-pkg');
		makeProject(root);
		writePackageJson(root, JSON.stringify({ name: '@acme/storefront' }));

		const result = resolveProject({ startDir: root });

		assert.ok(result.ok);
		assert.strictEqual(result.project.name, '@acme/storefront');
	});

	it('falls back to the directory basename when package.json is corrupt', () => {
		const root = makeRoot('name-corrupt-pkg');
		const project = makeProject(makeDir(root, 'my-app'));
		writePackageJson(project, '{ "name": "broken", ');

		const result = resolveProject({ startDir: project });

		assert.ok(result.ok);
		assert.strictEqual(result.project.name, 'my-app');
	});

	it('falls back to the directory basename when package.json is absent or nameless', () => {
		const root = makeRoot('name-no-pkg');
		const withoutPkg = makeProject(makeDir(root, 'bare-app'));
		const emptyName = makeProject(makeDir(root, 'empty-name-app'));
		writePackageJson(emptyName, JSON.stringify({ name: '   ' }));

		const bare = resolveProject({ startDir: withoutPkg });
		assert.ok(bare.ok);
		assert.strictEqual(bare.project.name, 'bare-app');

		const named = resolveProject({ startDir: emptyName });
		assert.ok(named.ok);
		assert.strictEqual(named.project.name, 'empty-name-app');
	});
});

describe('resolveProject — bounds and safety', () => {
	it('stops examining directories once childScanLimit is reached', () => {
		// The scan is breadth-first, so every depth-1 directory is examined before
		// any depth-2 one. A limit below the depth-1 count can therefore never reach
		// apps/web, whatever order the filesystem returns entries in.
		const root = makeRoot('scan-limit');
		for (let index = 0; index < 10; index += 1) {
			makeDir(root, `pad-${String(index).padStart(2, '0')}`);
		}
		const project = makeProject(makeDir(root, 'apps', 'web'));

		const limited = resolveProject({ startDir: root, childScanLimit: 5 });
		assert.ok(!limited.ok);
		assert.strictEqual(limited.reason, 'not-found');

		const unlimited = resolveProject({ startDir: root });
		assert.ok(unlimited.ok);
		assert.strictEqual(unlimited.project.path, project);
		assert.strictEqual(unlimited.project.via, 'child');
	});

	it('returns not-found instead of throwing for a nonexistent startDir', () => {
		const root = makeRoot('missing-start-dir');

		const result = resolveProject({ startDir: join(root, 'gone'), maxWalkUp: 0 });

		assert.ok(!result.ok);
		assert.strictEqual(result.reason, 'not-found');
	});
});
