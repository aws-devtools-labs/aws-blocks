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
 * through `@aws-blocks/blocks`), run the hooks declared for the stage, print their
 * notes and warnings, and abort the deploy when any hook returns a stop or
 * throws. A hook that needs the synthesized templates calls `context.synth()`;
 * the app is synthesized at most once per deploy, however many hooks ask. The
 * `deploy` and `sandbox` scripts run the hooks after their own synth, so
 * `context.synth()` returns the stacks of the assembly they are about to deploy.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import spawn from 'cross-spawn';
import type { AccountPlanType } from './account-metadata.js';
import { getCdkTelemetryEnv } from './cdk-telemetry-env.js';
import {
	type NestedStackTemplateReader,
	nestedStackTemplateReader,
	type StackTemplate,
	stackTemplates,
} from './cloud-assembly.js';
import { log as scriptsLog } from './log.js';

export type DeployStage = 'sandbox' | 'production';

/** A CDK `NestedStack` of a synthesized stack, with its template read from the cloud assembly. */
export interface SynthesizedNestedStack {
	template: Record<string, unknown>;
	/** This nested stack's own nested stacks, by the logical ID of their `AWS::CloudFormation::Stack` resource in `template`. */
	nestedStacks: Record<string, SynthesizedNestedStack>;
}

/** One synthesized CloudFormation stack. */
export interface SynthesizedStack {
	stackName: string;
	template: Record<string, unknown>;
	/**
	 * The account the stack names in its environment (`env.account`), which CDK
	 * deploys to through that account's bootstrap roles. Unset for an
	 * environment-agnostic stack, which deploys to the credentials' own account.
	 */
	account?: string;
	/**
	 * The CDK nested stacks whose templates are in the assembly, by the logical ID
	 * of their `AWS::CloudFormation::Stack` resource in `template`. A nested stack
	 * deploys in its parent's account.
	 */
	nestedStacks?: Record<string, SynthesizedNestedStack>;
}

/** The AWS account the deploy's credential check verified before the hooks run. */
export interface PredeployAccount {
	/** The account ID STS returned; `null` when it was not verified. */
	id: string | null;
	/** The account's plan; `null` when it was not read or is unavailable. */
	plan: AccountPlanType | null;
}

/** What a hook receives. */
export interface PredeployContext {
	stage: DeployStage;
	/** The app's root: where `package.json` and `cdk.json` live. */
	projectRoot: string;
	/**
	 * Synthesize the app and return every stack's template. Cached across hooks.
	 * In `deploy` and `sandbox` these are the stacks of the assembly they are
	 * about to deploy, synthesized once before the hooks run.
	 */
	synth(): Promise<SynthesizedStack[]>;
	/** How the user ran the deploy, for messages (for example `npm run deploy`). Set by `deploy` and `sandbox`. */
	invocation?: string;
	/** The account the credential check verified, and its plan. Set by `deploy` and `sandbox`. */
	account?: PredeployAccount;
}

/** What a hook returns. Any stop aborts the deploy; notes and warnings are printed. */
export interface PredeployResult {
	stops?: string[];
	notes?: string[];
	/** Printed as warnings (stderr; hidden at `BLOCKS_LOG_LEVEL=quiet`). The deploy continues. */
	warnings?: string[];
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

/**
 * Every pre-deploy hook declared by a package the app depends on, in the order
 * the packages are found (see {@link candidatePackages}); the hooks run in this
 * order. A declaration without `stages` runs in every stage.
 */
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

/** The nested stacks of `template` whose templates are in the assembly, recursively; a template already on `seen` is skipped. */
function readNestedStacks(
	template: StackTemplate,
	read: NestedStackTemplateReader,
	seen: ReadonlySet<string>,
): Record<string, SynthesizedNestedStack> {
	const nested: Record<string, SynthesizedNestedStack> = {};
	for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
		const found = read(resource);
		// A malformed assembly that names a template inside itself must not recurse forever.
		if (!found || seen.has(found.file)) continue;
		nested[logicalId] = {
			template: found.template,
			nestedStacks: readNestedStacks(found.template, read, new Set([...seen, found.file])),
		};
	}
	return nested;
}

/**
 * The stacks of the synthesized cloud assembly at `assemblyDir`: every
 * top-level stack with its template and target account, and the templates of
 * its CDK nested stacks. A stack whose template is missing or unreadable is
 * left out.
 *
 * @throws {Error} When the directory holds no cloud assembly: a guard that cannot see the templates must not pass.
 */
