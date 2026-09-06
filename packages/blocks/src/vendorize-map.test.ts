// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validates the aws-blocks.vendorize map in @aws-blocks/blocks/package.json:
 * 1. Every listed package resolves and exports the declared symbols
 * 2. Every vendorizable BB dependency is present in the map
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const blocksPkgPath = join(__dirname, '..', 'package.json');
const blocksPkg = JSON.parse(readFileSync(blocksPkgPath, 'utf-8'));
const vendorizeMap: Record<string, string[]> = blocksPkg['aws-blocks']?.vendorize ?? {};

describe('aws-blocks.vendorize map', () => {

  test('map is not empty', () => {
    assert.ok(Object.keys(vendorizeMap).length > 0, 'vendorize map should have entries');
  });

  for (const [packageName, symbols] of Object.entries(vendorizeMap)) {
    test(`${packageName} resolves and exports ${symbols.join(', ')}`, async () => {
      // Resolve the package entry point
      let resolved: string;
      try {
        resolved = require.resolve(packageName);
      } catch {
        assert.fail(`Cannot resolve package "${packageName}"`);
      }
      const mod = await import(pathToFileURL(resolved).href);
      for (const sym of symbols) {
        assert.ok(sym in mod, `${packageName} should export "${sym}" but exports: ${Object.keys(mod).join(', ')}`);
      }
    });
  }

  test('every vendorizable BB dependency is in the map', () => {
    const deps = Object.keys(blocksPkg.dependencies ?? {});
    const missing: string[] = [];

    for (const dep of deps) {
      // Skip infrastructure packages (not user-facing BBs). bb-lambda-compute
      // is the internal default compute — CDK-only and not customer-instantiable
      // — so it has no public symbol to vendorize. `hosting` is the CDK hosting
      // library whose value API is re-exported through core/blocks — infra, not a BB.
      if (
        dep.endsWith('/core') ||
        dep.endsWith('/auth-common') ||
        dep.endsWith('/bb-lambda-compute') ||
        dep.endsWith('/hosting')
      )
        continue;

      // Find the package directory by resolving its main entry and walking up
      let pkgDir: string | null = null;
      try {
        const resolved = require.resolve(dep);
        let dir = dirname(resolved);
        while (dir !== dirname(dir)) {
          if (existsSync(join(dir, 'package.json'))) {
            const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
            if (pkg.name === dep) { pkgDir = dir; break; }
          }
          dir = dirname(dir);
        }
      } catch {
        continue;
      }

      if (!pkgDir || !existsSync(join(pkgDir, 'src'))) continue;

      if (!(dep in vendorizeMap)) {
        missing.push(dep);
      }
    }

    assert.deepStrictEqual(missing, [], `These vendorizable BB deps are missing from aws-blocks.vendorize map: ${missing.join(', ')}`);
  });
});
