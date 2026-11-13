// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks: a step a Building Block runs before `cdk deploy`, such as a
 * deploy guard or host-side migrations. A block declares its hook in its own
 * `package.json`, so core never names a block:
 *
 *     "aws-blocks": {
 *       "hooks": { "predeploy": "./dist/predeploy.js" }
 *     }
 *
 * `hooks` maps a hook name to a module in the package, as `bin` maps a command
 * name to a file. The module exports `predeploy(context)`. The `deploy` and
 * `sandbox` scripts discover every `@aws-blocks/*` package the app depends on
 * (directly, or through `@aws-blocks/blocks`), run every declared hook, print
 * their notes, and abort the deploy when any hook returns a stop. A hook runs
 * on both stages; one that applies to a single stage reads `context.stage` and
 * returns early. A hook that needs the synthesized templates calls
 * `context.synth()`, which returns the stacks of the assembly the deploy is
 * about to deploy: the scripts synthesize the app once, run the hooks on that
 * assembly, then deploy it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log } from './log.js';
import { isPlainObject } from './native-catalogs.js';

export type DeployStage = 'sandbox' | 'production';

/** One synthesized CloudFormation stack. */
export interface SynthesizedStack {
	stackName: string;
	template: Record<string, unknown>;
}

/** What a hook receives. */
export interface PredeployContext {
	stage: DeployStage;
	/** The app's root: where `package.json` and `cdk.json` live. */
	projectRoot: string;
	/**
	 * The template of every top-level stack, from the assembly the deploy
	 * synthesized and is about to deploy. Read once and cached across hooks.
	 * The templates of CDK nested stacks are not included.
	 */
	synth(): Promise<SynthesizedStack[]>;
}

/**
 * What a hook returns. Any stop aborts the deploy; notes are printed. Every
 * hook runs before a stop aborts the deploy, so a hook must only check, or be
 * safe to run again.
 */
export interface PredeployResult {
	stops?: string[];
	notes?: string[];
}

type PredeployHook = (context: PredeployContext) => Promise<PredeployResult | undefined>;

/** A hook declared by an installed package. */
export interface PredeployHookRef {
	packageName: string;
	/** Absolute path of the module that exports `predeploy`. */
	module: string;
}

const BLOCKS_SCOPE = '@aws-blocks/';
const UMBRELLA = '@aws-blocks/blocks';
/** The one hook name this version of core runs. Any other name under `hooks` is an error. */
const HOOK = 'predeploy';

interface PackageManifest {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	'aws-blocks'?: { hooks?: unknown };
}

function readManifest(path: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as PackageManifest;
	} catch {
		return undefined;
	}
}

/**
 * Locate an installed package from `projectRoot`: its directory and its parsed
 * `package.json`. Resolves the package's entry point and walks up to its
 * `package.json`, because a package with an `exports` map does not expose
 * `<name>/package.json` to `require.resolve`.
 */
function resolvePackage(
	projectRoot: string,
	packageName: string,
): { dir: string; manifest: PackageManifest } | undefined {
	const require = createRequire(join(projectRoot, 'package.json'));
	let entry: string;
	try {
		entry = require.resolve(packageName);
	} catch {
		return undefined;
	}
	let dir = dirname(entry);
	for (;;) {
		const manifest = readManifest(join(dir, 'package.json'));
		if (manifest?.name === packageName) return { dir, manifest };
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** The `@aws-blocks/*` packages the app depends on, directly or through the umbrella. */
function candidatePackages(projectRoot: string): string[] {
	const names = new Set<string>();
	const addDeps = (manifest: PackageManifest | undefined) => {
		for (const name of Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies })) {
			if (name.startsWith(BLOCKS_SCOPE)) names.add(name);
		}
	};
	addDeps(readManifest(join(projectRoot, 'package.json')));
	if (names.has(UMBRELLA)) {
		addDeps(resolvePackage(projectRoot, UMBRELLA)?.manifest);
	}
	return [...names];
}

/**
 * Every pre-deploy hook declared by a block the app depends on. Throws when a
 * block declares `hooks` that is not an object, a hook name this version of
 * core does not run, or a hook that is not a module path: a declaration that
 * is ignored is a hook that does not run.
 */
