// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { blocksNodejsBundling } from './bundling.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const importMetaFixture = join(__dirname, '__fixtures__', 'import-meta-handler.js');
const requireCjs = createRequire(import.meta.url);

describe('blocksNodejsBundling', () => {
  test('injects the import.meta.* CJS shim for the default (CJS) output', () => {
    const out = blocksNodejsBundling({ minify: true, esbuildArgs: { '--conditions': 'aws-runtime' } });

    // Caller options are preserved.
    assert.equal(out.minify, true);
    assert.equal(out.esbuildArgs?.['--conditions'], 'aws-runtime');

    // All three import.meta path properties are substituted.
    assert.ok(out.esbuildArgs?.['--define:import.meta.url']);
    assert.ok(out.esbuildArgs?.['--define:import.meta.dirname']);
    assert.ok(out.esbuildArgs?.['--define:import.meta.filename']);

    // The banner defines the substituted identifiers via CommonJS primitives.
    assert.match(out.banner ?? '', /pathToFileURL\(__filename\)/);
    assert.match(out.banner ?? '', /__dirname/);
    assert.match(out.banner ?? '', /__filename/);
  });

  test('leaves ESM output untouched (import.meta works natively there)', () => {
    const input = { format: OutputFormat.ESM, esbuildArgs: { '--conditions': 'aws-runtime' } };
    const out = blocksNodejsBundling(input);

    assert.deepEqual(out, input);
    assert.equal(out.esbuildArgs?.['--define:import.meta.url'], undefined);
    assert.equal(out.banner, undefined);
  });

  test('prepends the shim while keeping a caller-supplied banner', () => {
    const out = blocksNodejsBundling({ banner: '// caller banner' });
    assert.match(out.banner ?? '', /pathToFileURL\(__filename\)/);
    assert.ok((out.banner ?? '').includes('// caller banner'));
  });

  test('a CJS bundle built with the shim resolves import.meta.url at load (no crash)', async () => {
    // Bundle the fixture exactly as NodejsFunction would: apply the helper's `banner`
    // and its `--define:import.meta.*` esbuildArgs. Without the shim this fixture's
    // top-level `fileURLToPath(import.meta.url)` becomes `fileURLToPath(undefined)`
    // and throws when the module is loaded.
    const opts = blocksNodejsBundling({ minify: true });
    const define: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.esbuildArgs ?? {})) {
      const m = key.match(/^--define:(.+)$/);
      if (m) define[m[1]] = String(value);
    }

    const tmp = mkdtempSync(join(tmpdir(), 'bb-shim-'));
    const outfile = join(tmp, 'out.cjs');
    try {
      await build({
        entryPoints: [importMetaFixture],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        minify: true,
        banner: { js: opts.banner ?? '' },
        define,
        outfile,
        logLevel: 'silent',
      });

      // Loading the bundle must not throw, and import.meta.url must resolve to a real
      // (file-URL-derived) path rather than being undefined.
      const mod = requireCjs(outfile);
      assert.equal(typeof mod.moduleDir, 'string');
      assert.ok(mod.moduleDir.length > 0, 'moduleDir should resolve to a non-empty path');
      assert.equal(typeof mod.handler, 'function');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