export function readSynthesizedStacks(assemblyDir: string): SynthesizedStack[] {
	if (!existsSync(join(assemblyDir, 'manifest.json'))) {
		throw new Error(`No cloud assembly at ${assemblyDir}; the pre-deploy hooks could not run.`);
	}
	const read = nestedStackTemplateReader(assemblyDir);
	return stackTemplates(assemblyDir).map(({ stack, account, template }) => ({
		stackName: stack.stackName,
		template,
		...(account ? { account } : {}),
		nestedStacks: readNestedStacks(template, read, new Set()),
	}));
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
	try {
		return { stacks: readSynthesizedStacks(out), cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

export interface RunPredeployHooksOptions extends SynthesizeOptions {
	/**
	 * The cloud assembly the deploy already synthesized (`cdk synth --output`),
	 * absolute or relative to `projectRoot`. When set, `context.synth()` returns
	 * its stacks instead of synthesizing the app again, so the hooks see exactly
	 * what is about to be deployed.
	 */
	assemblyDir?: string;
	/** Passed to the hooks as {@link PredeployContext.invocation}. */
	invocation?: string;
	/** Passed to the hooks as {@link PredeployContext.account}. */
	account?: PredeployAccount;
	/** Replaces `synthesizeApp` (tests). Ignored when `assemblyDir` is set. */
	synthesize?: (options: SynthesizeOptions) => { stacks: SynthesizedStack[]; cleanup: () => void };
	/** Where notes go. @default console.log */
	log?: (line: string) => void;
	/** Where warnings go. @default the scripts' `log.warn` (stderr, hidden at `BLOCKS_LOG_LEVEL=quiet`) */
	warn?: (line: string) => void;
}

export interface RunPredeployHooksResult {
	/** Packages whose hook ran for this stage. */
	ran: string[];
	notes: string[];
	warnings: string[];
}

/**
 * Run every hook declared for the stage, one at a time, in discovery order (see
 * {@link discoverPredeployHooks}). Throws, with every stop message, when a hook
 * stops the deploy; the remaining hooks still run first, so one deploy reports
 * every stop. A hook that throws aborts the deploy at once: a guard that cannot
 * run must not be mistaken for a guard that passed.
 */
export async function runPredeployHooks(options: RunPredeployHooksOptions): Promise<RunPredeployHooksResult> {
	const log = options.log ?? ((line: string) => console.log(line));
	const warn = options.warn ?? ((line: string) => scriptsLog.warn(line));
	const hooks = discoverPredeployHooks(options.projectRoot).filter((h) => h.stages.includes(options.stage));
	if (hooks.length === 0) return { ran: [], notes: [], warnings: [] };

	const { assemblyDir } = options;
	const synthesize =
		assemblyDir === undefined
			? (options.synthesize ?? synthesizeApp)
			: () => ({ stacks: readSynthesizedStacks(resolve(options.projectRoot, assemblyDir)), cleanup: () => {} });
	let synthesized: { stacks: SynthesizedStack[]; cleanup: () => void } | undefined;
	const context: PredeployContext = {
		stage: options.stage,
		projectRoot: options.projectRoot,
		async synth() {
			synthesized ??= synthesize(options);
			return synthesized.stacks;
		},
		...(options.invocation !== undefined ? { invocation: options.invocation } : {}),
		...(options.account ? { account: options.account } : {}),
	};

	const stops: string[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	try {
		for (const hook of hooks) {
			if (!existsSync(hook.module)) {
				throw new Error(
					`${hook.packageName} declares a pre-deploy hook at ${hook.module}, which does not exist.`,
				);
			}
			// The module path comes from the package's manifest, so it is known only at run time.
			const mod = (await import(pathToFileURL(hook.module).href)) as { predeploy?: PredeployHook };
			if (typeof mod.predeploy !== 'function') {
				throw new Error(`${hook.packageName}'s pre-deploy module does not export a predeploy() function.`);
			}
			const result = (await mod.predeploy(context)) ?? {};
			for (const note of result.notes ?? []) {
				notes.push(note);
				log(`[${hook.packageName}] ${note}`);
			}
			for (const warning of result.warnings ?? []) {
				warnings.push(warning);
				warn(`[${hook.packageName}] ${warning}`);
			}
			stops.push(...(result.stops ?? []).map((s) => `[${hook.packageName}] ${s}`));
		}
	} finally {
		synthesized?.cleanup();
	}
	if (stops.length > 0) throw new Error(stops.join('\n\n'));
	return { ran: hooks.map((h) => h.packageName), notes, warnings };
}
