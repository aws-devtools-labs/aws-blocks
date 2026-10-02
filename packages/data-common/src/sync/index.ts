// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/data-common/sync — server side of `db.shape()`: shape
 * validation, signed tokens, and the endpoint path. Node only.
 */

export {
  SHAPE_INVALID,
  buildClaims,
  referencedTables,
  routeOf,
  deriveTokenKey,
  rejectionResponse,
  signClaims,
  toDescriptor,
  validateSyncOptions,
  verifyToken,
} from './claims.js';
export type { ShapeClaims, SyncTables, TokenRejection } from './claims.js';
export { TOKEN_PARAM, shapePath } from './constants.js';
export type { Shape, ShapeBell, ShapeDescriptor, ShapeOptions, SyncHint } from './types.js';
export { SYNC_HINT } from './types.js';
export { classifyWrite } from './writes.js';
export { MAX_SNAPSHOT_LIMIT, compileSnapshotQuery } from './subset.js';
export type { CompiledSnapshot } from './subset.js';
export { camelToSnake, columnToField, fieldToColumn, mapRow, snakeToCamel } from './mapping.js';
export type { ColumnMapping } from './mapping.js';
export type { FieldCondition, SnapshotFilter, SnapshotOrder, SnapshotQuery } from './types.js';
