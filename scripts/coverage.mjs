#!/usr/bin/env node
/**
 * Code-coverage runner using Node's built-in test coverage.
 *
 * Runs each package's own test script with --experimental-test-coverage
 * injected, executed in the package directory. This preserves per-package cwd
 * (needed by packages like core whose tests use process.cwd()).
 *
 * Coverage is REPORTING-ONLY — numbers never fail the build. Test failures
 * DO fail the build (exit non-zero).
 *
 * Improvements over a naive single-run approach:
 * - --test-coverage-include scopes coverage to the package's own source
 * - --test-coverage-exclude removes test files from coverage stats
 */
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');

const COVERAGE_FLAGS = [
  '--experimental-test-coverage',
  "--test-coverage-include='dist/**/*.js'",
  "--test-coverage-exclude='dist/**/*.test.js'",
].join(' ');

const pkgDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let ran = 0;
let failed = 0;

for (const name of pkgDirs) {
  const cwd = join(packagesDir, name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    continue;
  }

  const testScript = pkg.scripts?.test ?? '';
  if (!testScript.startsWith('node --test')) {
    continue;
  }

  const covScript = testScript.replace(
    /^node --test/,
    `node --test ${COVERAGE_FLAGS}`,
  );

  console.log(`\n=== Coverage: ${pkg.name ?? name} ===`);
  const result = spawnSync(covScript, {
    cwd,
    stdio: 'inherit',
    shell: true,
  });
  ran += 1;
  if (result.status !== 0) {
    failed += 1;
    console.log(`(${pkg.name ?? name}: unit tests FAILED)`);
  }
}

console.log(
  `\nCoverage complete: ${ran} package(s)` +
    (failed ? `, ${failed} FAILED` : ', all passed'),
);

process.exit(failed > 0 ? 1 : 0);
