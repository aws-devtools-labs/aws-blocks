// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks against a fake project: a block declares a hook in its
 * package.json, the runner finds it through the app's dependencies or the
 * umbrella's, runs it for the declared stages only, synthesizes at most once,
 * and turns stops into a thrown error. With the deploy's own assembly, the
 * hooks read its stacks, nested stacks included, without a second synth.
 */
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import {
	discoverPredeployHooks,
	readSynthesizedStacks,
	resolvePackageDir,
	runPredeployHooks,
	type SynthesizedStack,
} from './predeploy-hooks.js';

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
	/** The package's `exports` map. @default { '.': './dist/index.js' } */
	exports?: Record<string, unknown>;
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
				exports: pkg.exports ?? { '.': './dist/index.js' },
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

/** A synthesized resource, as far as these tests read it. */
interface JsonResource {
	Type?: string;
	Condition?: string;
	Metadata?: Record<string, string>;
}

/** The `Resources` section of a synthesized template, copied as plain JSON for the assertions. */
function resourcesOf(template: Record<string, unknown>): Record<string, JsonResource> {
	return JSON.parse(JSON.stringify(template.Resources ?? {}));
}

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
				warnings: [],
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

	test('hooks run one at a time in package.json order; every stop is reported, warnings are printed', async () => {
		const recorder = (name: string, result: string) => `
export async function predeploy() {
  (globalThis.predeployOrder ??= []).push('${name}');
  return ${result};
}
`;
		const root = project({ '@aws-blocks/bb-z': '*', '@aws-blocks/bb-a': '*', '@aws-blocks/bb-m': '*' }, [
			{
				name: '@aws-blocks/bb-z',
				predeploy: { module: './dist/predeploy.js' },
				hook: recorder('z', "{ stops: ['z stops'] }"),
			},
			{
				name: '@aws-blocks/bb-a',
				predeploy: { module: './dist/predeploy.js' },
				hook: recorder('a', "{ warnings: ['a warns'], notes: ['a notes'] }"),
			},
			{
				name: '@aws-blocks/bb-m',
				predeploy: { module: './dist/predeploy.js' },
				hook: recorder('m', "{ stops: ['m stops'] }"),
			},
		]);
		const notes: string[] = [];
		const warnings: string[] = [];
		Reflect.set(globalThis, 'predeployOrder', []);
		await assert.rejects(
			runPredeployHooks({
				stage: 'production',
				projectRoot: root,
				synthesize: fakeSynth('App').synthesize,
				log: (l) => notes.push(l),
				warn: (l) => warnings.push(l),
			}),
			(error: Error) => {
				assert.strictEqual(error.message, '[@aws-blocks/bb-z] z stops\n\n[@aws-blocks/bb-m] m stops');
				return true;
			},
		);
		assert.deepStrictEqual(Reflect.get(globalThis, 'predeployOrder'), ['z', 'a', 'm']);
		assert.deepStrictEqual(notes, ['[@aws-blocks/bb-a] a notes']);
		assert.deepStrictEqual(warnings, ['[@aws-blocks/bb-a] a warns']);
	});

	test('a hook that throws aborts the deploy at once, with its own error', async () => {
		const root = project({ '@aws-blocks/bb-throws': '*', '@aws-blocks/bb-after': '*' }, [
			{
				name: '@aws-blocks/bb-throws',
				predeploy: { module: './dist/predeploy.js' },
				hook: "export async function predeploy() { throw new Error('guard could not run'); }\n",
			},
			{
				name: '@aws-blocks/bb-after',
				predeploy: { module: './dist/predeploy.js' },
				hook: 'export async function predeploy() { globalThis.predeployAfterRan = true; return {}; }\n',
			},
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'sandbox', projectRoot: root, synthesize: fakeSynth('App').synthesize }),
			/^Error: guard could not run$/,
		);
		assert.strictEqual(Reflect.get(globalThis, 'predeployAfterRan'), undefined);
	});

	test("with the deploy's assembly, synth() returns its stacks and the hooks get the invocation and account", async () => {
		const root = project({ '@aws-blocks/bb-reads': '*' }, [
			{
				name: '@aws-blocks/bb-reads',
				predeploy: { module: './dist/predeploy.js' },
				hook: `export async function predeploy(context) {
  globalThis.predeployContext = { ...context, stacks: await context.synth() };
  return {};
}
`,
			},
		]);
		const app = new cdk.App({ outdir: join(root, 'cdk.out') });
		new cdk.CfnResource(new cdk.Stack(app, 'Agnostic'), 'Queue', { type: 'AWS::SQS::Queue' });
		app.synth();
		const account = { id: '111111111111', plan: 'FREE' as const };
		await runPredeployHooks({
			stage: 'production',
			projectRoot: root,
			assemblyDir: 'cdk.out',
			invocation: 'npm run deploy',
			account,
			synthesize: () => assert.fail('the assembly was given; nothing is synthesized'),
		});
		const seen: unknown = Reflect.get(globalThis, 'predeployContext');
		assert.ok(seen && typeof seen === 'object');
		assert.strictEqual(Reflect.get(seen, 'invocation'), 'npm run deploy');
		assert.deepStrictEqual(Reflect.get(seen, 'account'), account);
		const [stack]: SynthesizedStack[] = Reflect.get(seen, 'stacks');
		assert.strictEqual(stack.stackName, 'Agnostic');
		assert.strictEqual(stack.account, undefined, 'an environment-agnostic stack names no account');
		assert.deepStrictEqual(Object.keys(resourcesOf(stack.template)), ['Queue']);
		assert.deepStrictEqual(stack.nestedStacks, {});
	});

	test('a missing assembly fails the deploy instead of passing the hooks an empty list', async () => {
		const root = project({ '@aws-blocks/bb-a': '*' }, [
			{ name: '@aws-blocks/bb-a', predeploy: { module: './dist/predeploy.js' }, hook: guardHook },
		]);
		await assert.rejects(
			runPredeployHooks({ stage: 'production', projectRoot: root, assemblyDir: 'cdk.out', log: () => {} }),
			/No cloud assembly at .*cdk\.out; the pre-deploy hooks could not run\./,
		);
	});
});

