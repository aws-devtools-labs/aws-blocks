#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the Building Block catalog and the shipped `docs/` artifact in sync with
 * the per-block READMEs. Three modes:
 *
 *   --write  (default; `npm run sync-docs`, run MANUALLY when adding/removing a block)
 *     1. Regenerate ONLY the catalog table between the
 *        `<!-- BEGIN:block-catalog -->` / `<!-- END:block-catalog -->` markers in
 *        packages/blocks/README.md (everything else, incl. the static decision-tree
 *        prose, is preserved).
 *     2. Generate the per-block docs folders under packages/blocks/docs/<pkg>/
 *        (mirror every root *.md except CHANGELOG.md).
 *     3. Write packages/blocks/docs/README.md as a copy of the (now catalog-containing)
 *        packages/blocks/README.md.
 *
 *   --check  (CI / PR gate)
 *     Regenerate the catalog table in memory and compare it to what is committed
 *     between the markers in packages/blocks/README.md. Exit 1 with an actionable
 *     message if they differ or the markers are missing; exit 0 if in sync. Writes
 *     nothing.
 *
 *   --docs-only  (build/publish `prebuild` hook)
 *     Generate ONLY the gitignored docs/ artifact — per-block folders + docs/README.md
 *     (a verbatim copy of the committed packages/blocks/README.md). Never modifies the
 *     committed packages/blocks/README.md, so builds don't dirty a tracked file.
 *
 * Inclusion rule: every package under packages/ that has a README.md and is not in
 * EXCLUDED. For each included package, mirror every root-level *.md EXCEPT the ones in
 * SKIP_MARKDOWN (CHANGELOG.md) — so block-specific docs are picked up automatically.
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

const BEGIN_MARKER = '<!-- BEGIN:block-catalog -->';
const END_MARKER = '<!-- END:block-catalog -->';

const SYNC_HINT = 'Run `npm run sync-docs` and commit the result.';

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--docs-only')
    ? 'docs-only'
    : 'write';

const packages = getPackages();
const catalog = buildCatalog(packages);
const table = renderCatalogTable(catalog);

if (mode === 'check') {
  runCheck();
} else {
  runGenerate(mode);
}

// ─── Modes ───────────────────────────────────────────────────────────────────

function runCheck() {
  const readme = readFileSync(readmePath, 'utf-8');
  const current = extractBetweenMarkers(readme);

  if (current === null) {
    process.stderr.write(
      `❌ Building Block catalog markers (${BEGIN_MARKER} / ${END_MARKER}) not found in packages/blocks/README.md. ${SYNC_HINT}\n`,
    );
    process.exit(1);
  }

  if (current.trim() !== table.trim()) {
    process.stderr.write(
      `❌ Building Block catalog in packages/blocks/README.md is out of date. ${SYNC_HINT}\n`,
    );
    process.exit(1);
  }

  console.log('✅ Building Block catalog in packages/blocks/README.md is up to date.');
  process.exit(0);
}

function runGenerate(currentMode) {
  const readme = readFileSync(readmePath, 'utf-8');

  // --write injects the fresh catalog into the committed README; --docs-only must
  // never touch the committed README, so it copies it verbatim into docs/.
  let docsReadme = readme;
  if (currentMode === 'write') {
    const updated = injectCatalog(readme, table);
    if (updated !== readme) writeFileSync(readmePath, updated);
    docsReadme = updated;
  }

  generatePerBlockDocs();
  writeFileSync(join(outDir, 'README.md'), docsReadme);

  const where =
    currentMode === 'write'
      ? 'packages/blocks/README.md catalog + packages/blocks/docs/'
      : 'packages/blocks/docs/';
  console.log(`Synced ${catalog.length} block docs → ${where}`);
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

function getPackages() {
  return readdirSync(packagesDir).filter(
    (name) => !name.startsWith('.') && !EXCLUDED.has(name) && existsSync(join(packagesDir, name, 'README.md')),
  );
}

function buildCatalog(pkgs) {
  const entries = pkgs.map((pkg) => {
    const readme = readFileSync(join(packagesDir, pkg, 'README.md'), 'utf-8');
    return { pkg, blurb: extractBlurb(readme), keywords: extractKeywords(readme) };
  });
  entries.sort((a, b) => a.pkg.localeCompare(b.pkg));
  return entries;
}

function renderCatalogTable(entries) {
  const rows = entries.map(
    (e) => `| [${e.pkg}](./docs/${e.pkg}/README.md) | ${e.blurb || '—'} | ${e.keywords || '—'} |`,
  );
  return ['| Block | What it does | Keywords |', '|-------|--------------|----------|', ...rows].join('\n');
}

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

// ─── Marker helpers ──────────────────────────────────────────────────────────

function injectCatalog(readme, catalogTable) {
  const begin = readme.indexOf(BEGIN_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Building Block catalog markers (${BEGIN_MARKER} / ${END_MARKER}) not found in packages/blocks/README.md. ` +
        'Add them where the catalog table should live, then re-run.',
    );
  }
  const before = readme.slice(0, begin + BEGIN_MARKER.length);
  const after = readme.slice(end);
  return `${before}\n${catalogTable}\n${after}`;
}

function extractBetweenMarkers(readme) {
  const begin = readme.indexOf(BEGIN_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end < begin) return null;
  return readme.slice(begin + BEGIN_MARKER.length, end);
}

// ─── README parsing ──────────────────────────────────────────────────────────

function extractBlurb(content) {
  const lines = content.split('\n');
  const h1 = lines.findIndex((l) => l.startsWith('# '));
  if (h1 === -1) return '';
  for (let i = h1 + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('<!--')) break;
    const firstSentence = line.match(/^.*?\.(?:\s|$)/);
    return (firstSentence ? firstSentence[0] : line).trim();
  }
  return '';
}

function extractKeywords(content) {
  const match = content.match(/\*\*Keywords?:\*\*\s*(.+)/i);
  return match ? match[1].trim() : '';
}
