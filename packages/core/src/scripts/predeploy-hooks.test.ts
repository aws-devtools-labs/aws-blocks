// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks against a fake project: a block declares a hook in its
 * package.json, the runner finds it through the app's dependencies or the
 * umbrella's, runs it with the stage and the stacks of the deploy's assembly,
 * and turns stops into a thrown error.
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

/** Write a cloud assembly with one stack at `<root>/cdk.out`, as `cdk synth --output cdk.out` does. */
function assembly(root: string, stackName: string): void {
	mkdirSync(join(root, 'cdk.out'));
	writeFileSync(
		join(root, 'cdk.out', 'manifest.json'),
		JSON.stringify({
			artifacts: {
				tree: { type: 'cdk:tree' },
				[stackName]: { type: 'aws:cloudformation:stack', properties: { templateFile: 'stack.template.json' } },
			},
		}),
	);
	writeFileSync(join(root, 'cdk.out', 'stack.template.json'), JSON.stringify({ Resources: {} }));
}

const run = (projectRoot: string, stage: 'sandbox' | 'production', log: (line: string) => void = () => {}) =>
	runPredeployHooks({ stage, projectRoot, assemblyDir: 'cdk.out', log });

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

	test('runs every hook with the stage and the stacks of the assembly, prints notes', async () => {
		const root = project({ '@aws-blocks/bb-a': '*', '@aws-blocks/bb-b': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: guardHook },
			{ name: '@aws-blocks/bb-b', hooks: predeploy, hook: guardHook },
		]);
		assembly(root, 'App');
		const lines: string[] = [];
		await run(root, 'sandbox', (l) => lines.push(l));
		assert.deepStrictEqual(lines.sort(), [
			'[@aws-blocks/bb-a] checked App on sandbox',
			'[@aws-blocks/bb-b] checked App on sandbox',
		]);
	});

	test('a stop aborts the deploy with the hook named; a project with no hooks does nothing', async () => {
		const root = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: guardHook },
		]);
		assembly(root, 'BadStack');
		await assert.rejects(run(root, 'production'), /^Error: \[@aws-blocks\/bb-a\] Deploy stopped: BadStack$/);
		// No hook is declared, so the assembly (absent here) is not read.
		const empty = project({ '@aws-blocks/bb-plain': '*' }, [{ name: '@aws-blocks/bb-plain' }]);
		await run(empty, 'production');
	});

	test('a hook that cannot run fails the deploy instead of passing silently', async () => {
		const missing = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predeploy: './dist/nope.js' } },
		]);
		await assert.rejects(run(missing, 'production'), /does not exist/);
		const malformed = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: 'export const nothing = 1;\n' },
		]);
		await assert.rejects(run(malformed, 'production'), /does not export a predeploy\(\)/);
		const noAssembly = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: predeploy, hook: guardHook },
		]);
		await assert.rejects(run(noAssembly, 'production'), /No cloud assembly at .*cdk\.out/);
	});

	test('hooks that is not an object, an unknown hook name, or a hook that is not a module path fails the deploy', async () => {
		const notAnObject = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: ['./dist/predeploy.js'], hook: guardHook },
		]);
		await assert.rejects(
			run(notAnObject, 'production'),
			/@aws-blocks\/bb-a declares "aws-blocks"\."hooks" in its package\.json, which is not an object/,
		);
		const misspelled = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predploy: './dist/predeploy.js' }, hook: guardHook },
		]);
		await assert.rejects(
			run(misspelled, 'production'),
			/@aws-blocks\/bb-a declares a hook this version of @aws-blocks\/core does not run: predploy\./,
		);
		const notAPath = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', hooks: { predeploy: { module: './dist/predeploy.js' } }, hook: guardHook },
		]);
		await assert.rejects(
			run(notAPath, 'production'),
			/@aws-blocks\/bb-a declares a pre-deploy hook that is not a module path/,
		);
	});
});
