// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Load a Blocks backend entry module (`aws-blocks/index.ts`) regardless of the
 * host process's loader state.
 *
 * A bare `await import('…/index.ts')` only resolves a `.ts` file when the
 * CURRENT process has tsx's ESM loader hooks registered. That holds for the
 * in-process `blocks dev` path, but NOT for the sandbox dev server, which is a
 * separate `npx tsx watch server.ts` subprocess spawned with `NODE_OPTIONS=''`:
 * on Node 20 `tsx watch` registers its hooks for the ENTRY module, but a
 * runtime dynamic `import()` of a *different* `.ts` file (the backend
 * `index.ts`, imported by `startDevServer`) is handled by Node's native loader
 * and throws `Unknown file extension ".ts"`.
 *
 * Using `tsx/esm/api`'s `tsImport()` for a TypeScript entry sidesteps that: it
 * transpiles and loads the module through tsx's API explicitly, so it works
 * whether or not the process registered the global loader. This is the same
 * approach `generate-spec-cli.ts` already uses for the spec path. A `.js`/`.mjs`
 * entry takes the native `import()` so the loader is never pulled in needlessly.
 */

const TS_ENTRY = /\.(ts|tsx|mts|cts)$/i;

/**
 * Dynamically import a backend entry by file URL. For a TypeScript entry this
 * routes through `tsx/esm/api`; for a JS entry it uses the native `import()`.
 *
 * @param fileUrl - a `file://` URL to the entry (what `pathToFileURL` returns).
 * @param parentURL - seeds tsx's resolver for relative imports inside the entry;
 *   `import.meta.url` of the caller is fine because `fileUrl` is absolute.
 */
export async function importBackend(
	fileUrl: string,
	parentURL: string,
): Promise<Record<string, unknown>> {
	if (!TS_ENTRY.test(fileUrl)) {
		// JS entry — let Node resolve it; no need to pull tsx in.
		return (await import(fileUrl)) as Record<string, unknown>;
	}

	let tsImport:
		| ((specifier: string, parentURL: string) => Promise<unknown>)
		| undefined;
	try {
		const mod = await import('tsx/esm/api');
		tsImport = (mod as { tsImport?: typeof tsImport }).tsImport;
	} catch {
		throw new Error(
			[
				`Cannot load TypeScript backend "${fileUrl}" — \`tsx\` is not installed.`,
				`Install it as a devDependency:`,
				`    npm install -D tsx`,
			].join('\n'),
		);
	}
	if (!tsImport) {
		throw new Error(
			`The installed version of tsx does not export \`tsImport\` from \`tsx/esm/api\`. Upgrade to tsx >= 4.7.`,
		);
	}
	return (await tsImport(fileUrl, parentURL)) as Record<string, unknown>;
}
