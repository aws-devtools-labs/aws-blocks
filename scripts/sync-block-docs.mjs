#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Assembles `packages/blocks/docs/` from all Building Block READMEs.
 * Run at build/publish time (not customer-side). Produces:
 *   packages/blocks/docs/index.md   — decision tree + catalog
 *   packages/blocks/docs/<pkg>.md   — one per block
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(__dirname, '..', 'packages');
const outDir = join(packagesDir, 'blocks', 'docs');

const EXCLUDED = new Set(['blocks', 'data-common', 'otel-common', 'foundations', 'create-blocks-app']);

const DECISION_TREE = `# AWS Blocks — Building Block Catalog

Start from what you need:

- **Store data**
  - Simple key → value (caches, flags, user prefs) → \`KVStore\` ([bb-kv-store](./bb-kv-store.md))
  - Structured records with indexes and queries → \`DistributedTable\` ([bb-distributed-table](./bb-distributed-table.md)) — **default for most data**
  - Relational / SQL (joins, transactions) → see [Choosing a data block](#choosing-a-data-block) below
  - Files, blobs, uploads, static assets → \`FileBucket\` ([bb-file-bucket](./bb-file-bucket.md))
  - A single config value or secret → \`AppSetting\` ([bb-app-setting](./bb-app-setting.md))
- **Authenticate users**
  - Username/password, prototypes/MVPs → \`AuthBasic\` ([bb-auth-basic](./bb-auth-basic.md))
  - Cognito user pools, MFA, groups → \`AuthCognito\` ([bb-auth-cognito](./bb-auth-cognito.md))
  - External identity provider (OIDC) → \`AuthOIDC\` ([bb-auth-oidc](./bb-auth-oidc.md))
- **Run work outside the request/response**
  - Fire-and-forget background jobs → \`AsyncJob\` ([bb-async-job](./bb-async-job.md))
  - Scheduled / recurring tasks → \`CronJob\` ([bb-cron-job](./bb-cron-job.md))
- **Push live updates to browsers** (chat, presence, dashboards) → \`Realtime\` ([bb-realtime](./bb-realtime.md))
- **Build AI features**
  - Agent with tool use + conversation → \`Agent\` ([bb-agent](./bb-agent.md))
  - Semantic document retrieval (RAG) → \`KnowledgeBase\` ([bb-knowledge-base](./bb-knowledge-base.md))
- **Send transactional email** → \`EmailClient\` ([bb-email-client](./bb-email-client.md))
- **Observe and operate** (OpenTelemetry blocks are **recommended** — vendor-neutral, with OTLP export to CloudWatch or any backend)
  - Custom metrics → \`OtelMetrics\` ([bb-otel-metrics](./bb-otel-metrics.md))
  - Structured logs → \`OtelLogger\` ([bb-otel-logger](./bb-otel-logger.md))
  - Distributed traces → \`OtelTracer\` ([bb-otel-tracer](./bb-otel-tracer.md))
  - Auto CloudWatch dashboard → \`Dashboard\` ([bb-dashboard](./bb-dashboard.md)) — works with both families
  - Prefer AWS-native (CloudWatch EMF / X-Ray SDK) instead? → \`Metrics\` ([bb-metrics](./bb-metrics.md)) / \`Logger\` ([bb-logger](./bb-logger.md)) / \`Tracer\` ([bb-tracer](./bb-tracer.md))

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
  const content = readFileSync(join(packagesDir, pkg, 'README.md'), 'utf-8');
  writeFileSync(join(outDir, `${pkg}.md`), content);
  catalog.push({ pkg, blurb: extractBlurb(content), keywords: extractKeywords(content) });
}

catalog.sort((a, b) => a.pkg.localeCompare(b.pkg));
writeFileSync(join(outDir, 'index.md'), renderIndex(catalog));

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

function renderIndex(catalog) {
  const rows = catalog.map(
    (e) => `| [${e.pkg}](./${e.pkg}.md) | ${e.blurb || '—'} | ${e.keywords || '—'} |`,
  );
  return [
    DECISION_TREE,
    '',
    '## Catalog',
    '',
    'One page per Building Block. Read the linked doc before using a block.',
    '',
    '| Block | What it does | Keywords |',
    '|-------|--------------|----------|',
    ...rows,
    '',
  ].join('\n');
}
