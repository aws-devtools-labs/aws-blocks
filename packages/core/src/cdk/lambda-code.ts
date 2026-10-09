// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Locating a Building Block's own deploy-time Lambda handlers (custom-resource
 * handlers, migration runners, …) in both layouts a block's CDK code runs from:
 *
 * - **Installed** (`node_modules/@aws-blocks/bb-x/dist/…`): the package's build
 *   output is there — a pre-built `build:lambda` bundle, or the tsc-compiled
 *   `.js` handler.
 * - **Vendorized** (`vendor/bb-x/src/…`, made by `blocks-vendorize`): only `src/`
 *   is copied and the exports point at the `.ts` sources, so there is no build
 *   output at all — only the handler's TypeScript source.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DEFAULT_NODE_RUNTIME } from './node-version.js';

/**
 * Where one deploy-time Lambda lives, relative to the module that creates it.
 * Paths are relative to that module in **both** layouts (`dist/` installed,
 * `src/` vendorized), which holds as long as the bundle and the source keep the
 * same position relative to it.
 */
export interface DeployTimeLambda {
	/** `import.meta.url` of the module that creates the Lambda. */
	moduleUrl: string;
	/**
	 * The `build:lambda` output directory (holding `index.js`), relative to that
	 * module — e.g. `'./gsi-manager-lambda'` for `dist/gsi-manager-lambda/`.
	 */
	bundleDir: string;
	/**
	 * The handler's TypeScript source relative to that module, **without**
	 * extension — e.g. `'./gsi-manager-lambda'` for `src/gsi-manager-lambda.ts`.
	 */
	source: string;
	/**
	 * esbuild `target` for bundling the source at synth — keep it equal to the
	 * package's `build:lambda` target.
	 * @default the target of `DEFAULT_NODE_RUNTIME` (e.g. `'node24'`)
	 */
	target?: string;
	/**
	 * Modules left out of the synth-time bundle — keep equal to `build:lambda`'s `--external`.
	 * @default ['@aws-sdk/*'] (provided by the Lambda Node.js runtime)
	 */
	external?: string[];
}

/** The slice of esbuild's API used here (esbuild is the app's, resolved at synth). */
interface Esbuild {
	buildSync(options: {
		entryPoints: string[];
		outfile: string;
		bundle: boolean;
		platform: 'node';
		target: string;
		format: 'cjs';
		external: string[];
		absWorkingDir: string;
		logLevel: 'warning';
	}): unknown;
}

/**
 * The `lambda.Code` for a Building Block's pre-bundled deploy-time Lambda, which
 * works both when the block is installed and when it is vendorized.
 *
 * Resolution order:
 * 1. **Pre-built bundle** — `<bundleDir>/index.js` exists (an installed package):
 *    `Code.fromAsset(bundleDir)`, exactly as a hand-written `fromAsset` would, so
 *    an installed app's asset (and its hash) is unchanged.
 * 2. **Vendorized source** — no bundle, but `<source>.ts` exists (a copy made by
 *    `blocks-vendorize`, which copies `src/` only): the source is bundled at
 *    synth through CDK local asset bundling (output in `cdk.out`, like
 *    `NodejsFunction`) — CommonJS, Node platform, `target`, `external`, the same
 *    options `build:lambda` uses. Edits to the vendorized handler therefore
 *    deploy.
 * 3. **Neither** — throws an error naming the missing bundle and how to restore it.
 *
 * **esbuild comes from the app.** Step 2 resolves `esbuild` from the vendorized
 * package's location, i.e. from the app's `node_modules`. Every AWS Blocks app
 * already has it (the default compute bundles the app's handler with
 * `NodejsFunction`); when it is missing, synth fails with the install command.
 *
 * @param spec - Where the bundle and the source live, relative to the calling module.
 * @returns The Lambda code to pass as `code` to a `lambda.Function`.
 * @throws Error when neither the bundle nor the source exists, or when the source
 *   must be bundled and esbuild is not installed.
 *
 * @example
 * // src/index.cdk.ts, with `build:lambda` writing dist/gsi-manager-lambda/index.js
 * new lambda.Function(stack, 'GsiManager', {
 *   runtime: DEFAULT_NODE_RUNTIME,
 *   handler: 'index.handler',
 *   code: deployTimeLambdaCode({
 *     moduleUrl: import.meta.url,
 *     bundleDir: './gsi-manager-lambda',
 *     source: './gsi-manager-lambda',
 *   }),
 * });
 */