describe('readSynthesizedStacks', () => {
	/**
	 * Synthesize a real assembly: a parent stack with a nested stack whose own
	 * nested stack holds a queue. `assetMetadata` mirrors the CDK CLI default
	 * (`aws:asset:path` on the nested stack resources); without it, the template
	 * is found through the asset manifest.
	 */
	function synth(assetMetadata: boolean, conditional = false): string {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-predeploy-assembly-'));
		dirs.push(dir);
		const app = new cdk.App({
			outdir: dir,
			context: { 'aws:cdk:enable-path-metadata': true, 'aws:cdk:enable-asset-metadata': assetMetadata },
		});
		const parent = new cdk.Stack(app, 'Parent', { env: { account: '222222222222', region: 'eu-north-1' } });
		const child = new cdk.NestedStack(parent, 'Child');
		const grandchild = new cdk.NestedStack(child, 'Grandchild');
		new cdk.CfnResource(grandchild, 'Queue', { type: 'AWS::SQS::Queue' });
		if (conditional) {
			const resource = child.nestedStackResource;
			assert.ok(resource);
			resource.cfnOptions.condition = new cdk.CfnCondition(parent, 'CreateChild', {
				expression: cdk.Fn.conditionEquals(new cdk.CfnParameter(parent, 'WithChild').valueAsString, 'yes'),
			});
		}
		app.synth();
		return dir;
	}

	/** The only nested stack of `stack`, with the logical ID of its stack resource. */
	function onlyNested(stack: Pick<SynthesizedStack, 'nestedStacks'>) {
		const entries = Object.entries(stack.nestedStacks ?? {});
		assert.strictEqual(entries.length, 1);
		const [[logicalId, nested]] = entries;
		return { logicalId, nested };
	}

	for (const assetMetadata of [true, false]) {
		test(`reads nested stacks two levels down (asset metadata ${assetMetadata ? 'on' : 'off'})`, () => {
			const [stack] = readSynthesizedStacks(synth(assetMetadata));
			assert.strictEqual(stack.stackName, 'Parent');
			assert.strictEqual(stack.account, '222222222222');
			const child = onlyNested(stack);
			assert.ok(resourcesOf(stack.template)[child.logicalId], 'keyed by the stack resource');
			const grandchild = onlyNested(child.nested);
			assert.deepStrictEqual(
				Object.values(resourcesOf(grandchild.nested.template)).map((r) => r.Metadata?.['aws:cdk:path']),
				['Parent/Child/Grandchild/Queue'],
			);
			assert.deepStrictEqual(grandchild.nested.nestedStacks, {});
		});
	}

	test("keeps a nested stack resource's Condition in its parent's template", () => {
		const [stack] = readSynthesizedStacks(synth(true, true));
		const { logicalId } = onlyNested(stack);
		assert.strictEqual(resourcesOf(stack.template)[logicalId]?.Condition, 'CreateChild');
	});

	test('throws when the directory holds no assembly', () => {
		assert.throws(() => readSynthesizedStacks(join(tmpdir(), 'blocks-no-such-assembly')), /No cloud assembly/);
	});
});
