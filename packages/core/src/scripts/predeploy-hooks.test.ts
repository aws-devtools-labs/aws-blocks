// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks against a fake project: a block declares a hook in its
 * package.json, the runner finds it through the app's dependencies or the
 * umbrella's, runs it with the stage, synthesizes at most once, and turns
 * stops into a thrown error.
 */
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { discoverPredeployHooks, runPredeployHooks } from './predeploy-hooks.js';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakePackage {
	name: string;
	dependencies?: Record<string, string>;
	/** The package's `aws-blocks.hooks` declaration, written as given. */
	hooks?: unknown;
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
				...(pkg.hooks !== undefined ? { 'aws-blocks': { hooks: pkg.hooks } } : {}),
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

const predeploy = { predeploy: './dist/predeploy.js' };

const fakeSynth = (stackName: string) => {
	let calls = 0;
	const synthesize = () => {
		calls++;
		return [{ stackName, template: {} }];
	};
	return { synthesize, calls: () => calls };
};

describe('pre-deploy hooks', () => {
	test('discovery reads the manifest field, through the app and through the umbrella', () => {
		// Every fake package hides its package.json behind an exports map; bb-missing is not installed.
		const root = project(
			{ '@aws-blocks/blocks': '*', '@aws-blocks/bb-direct': '*', '@aws-blocks/bb-missing': '*' },
			[
				{
					name: '@aws-blocks/blocks',
					dependencies: { '@aws-blocks/bb-via-umbrella': '*', '@aws-blocks/bb-plain': '*' },
				},
				{ name: '@aws-blocks/bb-via-umbrella', hooks: predeploy, hook: guardHook },
				{ name: '@aws-blocks/bb-direct', hooks: predeploy, hook: guardHook },
				{ name: '@aws-blocks/bb-plain' },
			],
		);
		const hooks = discoverPredeployHooks(root).sort((a, b) => a.packageName.localeCompare(b.packageName));
		assert.deepStrictEqual(
			hooks.map((h) => h.packageName),
			['@aws-blocks/bb-direct', '@aws-blocks/bb-via-umbrella'],
		);
		assert.ok(hooks[0].module.endsWith(join('bb-direct', 'dist', 'predeploy.js')));
	});

	test('runs every hook with the stage, synthesizes once, prints notes', async () => {
		const root = project({ '@aws-blocks/bb-a': '*', '@aws-blocks/bb-b': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: guardHook },
			{ name: '@aws-blocks/bb-b', hooks: predeploy, hook: guardHook },
		]);
		const synth = fakeSynth('App');
		const lines: string[] = [];
		await runPredeployHooks({
			stage: 'sandbox',
			projectRoot: root,
			synthesize: synth.synthesize,
			log: (l) => lines.push(l),
		});
		assert.deepStrictEqual(lines.sort(), [
			'[@aws-blocks/bb-a] checked App on sandbox',
			'[@aws-blocks/bb-b] checked App on sandbox',
		]);
		assert.strictEqual(synth.calls(), 1, 'one synth, shared by both hooks');
	});

	test('a stop aborts the deploy with the hook named; a project with no hooks does nothing', async () => {
		const root = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: guardHook },
		]);
		const synth = fakeSynth('BadStack');
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: root, synthesize: synth.synthesize, log: () => {} }),
			/^Error: \[@aws-blocks\/bb-a\] Deploy stopped: BadStack$/,
		);
		const empty = project({ '@aws-blocks/bb-plain': '*' }, [{ name: '@aws-blocks/bb-plain' }]);
		await runPredeployHooks({ stage: 'production', projectRoot: empty, synthesize: synth.synthesize });
		assert.strictEqual(synth.calls(), 1, 'no synth when no hook is declared');
	});

	test('a declared hook that is missing or malformed fails the deploy instead of passing silently', async () => {
		const missing = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predeploy: './dist/nope.js' } },
		]);
		await assert.rejects(runPredeployHooks({ stage: 'production', projectRoot: missing }), /does not exist/);
		const malformed = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: 'export const nothing = 1;\n' },
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: malformed }),
			/does not export a predeploy\(\)/,
		);
	});

	test('hooks that is not an object, an unknown hook name, or a hook that is not a module path fails the deploy', async () => {
		const notAnObject = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: ['./dist/predeploy.js'], hook: guardHook },
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: notAnObject }),
			/@aws-blocks\/bb-a declares "aws-blocks"\."hooks" in its package\.json, which is not an object/,
		);
		const misspelled = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predploy: './dist/predeploy.js' }, hook: guardHook },
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: misspelled }),
			/@aws-blocks\/bb-a declares a hook this version of @aws-blocks\/core does not run: predploy\./,
		);
		const notAPath = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predeploy: { module: './dist/predeploy.js' } }, hook: guardHook },
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: notAPath }),
			/@aws-blocks\/bb-a declares a pre-deploy hook that is not a module path/,
		);
	});
});
