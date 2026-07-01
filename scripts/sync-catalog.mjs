#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the committed Building Block *catalog table* in packages/blocks/README.md
 * in sync with the per-block READMEs. This script ONLY manages the table between
 * the `<!-- BEGIN:block-catalog -->` / `<!-- END:block-catalog -->` markers — it
 * leaves the rest of the README (the static decision-tree prose, etc.) untouched
 * and does NOT generate the shipped `docs/` artifact. That artifact (per-block
 * docs/<pkg>/ folders + docs/README.md copy) is produced by
 * scripts/gen-block-docs.mjs, run as the packages/blocks `prebuild` hook.
 *
 * Two modes:
 *
 *   --write  (default; `npm run sync-docs`, run MANUALLY when adding/removing a block)
 *     Render the catalog table from the discovered blocks and inject it between
 *     the markers in packages/blocks/README.md. Nothing else in the README changes.
 *
 *   --check  (CI / PR gate; `npm run sync-docs:check`)
 *     Render the catalog table in memory and compare it to what is committed
 *     between the markers. Exit 1 with an actionable message if they differ or the
 *     markers are missing; exit 0 if in sync. Writes nothing.
 *
 * Inclusion rule: every package under packages/ that has a README.md and is not in
 * EXCLUDED. (The package-discovery logic is intentionally duplicated in
 * gen-block-docs.mjs — the two scripts are kept independent on purpose.)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');
const readmePath = join(packagesDir, 'blocks', 'README.md');

const EXCLUDED = new Set(['blocks', 'data-common', 'foundations', 'create-blocks-app']);

const BEGIN_MARKER = '<!-- BEGIN:block-catalog -->';
const END_MARKER = '<!-- END:block-catalog -->';

const SYNC_HINT = 'Run `npm run sync-docs` and commit the result.';

const mode = process.argv.includes('--check') ? 'check' : 'write';

const packages = getPackages();
const catalog = buildCatalog(packages);
const table = renderCatalogTable(catalog);

if (mode === 'check') {
  runCheck();
} else {
  runWrite();
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

function runWrite() {
  const readme = readFileSync(readmePath, 'utf-8');
  const updated = injectCatalog(readme, table);
  if (updated !== readme) writeFileSync(readmePath, updated);
  console.log(`Synced ${catalog.length} blocks → packages/blocks/README.md catalog`);
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
  entries.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
  return entries;
}

function renderCatalogTable(entries) {
  const rows = entries.map((e) => `| ${e.pkg} | ${e.blurb || '—'} | ${e.keywords || '—'} |`);
  return ['| Block | What it does | Keywords |', '|-------|--------------|----------|', ...rows].join('\n');
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
