// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/data-common/core
 *
 * Everything on the package root except `createKyselyAdapter()`. A block that
 * imports from this entry does not load Kysely.
 */

export { sql, unwrapQuery } from './sql.js';
export type { SqlQuery } from './sql.js';
export type { DatabaseEngine, TransactionHandle } from './engine.js';
export type { Transaction } from './types.js';
export { DatabaseBase } from './database-base.js';
export { splitStatements, runMigrations, loadMigrationsFromDir, DOLLAR_QUOTE_TAG_RE } from './migrations.js';
export {
  initializePgliteWithRetry,
  isPgliteUnreachableTrap,
  trackEager,
  logRecovery,
  PGLITE_DATA_LAYER_UNAVAILABLE_SENTINEL,
  PGLITE_DATA_LAYER_RECOVERED_SENTINEL,
} from './pglite-init.js';
export type { PgliteLike, PgliteInitRetryOptions } from './pglite-init.js';
