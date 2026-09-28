// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { OutputFormat, type BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';

/** Banner-defined identifiers the shim substitutes `import.meta.*` with (CJS only). */
const IMPORT_META_SHIM = {
  url: '__blocksImportMetaUrl',
  dirname: '__blocksImportMetaDirname',
  filename: '__blocksImportMetaFilename',
} as const;

/**
 * Wrap a `NodejsFunction` `bundling` config with the framework's hardened esbuild
 * defaults, so every Lambda the framework bundles behaves consistently.
 *
 * **What it fixes.** `NodejsFunction` bundles to **CommonJS**, where `import.meta` is
 * empty. Any bundled code that does `fileURLToPath(import.meta.url)` (a customer
 * handler, a Building Block's `aws-runtime` code, or a dependency) would otherwise
 * become `fileURLToPath(undefined)` and throw at Lambda load — esbuild only *warns*
 * (`empty-import-meta`), so the broken bundle deploys and 502s on first invocation.
 *
 * **How.** For CJS output this shims `import.meta.url` / `import.meta.dirname` /
 * `import.meta.filename` to their CommonJS equivalents (`pathToFileURL(__filename)`,
 * `__dirname`, `__filename`) via an esbuild `--define` + `banner`. This is the same
 * approach esbuild blesses (defining `import.meta` also suppresses the warning) and
 * that Rollup applies by default, so:
 * - a handler that reads `import.meta.url` no longer crashes at load, and
 * - a bundled dependency that merely *contains* `import.meta` (even in dead code) no
 *   longer trips a build failure.
 *
 * The value resolves to the **bundled output file** (esbuild flattens the module tree),
 * which is correct for the common cases — a value computed at synth (e.g. a
 * `migrationsPath`) or dead interop fallbacks — but note it does not point at your
 * source layout. Runtime code that must read a file relative to itself should not rely
 * on `import.meta.url` inside a bundle; resolve such paths at synth time or ship the
 * file as an asset. ESM output (`OutputFormat.ESM`) supports `import.meta` natively and
 * is left untouched.
 *
 * All other options (`minify`, `commandHooks`, `externalModules`, other `esbuildArgs`
 * such as `--conditions`, and any caller `banner`) are preserved.
 *
 * @param options - The site-specific `NodejsFunction` bundling options (optional).
 * @returns The same options with the CJS `import.meta` shim merged in.
 *
 * @example
 * new lambda.NodejsFunction(scope, 'Handler', {
 *   entry,
 *   bundling: blocksNodejsBundling({ minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } }),
 * });
 */
export function blocksNodejsBundling(options: BundlingOptions = {}): BundlingOptions {
  // ESM output has real `import.meta` — nothing to shim, and `require` in the banner
  // wouldn't resolve. Only the CommonJS bundle needs the shim.
  if (options.format === OutputFormat.ESM) return options;

  const shimBanner = [
    `const ${IMPORT_META_SHIM.url}=require('url').pathToFileURL(__filename).href;`,
    `const ${IMPORT_META_SHIM.dirname}=__dirname;`,
    `const ${IMPORT_META_SHIM.filename}=__filename;`,
  ].join('');

  return {
    ...options,
    // Prepend the shim definitions; keep any caller-supplied banner after them.
    banner: options.banner ? `${shimBanner}\n${options.banner}` : shimBanner,
    esbuildArgs: {
      ...options.esbuildArgs,
      // Substitute import.meta.* with the banner identifiers. Also suppresses esbuild's
      // empty-import-meta warning, so import.meta anywhere in the graph is safe.
      '--define:import.meta.url': IMPORT_META_SHIM.url,
      '--define:import.meta.dirname': IMPORT_META_SHIM.dirname,
      '--define:import.meta.filename': IMPORT_META_SHIM.filename,
    },
  };
}
