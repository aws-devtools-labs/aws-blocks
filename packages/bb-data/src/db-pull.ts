// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `db pull` — introspects a Postgres database and generates Blocks files.
 *
 * Generates:
 *   - database.types.ts — TypeScript interfaces for all tables
 *   - database.meta.ts — runtime schema metadata for db.crud()
 *   - supabase.ts — Database BB + db.crud() wiring
 *   - MIGRATION_GUIDE.md — Supabase → Blocks pattern mapping
 *   - migrations/000_baseline.sql — schema baseline for fresh environments
 *
 * This file is the stable public entry point. The implementation is split into
 * focused modules under `./db-pull/`:
 *   - `types.ts`      — provider-agnostic schema/option types
 *   - `naming.ts`     — identifier casing + PG→TS mapping + singular resolution
 *   - `supabase.ts`   — all Supabase-specific knowledge (the only provider today)
 *   - `introspect.ts` — schema introspection
 *   - `templates.ts`  — fixed generated-file content (template literals)
 *   - `generate.ts`   — file generators + type/meta (re)generation helpers
 *   - `pull.ts`       — interactive/CLI orchestration
 *
 * @module
 */

export type { ColumnInfo, TableInfo, IntrospectionResult, DbPullOptions } from './db-pull/types.js';
export { introspect, isServerManagedDefault } from './db-pull/introspect.js';
export {
  generateTypesFile,
  generateMetaFile,
  generateIndexFile,
  generateCaFile,
  generateMigrationGuide,
  parseExistingMetaSingulars,
  selectEligibleTables,
  writeTypesAndMeta,
  regenerateTypesAndMeta,
} from './db-pull/generate.js';
export type { RegenerateTypesResult } from './db-pull/generate.js';
export { dbPull, dbPullInteractive, runDbPullCli } from './db-pull/pull.js';
