// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks against a fake project: a block declares a hook in its
 * package.json, the runner finds it through the app's dependencies or the
 * umbrella's, runs it for the declared stages only, synthesizes at most once,
 * and turns stops into a thrown error.
 */
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { discoverPredeployHooks, resolvePackageDir, runPredeployHooks } from './predeploy-hooks.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakePackage {
	name: string;
	dependencies?: Record<string, string>;
	predeploy?: { module: string; stages?: string[] };
	/** Body of the hook module (ESM). */
	hook?: string;
}

/** A project with the given packages installed under node_modules, each with an exports map that hides package.json. */
function project(appDependencies: Record<string, string>, packages: FakePackage[]): string {
	const root = mkdtempSync(join(tmpdir(), 'blocks-predeploy-'));
	dirs.push(root);
	writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: appDependencies }));
	for (const pkg of packages) {
		const dir = join(root, 'node_modules', ...pkg.name.split('/'));
		mkdirSync(join(dir, 'dist'), { recursive: true });
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({
				name: pkg.name,
				type: 'module',
				exports: { '.': './dist/index.js' },
				dependencies: pkg.dependencies,
				...(pkg.predeploy ? { 'aws-blocks': { predeploy: pkg.predeploy } } : {}),
			}),
		);
		writeFileSync(join(dir, 'dist', 'index.js'), 'export const block = true;\n');
		if (pkg.hook) writeFileSync(join(dir, 'dist', 'predeploy.js'), pkg.hook);
	}
	return root;
}

const guardHook = `
export async function predeploy(context) {
  const stacks = await context.synth();
  const again = await context.synth();
  if (stacks !== again) throw new Error('synth must be cached');
  const names = stacks.map((s) => s.stackName).join(',');
  if (context.stage === 'production' && names.includes('Bad')) return { stops: ['Deploy stopped: ' + names] };
  return { notes: ['checked ' + names + ' on ' + context.stage] };
}
`;

const fakeSynth = (stackName: string) => {
	let calls = 0;
	const synthesize = () => {
		calls++;
		return { stacks: [{ stackName, template: {} }], cleanup: () => {} };
	};
	return { synthesize, calls: () => calls };
};

describe('pre-deploy hooks', () => {
	test('a package behind an exports map is still located', () => {
		const root = project({ '@aws-blocks/bb-x': '*' }, [{ name: '@aws-blocks/bb-x' }]);
		// require.resolve returns real paths; the temp dir may sit behind a symlink (macOS /var → /private/var).
		assert.strictEqual(
			resolvePackageDir(root, '@aws-blocks/bb-x'),
			realpathSync(join(root, 'node_modules', '@aws-blocks', 'bb-x')),
		);
		assert.strictEqual(resolvePackageDir(root, '@aws-blocks/missing'), undefined);
	});

	test('discovery reads the manifest field, through the app and through the umbrella, with stages', () => {
		const root = project({ '@aws-blocks/blocks': '*', '@aws-blocks/bb-direct': '*' }, [
			{
				name: '@aws-blocks/blocks',
				dependencies: { '@aws-blocks/bb-via-umbrella': '*', '@aws-blocks/bb-plain': '*' },
			},
			{
				name: '@aws-blocks/bb-via-umbrella',
				predeploy: { module: './dist/predeploy.js', stages: ['production'] },
				hook: guardHook,
			},
			{ name: '@aws-blocks/bb-direct', predeploy: { module: './dist/predeploy.js' }, hook: guardHook },
			{ name: '@aws-blocks/bb-plain' },
		]);
		const hooks = discoverPredeployHooks(root).sort((a, b) => a.packageName.localeCompare(b.packageName));
		assert.deepStrictEqual(
			hooks.map((h) => [h.packageName, h.stages]),
			[
				['@aws-blocks/bb-direct', ['sandbox', 'production']],
				['@aws-blocks/bb-via-umbrella', ['production']],
			],
		);
		assert.ok(hooks[0].module.endsWith(join('bb-direct', 'dist', 'predeploy.js')));
	});

	test('runs the hooks for the stage, synthesizes once, prints notes', async () => {
		const root = project({ '@aws-blocks/bb-a': '*', '@aws-blocks/bb-b': '*' }, [
			{ name: '@aws-blocks/bb-a', predeploy: { module: './dist/predeploy.js' }, hook: guardHook },
			{
				name: '@aws-blocks/bb-b',
				predeploy: { module: './dist/predeploy.js', stages: ['production'] },
				hook: guardHook,
			},
		]);
		const synth = fakeSynth('App');
		const lines: string[] = [];
		const sandbox = await runPredeployHooks({
			stage: 'sandbox',
			projectRoot: root,
			synthesize: synth.synthesize,
			log: (l) => lines.push(l),
		});
		assert.deepStrictEqual(sandbox.ran, ['@aws-blocks/bb-a'], 'bb-b is production only');
		assert.deepStrictEqual(lines, ['[@aws-blocks/bb-a] checked App on sandbox']);
		assert.strictEqual(synth.calls(), 1);

		const production = await runPredeployHooks({
			stage: 'production',
			projectRoot: root,
			synthesize: synth.synthesize,
			log: () => {},
		});
		assert.deepStrictEqual(production.ran.sort(), ['@aws-blocks/bb-a', '@aws-blocks/bb-b']);
		assert.strictEqual(synth.calls(), 2, 'one synth per run, shared by both hooks');
	});

	test('a stop aborts the deploy with the hook named; a project with no hooks does nothing', async () => {
		const root = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', predeploy: { module: './dist/predeploy.js' }, hook: guardHook },
		]);
		const synth = fakeSynth('BadStack');
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: root, synthesize: synth.synthesize, log: () => {} }),
			/^Error: \[@aws-blocks\/bb-a\] Deploy stopped: BadStack$/,
		);
		const empty = project({ '@aws-blocks/bb-plain': '*' }, [{ name: '@aws-blocks/bb-plain' }]);
		assert.deepStrictEqual(
			await runPredeployHooks({ stage: 'production', projectRoot: empty, synthesize: synth.synthesize }),
			{
				ran: [],
				notes: [],
			},
		);
		assert.strictEqual(synth.calls(), 1, 'no synth when nothing is registered');
	});

	test('a declared hook that is missing or malformed fails the deploy instead of passing silently', async () => {
		const missing = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', predeploy: { module: './dist/nope.js' } },
		]);
		await assert.rejects(runPredeployHooks({ stage: 'production', projectRoot: missing }), /does not exist/);
		const malformed = project({ '@aws-blocks/bb-a': '*' }, [
			{
				name: '@aws-blocks/bb-a',
				predeploy: { module: './dist/predeploy.js' },
				hook: 'export const nothing = 1;\n',
			},
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: malformed }),
			/does not export a predeploy\(\)/,
		);
	});
});