export function discoverPredeployHooks(projectRoot: string): PredeployHookRef[] {
	const hooks: PredeployHookRef[] = [];
	for (const packageName of candidatePackages(projectRoot)) {
		const found = resolvePackage(projectRoot, packageName);
		if (!found) continue;
		const declared = found.manifest['aws-blocks']?.hooks;
		if (declared === undefined) continue;
		if (!isPlainObject(declared)) {
			throw new Error(
				`${packageName} declares "aws-blocks"."hooks" in its package.json, which is not an object. ` +
					`Set it to an object such as { "${HOOK}": "./dist/predeploy.js" }.`,
			);
		}
		const unknown = Object.keys(declared).filter((name) => name !== HOOK);
		if (unknown.length > 0) {
			throw new Error(
				`${packageName} declares a hook this version of @aws-blocks/core does not run: ${unknown.join(', ')}. ` +
					`The only hook under "aws-blocks"."hooks" in its package.json can be: ${HOOK}.`,
			);
		}
		const module = declared[HOOK];
		if (module === undefined) continue;
		if (typeof module !== 'string') {
			throw new Error(
				`${packageName} declares a pre-deploy hook that is not a module path. ` +
					`Set "aws-blocks"."hooks"."${HOOK}" in its package.json to a path such as "./dist/predeploy.js".`,
			);
		}
		hooks.push({ packageName, module: resolve(found.dir, module) });
	}
	return hooks;
}

/**
 * The stacks of the synthesized cloud assembly at `assemblyDir`, each with its
 * template. Throws when the assembly cannot be read: a hook must not pass on
 * an empty list.
 */
function readSynthesizedStacks(assemblyDir: string): SynthesizedStack[] {
	if (!existsSync(join(assemblyDir, 'manifest.json'))) {
		throw new Error(`No cloud assembly at ${assemblyDir}; the pre-deploy hooks could not run.`);
	}
	const manifest = JSON.parse(readFileSync(join(assemblyDir, 'manifest.json'), 'utf-8')) as {
		artifacts?: Record<string, { type: string; properties?: { templateFile?: string; stackName?: string } }>;
	};
	const stacks: SynthesizedStack[] = [];
	for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
		if (artifact.type !== 'aws:cloudformation:stack' || !artifact.properties?.templateFile) continue;
		stacks.push({
			stackName: artifact.properties.stackName ?? id,
			template: JSON.parse(readFileSync(join(assemblyDir, artifact.properties.templateFile), 'utf-8')),
		});
	}
	return stacks;
}

export interface RunPredeployHooksOptions {
	stage: DeployStage;
	/** The app's root: where `package.json` and `cdk.json` live. */
	projectRoot: string;
	/**
	 * The cloud assembly the deploy synthesized (`cdk synth --output`) and is
	 * about to deploy, relative to `projectRoot` unless absolute.
	 */
	assemblyDir: string;
	/** Where notes go. @default the scripts' logger (`log.progress`) */
	log?: (line: string) => void;
}

/**
 * Run every declared hook and print its notes. Throws, with every stop
 * message, when a hook stops the deploy. A hook that throws aborts the deploy
 * as well: a guard that cannot run must not be mistaken for a guard that passed.
 */
export async function runPredeployHooks(options: RunPredeployHooksOptions): Promise<void> {
	const print = options.log ?? log.progress;
	let stacks: SynthesizedStack[] | undefined;
	const context: PredeployContext = {
		stage: options.stage,
		projectRoot: options.projectRoot,
		async synth() {
			stacks ??= readSynthesizedStacks(resolve(options.projectRoot, options.assemblyDir));
			return stacks;
		},
	};

	const stops: string[] = [];
	for (const hook of discoverPredeployHooks(options.projectRoot)) {
		if (!existsSync(hook.module)) {
			throw new Error(`${hook.packageName} declares a pre-deploy hook at ${hook.module}, which does not exist.`);
		}
		const mod = (await import(pathToFileURL(hook.module).href)) as { predeploy?: PredeployHook };
		if (typeof mod.predeploy !== 'function') {
			throw new Error(`${hook.packageName}'s pre-deploy module does not export a predeploy() function.`);
		}
		const result = await mod.predeploy(context);
		for (const note of result?.notes ?? []) print(`[${hook.packageName}] ${note}`);
		stops.push(...(result?.stops ?? []).map((s) => `[${hook.packageName}] ${s}`));
	}
	if (stops.length > 0) throw new Error(stops.join('\n\n'));
}
