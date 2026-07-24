#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the gitignored, shipped `docs/` artifact for @aws-blocks/blocks. Runs
 * as the packages/blocks `prebuild` hook so the published package always carries
 * fresh docs without dirtying any tracked file.
 *
 * It produces two things under packages/blocks/docs/:
 *   1. Per-block folders docs/<pkg>/ — mirror every root-level *.md of each
 *      included package EXCEPT the ones in SKIP_MARKDOWN (CHANGELOG.md), so
 *      block-specific docs (README.md, API.md, DESIGN.md, ...) ship automatically.
 *   2. docs/README.md — a verbatim copy of the committed packages/blocks/README.md.
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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');
const outDir = join(packagesDir, 'blocks', 'docs');
const readmePath = join(packagesDir, 'blocks', 'README.md');

const EXCLUDED = new Set(['blocks', 'data-common', 'foundations', 'create-blocks-app']);

// Root-level markdown that should NOT be mirrored into the per-block doc folder.
const SKIP_MARKDOWN = new Set(['CHANGELOG.md']);

const packages = getPackages();

generatePerBlockDocs();
writeFileSync(join(outDir, 'README.md'), readFileSync(readmePath, 'utf-8'));

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

    // Mirror every root-level markdown file (README.md, API.md, DESIGN.md, and any
    // block-specific docs) except the skipped ones, so new docs ship automatically.
    const mdFiles = readdirSync(pkgDir, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.md') && !SKIP_MARKDOWN.has(entry.name),
    );
    for (const entry of mdFiles) {
      writeFileSync(join(blockOutDir, entry.name), readFileSync(join(pkgDir, entry.name), 'utf-8'));
    }
  }
}

// ─── Package discovery (duplicated from sync-catalog.mjs) ──────────────────────

function getPackages() {
  return readdirSync(packagesDir).filter(
    (name) => !name.startsWith('.') && !EXCLUDED.has(name) && existsSync(join(packagesDir, name, 'README.md')),
  );
}
