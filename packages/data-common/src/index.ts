// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/data-common
 *
 * Shared abstractions for SQL database Building Blocks.
 */

export { sql, unwrapQuery } from './sql.js';
export type { SqlQuery } from './sql.js';
export type { DatabaseEngine, TransactionHandle } from './engine.js';
export type { Transaction } from './types.js';
export { DatabaseBase } from './database-base.js';
export { splitStatements, runMigrations, loadMigrationsFromDir, DOLLAR_QUOTE_TAG_RE } from './migrations.js';
export { createKyselyAdapter } from './kysely-adapter.js';
export { initializePgliteWithRetry, isPgliteUnreachableTrap } from './pglite-init.js';
export type { PgliteLike, PgliteInitRetryOptions } from './pglite-init.js';
