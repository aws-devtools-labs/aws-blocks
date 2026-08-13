// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';

/**
 * Wrap a `NodejsFunction` `bundling` config with the framework's hardened esbuild
 * defaults, so every Lambda the framework bundles is protected uniformly.
 *
 * Today it guards one class of bug: `NodejsFunction` bundles to **CommonJS**, where
 * `import.meta` is empty. Any bundled code that does `fileURLToPath(import.meta.url)`
 * (a customer handler, a Building Block's `aws-runtime` code, or a dependency) becomes
 * `fileURLToPath(undefined)` and throws at Lambda load. esbuild only *warns* about this
 * (`empty-import-meta`), so a broken bundle deploys and fails on first invocation. This
 * promotes that warning to an esbuild **error**, so `cdk synth` fails loudly at build
 * time and points at the exact offending file and line.
 *
 * The `empty-import-meta` override is applied last so it always wins — a caller cannot
 * accidentally relax the guard by passing its own `--log-override`. All other options
 * (`minify`, `commandHooks`, `externalModules`, other `esbuildArgs` such as
 * `--conditions`) are preserved as given.
 *
 * @param options - The site-specific `NodejsFunction` bundling options (optional).
 * @returns The same options with the hardened esbuild args merged in.
 *
 * @example
 * new lambda.NodejsFunction(scope, 'Handler', {
 *   entry,
 *   bundling: blocksNodejsBundling({ minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } }),
 * });
 */
export function blocksNodejsBundling(options: BundlingOptions = {}): BundlingOptions {
  return {
    ...options,
    esbuildArgs: {
      ...options.esbuildArgs,
      // Applied last so the guard can't be relaxed by a caller-supplied --log-override.
      '--log-override': 'empty-import-meta=error',
    },
  };
}
