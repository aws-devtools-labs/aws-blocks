#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the gitignored, shipped `docs/` artifact for @aws-blocks/blocks. Runs
 * as the packages/blocks `prebuild` hook so the published package always carries
 * fresh docs without dirtying any tracked file.
 *
 * It produces three things under packages/blocks/docs/:
 *   1. Per-block folders docs/<pkg>/ — mirror every root-level *.md of each
 *      included package, so block-specific docs (README.md, API.md, DESIGN.md,
 *      CHANGELOG.md, ...) ship automatically.
 *   2. docs/<pkg>/docs/ — if an included package has its own `docs/` folder
 *      (code samples, mock data, any extension), its entire contents are
 *      mirrored there verbatim, namespaced under the package so it can never
 *      collide with the root *.md copied into docs/<pkg>/.
 *   3. docs/ root — verbatim copies of every root-level *.md of the umbrella
 *      packages/blocks package (README.md, API.md, TROUBLESHOOTING.md,
 *      CHANGELOG.md). `blocks` stays in EXCLUDED so these land at the docs/ root
 *      only, with no redundant docs/blocks/ subfolder.
 *
 * This script NEVER modifies packages/blocks/README.md. The committed catalog
 * table inside that README is managed separately by scripts/sync-catalog.mjs
 * (`npm run sync-docs`); run that and commit before building if you added or
 * removed a block.
 *
 * No flag is required — the default run generates docs/. `--docs-only` is accepted
 * as a harmless alias for the same behavior.
 *
 * Inclusion rule: every package under packages/ that has a README.md and is not in
 * EXCLUDED. (The package-discovery logic is intentionally duplicated from
 * sync-catalog.mjs — the two scripts are kept independent on purpose.)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');
const blocksDir = join(packagesDir, 'blocks');
const outDir = join(blocksDir, 'docs');

const EXCLUDED = new Set(['blocks', 'data-common', 'foundations', 'create-blocks-app']);

const packages = getPackages();

generatePerBlockDocs();
copyMarkdown(blocksDir, outDir);

console.log(`Generated ${packages.length} block docs → packages/blocks/docs/`);

// ─── docs/ artifact ──────────────────────────────────────────────────────────

function generatePerBlockDocs() {
  // Clean and recreate so removed blocks/files don't linger.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const pkg of packages) {
    const pkgDir = join(packagesDir, pkg);
    const blockOutDir = join(outDir, pkg);
    mkdirSync(blockOutDir, { recursive: true });

    copyMarkdown(pkgDir, blockOutDir);

    const pkgDocsDir = join(pkgDir, 'docs');
    if (existsSync(pkgDocsDir) && statSync(pkgDocsDir).isDirectory()) {
      const resolvedPkgDocsDir = resolve(pkgDocsDir);
      const resolvedOutDir = resolve(outDir);
      const isSelfReferential =
        resolvedPkgDocsDir === resolvedOutDir || resolvedPkgDocsDir.startsWith(resolvedOutDir + sep);
      if (!isSelfReferential) {
        cpSync(pkgDocsDir, join(blockOutDir, 'docs'), { recursive: true });
      }
    }
  }
}

/** Mirrors every root-level *.md file of `srcDir` into `destDir` verbatim. */
function copyMarkdown(srcDir, destDir) {
  const mdFiles = readdirSync(srcDir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.md'),
  );
  for (const entry of mdFiles) {
    writeFileSync(join(destDir, entry.name), readFileSync(join(srcDir, entry.name), 'utf-8'));
  }
}

// ─── Package discovery (duplicated from sync-catalog.mjs) ──────────────────────

function getPackages() {
  return readdirSync(packagesDir).filter(
    (name) => !name.startsWith('.') && !EXCLUDED.has(name) && existsSync(join(packagesDir, name, 'README.md')),
  );
}
