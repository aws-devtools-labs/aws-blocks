#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CLI wrapper for `writeSpec()`. Generates `aws-blocks/blocks.spec.json` from a
 * backend entry point. Exposed as the `blocks-generate-spec` bin entry on
 * `@aws-blocks/core`, so any Blocks app can invoke it via
 * `npx blocks-generate-spec`.
 *
 * Usage:
 *   node dist/scripts/generate-spec-cli.js [backendPath] [outputPath]
 *
 * Defaults:
 *   backendPath = ./aws-blocks/index.ts
 *   outputPath  = ./aws-blocks/blocks.spec.json
 *
 * For a TypeScript backend entry, this CLI lazily loads `tsx` and uses
 * its programmatic `tsImport` so no extra build step is needed. JS entries
 * use plain `import()` and don't pull tsx in.
 *
 * The spec emitter loads the TypeScript compiler (~1.5s of cold-start), which
 * is why this lives in its own CLI rather than being wired into `npm run dev`.
 * See docs/native-clients/codegen-design.md § Build pipeline.
 */

import { resolve, dirname, join } from 'node:path';
import { writeSpec, type FoundationLoader } from './generate-spec.js';
import { log } from './log.js';
import { readNativeDeclarations } from './read-native-declarations.js';

/** Pick a loader based on the file extension. `.ts` / `.tsx` use tsx; everything else uses Node's native `import()`. */
async function selectLoader(foundationPath: string): Promise<FoundationLoader | undefined> {
	if (!/\.(ts|tsx|mts|cts)$/i.test(foundationPath)) {
		// JS entry point — let the default `import()` handle it.
		return undefined;
	}

	let tsImport: ((specifier: string, parentURL: string) => Promise<unknown>) | undefined;
	try {
		// `tsx/esm/api` is a peer-style helper. We require the consuming app to
		// have it installed (via the template's devDependencies) rather than
		// bundling it into @aws-blocks/core, so the runtime Lambda path stays
		// JS-only. If it's missing, fall through to the helpful error below.
		const mod = await import('tsx/esm/api');
		tsImport = (mod as { tsImport?: typeof tsImport }).tsImport;
	} catch {
		throw new Error(
			[
				`Cannot load TypeScript entry "${foundationPath}" — \`tsx\` is not installed.`,
				`Install it as a devDependency:`,
				`    npm install -D tsx`,
				`Or pass a pre-built JavaScript entry instead.`,
			].join('\n'),
		);
	}

	if (!tsImport) {
		throw new Error(
			`The installed version of tsx does not export \`tsImport\` from \`tsx/esm/api\`. Upgrade to tsx ≥ 4.7.`,
		);
	}

	// `tsImport` needs a `parentURL` so it can resolve relative imports inside
	// the TS file. `import.meta.url` of *this* CLI works because the entry
	// path we pass is absolute — the parentURL only seeds the registry.
	const parentURL = import.meta.url;
	return (fileUrl) => tsImport!(fileUrl, parentURL) as Promise<Record<string, unknown>>;
}

async function main() {
	const [, , backendArg, outputArg] = process.argv;

	const backendPath = resolve(backendArg ?? './aws-blocks/index.ts');
	const outputPath = resolve(
		outputArg ?? join(dirname(backendPath), 'blocks.spec.json')
	);

	// Progress goes through the scripts' logger, so `BLOCKS_LOG_STREAM=stderr`
	// moves it off stdout; the `✅` result line stays on stdout.
	log.progress('📝 Generating OpenRPC spec...');
	log.detail('   backend:', backendPath);
	log.detail('   output: ', outputPath);

	try {
		const loader = await selectLoader(backendPath);
		const nativeDeclarations = readNativeDeclarations(backendPath);
		// Named because any installed package can declare a binding, and the
		// generated native clients import whatever package it names. Sorted so
		// the line is diffable between runs rather than readdir-ordered.
		if (nativeDeclarations.length > 0) {
			const declarers = nativeDeclarations.map((source) => source.sourcePackage).sort();
			log.detail('   native declarations:', declarers.join(', '));
		}
		await writeSpec(backendPath, outputPath, loader, { nativeDeclarations });
		console.log('✅ OpenRPC spec written to', outputPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('❌ Spec generation failed:', message);
		process.exit(1);
	}
}

main();
