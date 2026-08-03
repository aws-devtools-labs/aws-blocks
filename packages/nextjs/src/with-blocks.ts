// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { NextConfig } from 'next';
import { BLOCKS_SERVER_EXTERNAL_PACKAGES } from './external-packages.js';
import { type SchemaSyncOptions, startSchemaSync } from './schema-watch.js';

/**
 * True only under `next dev`. Next sets `NEXT_PHASE` when it loads the config; fall
 * back to NODE_ENV for older versions, which is `production` during `next build`.
 */
function isDevServer(): boolean {
	const phase = process.env.NEXT_PHASE;
	if (phase) return phase === 'phase-development-server';
	return process.env.NODE_ENV !== 'production';
}

/** Options for {@link withBlocks}. */
export interface WithBlocksOptions {
	/**
	 * Additional packages to keep out of the server bundle, merged with the Blocks
	 * defaults. Use this for your own dependencies that load native or WASM assets.
	 *
	 * @example
	 * ```ts
	 * export default withBlocks({}, { serverExternalPackages: ['my-native-dep'] });
	 * ```
	 */
	serverExternalPackages?: string[];

	/**
	 * Keep generated schema types in step with your SQL migrations during `next dev`.
	 * Enabled by default when a `./migrations` directory exists; pass `false` to turn
	 * it off, or an object to change the paths.
	 */
	schema?: SchemaSyncOptions | false;
}

/**
 * Wraps a Next.js config so AWS Blocks work in server code.
 *
 * Blocks are used directly wherever server code runs — Server Components, Server
 * Actions, and route handlers all resolve the real block and call it in process,
 * with no RPC hop and no wrapper method. Client Components must not import a module
 * that constructs blocks; mark that module `server-only` so a mistake is a build
 * error rather than an AWS SDK in your browser bundle.
 *
 * What this currently does: keeps blocks that load WASM or native assets out of the
 * server bundle. Bundlers rewrite the `new URL(..., import.meta.url)` expression
 * those packages use to find their assets, which breaks them at runtime — the
 * failure is identical under Turbopack and webpack.
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { withBlocks } from '@aws-blocks/nextjs';
 *
 * export default withBlocks({ output: 'standalone' });
 * ```
 *
 * @param config - Your Next.js config. Every key is preserved;
 * `serverExternalPackages` is merged rather than replaced.
 * @param options - See {@link WithBlocksOptions}.
 * @returns The config with Blocks' requirements applied.
 */
export function withBlocks(config: NextConfig = {}, options: WithBlocksOptions = {}): NextConfig {
	// Dev only: `next build` should compile the committed generated files, not
	// regenerate them, so a build never depends on spinning up a database.
	if (options.schema !== false && isDevServer()) {
		startSchemaSync(options.schema ?? {});
	}

	// Preserve the caller's entries and their order, then append whatever Blocks
	// needs that isn't already listed. Replacing the array would silently drop a
	// user's own native dependency.
	const merged = [
		...(config.serverExternalPackages ?? []),
		...(options.serverExternalPackages ?? []),
		...BLOCKS_SERVER_EXTERNAL_PACKAGES,
	];

	return {
		...config,
		serverExternalPackages: [...new Set(merged)],
	};
}
