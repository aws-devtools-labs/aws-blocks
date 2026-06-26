#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Assembles `packages/blocks/docs/` from every Building Block's root markdown.
 * Run at build/publish time (not customer-side). Produces:
 *   packages/blocks/docs/README.md        — dev guide + decision tree + catalog
 *   packages/blocks/docs/<pkg>/README.md  — per-block overview
 *   packages/blocks/docs/<pkg>/API.md     — per-block API reference (when present)
 *   packages/blocks/docs/<pkg>/DESIGN.md  — per-block design notes (when present)
 *   packages/blocks/docs/<pkg>/<other>.md — any other block-specific doc (when present)
 *
 * Inclusion rule: every package under packages/ that has a README.md and is not
 * in EXCLUDED. For each included package, mirror every root-level *.md EXCEPT the
 * ones in SKIP_MARKDOWN (CHANGELOG.md) — so block-specific docs are picked up
 * automatically without listing them here.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');
const outDir = join(packagesDir, 'blocks', 'docs');
const devGuidePath = join(packagesDir, 'blocks', 'README.md');

const EXCLUDED = new Set(['blocks', 'data-common', 'foundations', 'create-blocks-app']);

// Root-level markdown that should NOT be mirrored into the per-block doc folder.
const SKIP_MARKDOWN = new Set(['CHANGELOG.md']);

const DECISION_TREE = `# AWS Blocks — Building Block Catalog

Start from what you need:

- **Store data**
  - Simple key → value (caches, flags, user prefs) → \`KVStore\` ([bb-kv-store](./bb-kv-store/README.md))
  - Structured records with indexes and queries → \`DistributedTable\` ([bb-distributed-table](./bb-distributed-table/README.md)) — **default for most data**
  - Relational / SQL (joins, transactions) → see [Choosing a data block](#choosing-a-data-block) below
  - Files, blobs, uploads, static assets → \`FileBucket\` ([bb-file-bucket](./bb-file-bucket/README.md))
  - A single config value or secret → \`AppSetting\` ([bb-app-setting](./bb-app-setting/README.md))
- **Authenticate users**
  - Username/password, prototypes/MVPs → \`AuthBasic\` ([bb-auth-basic](./bb-auth-basic/README.md))
  - Cognito user pools, MFA, groups → \`AuthCognito\` ([bb-auth-cognito](./bb-auth-cognito/README.md))
  - External identity provider (OIDC) → \`AuthOIDC\` ([bb-auth-oidc](./bb-auth-oidc/README.md))
- **Run work outside the request/response**
  - Fire-and-forget background jobs → \`AsyncJob\` ([bb-async-job](./bb-async-job/README.md))
  - Scheduled / recurring tasks → \`CronJob\` ([bb-cron-job](./bb-cron-job/README.md))
- **Push live updates to browsers** (chat, presence, dashboards) → \`Realtime\` ([bb-realtime](./bb-realtime/README.md))
- **Build AI features**
  - Agent with tool use + conversation → \`Agent\` ([bb-agent](./bb-agent/README.md))
  - Semantic document retrieval (RAG) → \`KnowledgeBase\` ([bb-knowledge-base](./bb-knowledge-base/README.md))
- **Send transactional email** → \`EmailClient\` ([bb-email-client](./bb-email-client/README.md))
- **Observe and operate**
  - Structured logs → \`Logger\` ([bb-logger](./bb-logger/README.md))
  - Custom metrics → \`Metrics\` ([bb-metrics](./bb-metrics/README.md))
  - Distributed traces → \`Tracer\` ([bb-tracer](./bb-tracer/README.md))
  - Auto CloudWatch dashboard → \`Dashboard\` ([bb-dashboard](./bb-dashboard/README.md))

### Choosing a data block

Default to \`DistributedTable\` for your data models unless your domain specifically requires SQL engine capabilities.

Reach for one of the SQL blocks when you need to filter or join results across more than one related record, filter models on many dimensions with no preset hierarchy, store large objects, require transactions, or otherwise need the flexibility or familiarity of SQL that NoSQL does not offer.

If you need SQL, prefer \`DistributedDatabase\` for basic Postgres-compatible querying. Use \`Database\` specifically when you need a full (more expensive) Postgres implementation where the engine itself provides and enforces foreign keys, row level security, triggers, views, large transactions (more than 3,000 rows), or integration with an existing Postgres database. Note it carries an idle cost at minimum 0.5 ACU, or a cold start when scaling from zero, unlike the other two blocks.`;

// Clean and recreate
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Gather all @aws-blocks packages with READMEs
const packages = readdirSync(packagesDir).filter(
  (name) => !name.startsWith('.') && !EXCLUDED.has(name) && existsSync(join(packagesDir, name, 'README.md')),
);

const catalog = [];

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

  const readme = readFileSync(join(pkgDir, 'README.md'), 'utf-8');
  catalog.push({ pkg, blurb: extractBlurb(readme), keywords: extractKeywords(readme) });
}

catalog.sort((a, b) => a.pkg.localeCompare(b.pkg));

const devGuide = readFileSync(devGuidePath, 'utf-8');
writeFileSync(join(outDir, 'README.md'), renderReadme(devGuide, catalog));

console.log(`Synced ${catalog.length} block docs → packages/blocks/docs/`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function renderReadme(devGuide, catalog) {
  // docs/README.md is generated — the authored dev guide (packages/blocks/README.md)
  // followed by the catalog + decision tree. Edit those sources, not docs/README.md.
  return [devGuide.trimEnd(), '', '', renderCatalog(catalog), ''].join('\n');
}

function renderCatalog(catalog) {
  const rows = catalog.map(
    (e) => `| [${e.pkg}](./${e.pkg}/README.md) | ${e.blurb || '—'} | ${e.keywords || '—'} |`,
  );
  return [
    DECISION_TREE,
    '',
    '## Catalog',
    '',
    'One folder per Building Block under `docs/<block>/`: start with its `README.md`, then read `API.md` for exact signatures and `DESIGN.md` for architecture & rationale.',
    '',
    '| Block | What it does | Keywords |',
    '|-------|--------------|----------|',
    ...rows,
  ].join('\n');
}
