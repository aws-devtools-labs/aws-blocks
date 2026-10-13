// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-deploy hooks: a step a Building Block runs before `cdk deploy`, such as a
 * deploy guard or host-side migrations. A block declares its hook in its own
 * `package.json`, so core never names a block:
 *
 *     "aws-blocks": {
 *       "predeploy": { "module": "./dist/predeploy.js", "stages": ["production"] }
 *     }
 *
 * The module exports `predeploy(context)`. The `deploy` and `sandbox` scripts
 * discover every `@aws-blocks/*` package the app depends on (directly, or
 * through `@aws-blocks/blocks`), run the hooks declared for the stage, print
 * their notes, and abort the deploy when any hook returns a stop. A hook that
 * needs the synthesized templates calls `context.synth()`; the app is
 * synthesized at most once per deploy, however many hooks ask.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';

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
	/** Synthesize the app and return every stack's template. Cached across hooks. */
	synth(): Promise<SynthesizedStack[]>;
}

/** What a hook returns. Any stop aborts the deploy; notes are printed. */
export interface PredeployResult {
	stops?: string[];
	notes?: string[];
}

export type PredeployHook = (context: PredeployContext) => Promise<PredeployResult | undefined>;

/** A hook declared by an installed package. */
export interface PredeployHookRef {
	packageName: string;
	/** Absolute path of the module that exports `predeploy`. */
	module: string;
	stages: DeployStage[];
}

const BLOCKS_SCOPE = '@aws-blocks/';
const UMBRELLA = '@aws-blocks/blocks';
const ALL_STAGES: DeployStage[] = ['sandbox', 'production'];

interface PackageManifest {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	'aws-blocks'?: { predeploy?: { module?: string; stages?: string[] } };
}

function readManifest(path: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as PackageManifest;
	} catch {
		return undefined;
	}
}

/**
 * Locate an installed package's directory from `projectRoot`. Resolves the
 * package's entry point and walks up to its `package.json`, because a package
 * with an `exports` map does not expose `<name>/package.json` to `require.resolve`.
 */
export function resolvePackageDir(projectRoot: string, packageName: string): string | undefined {
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
		if (manifest?.name === packageName) return dir;
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
		const umbrellaDir = resolvePackageDir(projectRoot, UMBRELLA);
		if (umbrellaDir) addDeps(readManifest(join(umbrellaDir, 'package.json')));
	}
	return [...names];
}

/** Every pre-deploy hook declared by a block the app depends on. */
export function discoverPredeployHooks(projectRoot: string): PredeployHookRef[] {
	const hooks: PredeployHookRef[] = [];
	for (const packageName of candidatePackages(projectRoot)) {
		const dir = resolvePackageDir(projectRoot, packageName);
		if (!dir) continue;
		const declared = readManifest(join(dir, 'package.json'))?.['aws-blocks']?.predeploy;
		if (!declared?.module) continue;
		const stages = (declared.stages ?? ALL_STAGES).filter((s): s is DeployStage =>
			ALL_STAGES.includes(s as DeployStage),
		);
		hooks.push({ packageName, module: resolve(dir, declared.module), stages });
	}
	return hooks;
}

export interface SynthesizeOptions {
	projectRoot: string;
	stage: DeployStage;
	/** The `cdk --app` command when the deploy passes one explicitly (the sandbox does). */
	app?: string;
}

/**
 * Synthesize the app into a temporary directory with the same context the
 * deploy will use, and return every stack's template. Call `cleanup()` when done.
 */
export function synthesizeApp(options: SynthesizeOptions): { stacks: SynthesizedStack[]; cleanup: () => void } {
	const out = mkdtempSync(join(tmpdir(), 'blocks-synth-'));
	const cleanup = () => rmSync(out, { recursive: true, force: true });
	const args = ['cdk', 'synth', '--quiet', '--output', out, '--context', `projectRoot=${options.projectRoot}`];
	if (options.stage === 'sandbox') args.push('--context', 'sandboxMode=true');
	if (options.app) args.push('--app', options.app);
	const result = spawn.sync('npx', args, {
		cwd: options.projectRoot,
		stdio: ['ignore', 'ignore', 'inherit'],
		env: { ...process.env, NODE_OPTIONS: '--conditions=cdk', ...getCdkTelemetryEnv(options.stage) },
	});
	if (result.error || result.status !== 0) {
		cleanup();
		throw new Error(
			`cdk synth failed (${result.error?.message ?? `exit ${result.status}`}); the pre-deploy hooks could not run.`,
		);
	}
	const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8')) as {
		artifacts?: Record<string, { type: string; properties?: { templateFile?: string; stackName?: string } }>;
	};
	const stacks: SynthesizedStack[] = [];
	for (const [id, artifact] of Object.entries(manifest.artifacts ?? {})) {
		if (artifact.type !== 'aws:cloudformation:stack' || !artifact.properties?.templateFile) continue;
		stacks.push({
			stackName: artifact.properties.stackName ?? id,
			template: JSON.parse(readFileSync(join(out, artifact.properties.templateFile), 'utf-8')),
		});
	}
	return { stacks, cleanup };
}

export interface RunPredeployHooksOptions extends SynthesizeOptions {
	/** Replaces `synthesizeApp` (tests). */
	synthesize?: (options: SynthesizeOptions) => { stacks: SynthesizedStack[]; cleanup: () => void };
	/** Where notes go. @default console.log */
	log?: (line: string) => void;
}

export interface RunPredeployHooksResult {
	/** Packages whose hook ran for this stage. */
	ran: string[];
	notes: string[];
}

/**
 * Run every hook declared for the stage. Throws, with every stop message, when
 * a hook stops the deploy. A hook that throws aborts the deploy as well: a
 * guard that cannot run must not be mistaken for a guard that passed.
 */
export async function runPredeployHooks(options: RunPredeployHooksOptions): Promise<RunPredeployHooksResult> {
	const log = options.log ?? ((line: string) => console.log(line));
	const hooks = discoverPredeployHooks(options.projectRoot).filter((h) => h.stages.includes(options.stage));
	if (hooks.length === 0) return { ran: [], notes: [] };

	let synthesized: { stacks: SynthesizedStack[]; cleanup: () => void } | undefined;
	const context: PredeployContext = {
		stage: options.stage,
		projectRoot: options.projectRoot,
		async synth() {
			synthesized ??= (options.synthesize ?? synthesizeApp)(options);
			return synthesized.stacks;
		},
	};

	const stops: string[] = [];
	const notes: string[] = [];
	try {
		for (const hook of hooks) {
			if (!existsSync(hook.module)) {
				throw new Error(
					`${hook.packageName} declares a pre-deploy hook at ${hook.module}, which does not exist.`,
				);
			}
			const mod = (await import(pathToFileURL(hook.module).href)) as { predeploy?: PredeployHook };
			if (typeof mod.predeploy !== 'function') {
				throw new Error(`${hook.packageName}'s pre-deploy module does not export a predeploy() function.`);
			}
			const result = (await mod.predeploy(context)) ?? {};
			for (const note of result.notes ?? []) {
				notes.push(note);
				log(`[${hook.packageName}] ${note}`);
			}
			stops.push(...(result.stops ?? []).map((s) => `[${hook.packageName}] ${s}`));
		}
	} finally {
		synthesized?.cleanup();
	}
	if (stops.length > 0) throw new Error(stops.join('\n\n'));
	return { ran: hooks.map((h) => h.packageName), notes };
}
