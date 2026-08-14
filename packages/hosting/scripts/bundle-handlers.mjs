// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pre-bundle the Lambda handlers that ship inside @aws-blocks/hosting into
// self-contained `.mjs` files at BUILD time, so the runtime construct can use a
// plain `Code.fromAsset(...)` (no `NodejsFunction`, no `projectRoot` /
// `depsLockFilePath` discovery).
//
// Why: `NodejsFunction` re-bundles `entry` at SYNTH time and requires `entry`
// to sit under a `projectRoot` that also has a lockfile. That only holds inside
// this monorepo — once @aws-blocks/hosting is installed from npm the handler
// lives under the consumer's `node_modules/`, `projectRoot` resolves into
// `node_modules/` (no package-lock there), and synth fails with PathNotUnderRoot.
// Bundling here removes that dependency entirely: the consumer ships a ready
// asset and CDK just zips it.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, '..');

// Each entry → one bundled handler under dist/. `@aws-sdk/signature-v4a` is a
// side-effect import the kvs client needs (region-agnostic SigV4a); esbuild
// would tree-shake it without the explicit `import` in the source, which is
// why the handler keeps that import.
const handlers = [
  {
    entry: join(pkgRoot, 'src', 'constructs', 'kv_keys_handler.ts'),
    // Dotless basename: Lambda parses the `handler` string by splitting on the
    // FIRST dot (file.export), so a dotted filename like `x.bundle.mjs` would be
    // read as file `x`, export `bundle.handler` → "Cannot find module".
    outfile: join(pkgRoot, 'dist', 'constructs', 'kv_keys_handler_bundle.mjs'),
  },
];

await Promise.all(
  handlers.map((h) =>
    build({
      entryPoints: [h.entry],
      outfile: h.outfile,
      bundle: true,
      platform: 'node',
      // Match the Lambda runtime (DEFAULT_NODE_RUNTIME). Bump together.
      target: 'node24',
      format: 'esm',
      minify: true,
      // The AWS SDK v3 + signature-v4a are bundled (NOT in the Lambda runtime
      // baseline for cloudfront-keyvaluestore). `banner` shims `require` for
      // any CJS interop the SDK does under ESM output.
      banner: {
        js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
      },
    }),
  ),
);

// eslint-disable-next-line no-console
console.log(`✓ bundled ${handlers.length} hosting handler(s) for Lambda`);