export function deployTimeLambdaCode(spec: DeployTimeLambda): lambda.Code {
	const here = dirname(fileURLToPath(spec.moduleUrl));
	const bundleDir = resolve(here, spec.bundleDir);
	if (existsSync(join(bundleDir, 'index.js'))) return lambda.Code.fromAsset(bundleDir);

	const entry = resolve(here, `${spec.source}.ts`);
	if (!existsSync(entry)) {
		const pkg = findPackage(here);
		throw new Error(
			`The deploy-time Lambda bundle of ${pkg.name} is missing (expected ${join(bundleDir, 'index.js')}). ` +
				`Reinstall ${pkg.name}; when building it from source, run \`npm run build:lambda\` in its package.`,
		);
	}
	const esbuild = loadEsbuild(spec.moduleUrl, entry);
	const packageRoot = findPackage(entry).root;
	const target = spec.target ?? defaultTarget();
	const external = spec.external ?? ['@aws-sdk/*'];
	return lambda.Code.fromAsset(dirname(entry), {
		bundling: {
			// Never used: local bundling either succeeds or throws. CDK requires an image.
			image: cdk.DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22'),
			local: {
				tryBundle(outputDir: string): boolean {
					esbuild.buildSync({
						entryPoints: [entry],
						outfile: join(outputDir, 'index.js'),
						bundle: true,
						platform: 'node',
						target,
						format: 'cjs',
						external,
						absWorkingDir: packageRoot,
						logLevel: 'warning',
					});
					return true;
				},
			},
		},
	});
}

/**
 * The entry file for a `NodejsFunction` whose handler ships as a compiled module
 * next to the calling module: `<source>.js` when the block is installed (tsc
 * output in `dist/`), `<source>.ts` when it is vendorized (`blocks-vendorize`
 * copies `src/` only). `NodejsFunction` bundles either at synth, so an installed
 * app's entry — and its asset — is unchanged.
 *
 * @param moduleUrl - `import.meta.url` of the module that creates the function.
 * @param source - The handler path relative to that module, **without** extension
 *   (e.g. `'./migration-lambda'`).
 * @returns The absolute path of the entry file that exists.
 * @throws Error when neither file exists.
 *
 * @example
 * new lambda.NodejsFunction(scope, 'MigrationFn', {
 *   entry: deployTimeLambdaEntry(import.meta.url, './migration-lambda'),
 *   handler: 'handler',
 *   bundling: blocksNodejsBundling(),
 * });
 */
export function deployTimeLambdaEntry(moduleUrl: string, source: string): string {
	const here = dirname(fileURLToPath(moduleUrl));
	for (const ext of ['.js', '.ts']) {
		const entry = resolve(here, `${source}${ext}`);
		if (existsSync(entry)) return entry;
	}
	const pkg = findPackage(here);
	throw new Error(
		`The deploy-time Lambda handler of ${pkg.name} is missing (expected ${resolve(here, `${source}.js`)} ` +
			`or, in a vendorized copy, ${resolve(here, `${source}.ts`)}). Reinstall ${pkg.name}, or re-vendorize it.`,
	);
}

/** `'node24'` for `nodejs24.x`. */
function defaultTarget(): string {
	return DEFAULT_NODE_RUNTIME.name.replace(/^nodejs(\d+)\.x$/, 'node$1');
}

function loadEsbuild(moduleUrl: string, entry: string): Esbuild {
	try {
		const esbuild: Esbuild = createRequire(moduleUrl)('esbuild');
		return esbuild;
	} catch {
		throw new Error(
			`Bundling the vendorized deploy-time Lambda ${entry} needs esbuild, which is not installed. ` +
				'Add it to the app: `npm install --save-dev esbuild`.',
		);
	}
}

/** The nearest enclosing package (its root keeps esbuild's path comments package-relative). */
function findPackage(from: string): { root: string; name: string } {
	let dir = from;
	while (dir !== dirname(dir)) {
		const manifest = join(dir, 'package.json');
		if (existsSync(manifest)) {
			const name: unknown = JSON.parse(readFileSync(manifest, 'utf8')).name;
			return { root: dir, name: typeof name === 'string' ? name : dir };
		}
		dir = dirname(dir);
	}
	return { root: from, name: from };
}
